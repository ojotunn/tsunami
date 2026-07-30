// A taxa vista pelo site: o que /api/config publica, e o reaceite dos termos.
//
// As env vars são setadas ANTES do import do servidor de propósito — a config
// da taxa é lida uma vez, no carregamento do módulo. Cada arquivo de teste roda
// em processo próprio, então isto não vaza para os outros.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const DB = './data/test-fee-web.sqlite';
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
process.env.PONS_DB = DB;
process.env.PONS_KEYSTORE_DIR = './data/test-keystores';
process.env.PONS_FEE_ADDRESS = '0x00000000000000000000000000000000feeabc01';
process.env.PONS_FEE_BPS = '500';
process.env.PONS_ALLOW_LIVE_EXECUTION = '1';

const { start } = await import('../src/web/server.js');
const { createAccount } = await import('../src/wallet/account.js');
const { signPersonalMessage } = await import('../src/core/secp256k1.js');
const { openDb } = await import('../src/indexer/db.js');

let server, base;

before(async () => {
  server = start({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const call = async (method, path, { body, cookie } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json(), setCookie: res.headers.get('set-cookie') };
};

async function login(account) {
  const nonce = await call('POST', '/api/auth/nonce', { body: { address: account.address } });
  const signature = signPersonalMessage(nonce.body.message, account.privateKey);
  const verified = await call('POST', '/api/auth/verify', {
    body: { address: account.address, nonce: nonce.body.nonce, signature },
  });
  assert.equal(verified.status, 200, `login falhou: ${verified.body.error}`);
  return verified.setCookie.split(';')[0];
}

/** Rebaixa a conta para o aceite antigo, que não tinha versão nenhuma. */
function esquecerAceite(address) {
  const db = openDb(DB);
  // O endereço é gravado com checksum; comparar sem case evita depender disso.
  db.prepare('UPDATE users SET terms_version = NULL WHERE lower(address) = lower(?)').run(address);
  db.close();
}

// ------------------------------------------------------------- config

test('config publica a taxa para o front poder mostrá-la', async () => {
  const { body } = await call('GET', '/api/config');
  assert.deepEqual(body.serviceFee, {
    bps: 500, address: '0x00000000000000000000000000000000feeabc01',
  });
});

test('config não vaza o diagnóstico do operador', async () => {
  const { body } = await call('GET', '/api/config');
  assert.equal(body.serviceFee.problem, undefined, 'problem é para o admin, não para o público');
});

// ------------------------------------------------------------- termos

test('a página de termos passa a declarar a taxa', async () => {
  const html = await (await fetch(base + '/terms')).text();
  assert.match(html, /Service fee/, 'cobrar sem declarar é o que não pode acontecer');
  assert.match(html, /5%/);
  assert.match(html, /Withdrawing your funds is free/);
  assert.ok(!html.includes('{{FEE_NOTICE}}'), 'o token não pode vazar cru para a página');
});

// A landing é página de apresentação e não declara mais a taxa — decisão do
// operador. A divulgação continua obrigatória nos lugares onde a pessoa decide
// gastar: os termos que ela aceita, o banner do painel e a linha de cada
// decisão. Este teste guarda o que sobrou, para a remoção não avançar sozinha
// para o ponto em que viraria cobrança sem aviso.
test('a landing não anuncia a taxa, mas nao deixa placeholder cru', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.ok(!html.includes('{{FEE_NOTICE_BLOCK}}'));
  assert.ok(!html.includes('{{'), 'nenhum token pode vazar para a pagina');
});

test('a divulgação obrigatória continua de pé fora da landing', async () => {
  const termos = await (await fetch(base + '/terms')).text();
  assert.match(termos, /Service fee/, 'os termos precisam declarar a cobranca');
  assert.match(termos, /5%/);

  const { body } = await call('GET', '/api/config');
  assert.equal(body.serviceFee.bps, 500, 'o painel monta o banner a partir daqui');
});

test('aceite novo já entra na versão atual dos termos', async () => {
  const cookie = await login(createAccount());
  assert.equal((await call('GET', '/api/auth/me', { cookie })).body.termsAccepted, false);
  await call('POST', '/api/terms/accept', { cookie });
  assert.equal((await call('GET', '/api/auth/me', { cookie })).body.termsAccepted, true);
});

// Quem aceitou os termos antigos não pode ser cobrado sem ser perguntado de
// novo. Como o aceite antigo não tinha versão, a linha fica com terms_version
// nulo — e nulo tem que contar como "não aceitou esta versão".
test('aceite da versão anterior não vale para a versão nova', async () => {
  const account = createAccount();
  const cookie = await login(account);
  await call('POST', '/api/terms/accept', { cookie });

  esquecerAceite(account.address);

  assert.equal((await call('GET', '/api/auth/me', { cookie })).body.termsAccepted, false);
});

test('sem reaceitar, o caminho ao vivo é recusado com frase legível', async () => {
  const account = createAccount();
  const cookie = await login(account);
  await call('POST', '/api/terms/accept', { cookie });

  const agent = await call('POST', '/api/agents', {
    cookie, body: { label: 'fee', password: 'senha-de-teste-123', token: '0x' + '11'.repeat(20) },
  });
  assert.equal(agent.status, 200, agent.body.error);

  const db = openDb(DB);
  db.prepare("INSERT INTO decisions (agent_id, ts, token, kind, rationale, payload, risk, status) VALUES (?,?,?,?,?,?,?,'approved')")
    .run(agent.body.id, Math.floor(Date.now() / 1000), '0x' + '11'.repeat(20), 'buyback_burn', 'teste',
      JSON.stringify({ kind: 'buyback_burn', token: '0x' + '11'.repeat(20), steps: [] }), '{}');
  const decisionId = db.prepare('SELECT MAX(id) id FROM decisions').get().id;
  db.close();

  esquecerAceite(account.address);

  const aoVivo = await call('POST', `/api/decisions/${decisionId}/execute`, {
    cookie, body: { password: 'senha-de-teste-123', live: true },
  });
  assert.match(aoVivo.body.error, /terms of use changed/);

  // Simular continua livre: o gate é sobre enviar dinheiro, não sobre olhar.
  const ensaio = await call('POST', `/api/decisions/${decisionId}/execute`, {
    cookie, body: { password: 'senha-de-teste-123', live: false },
  });
  assert.ok(!/terms of use changed/.test(ensaio.body.error ?? ''), 'o ensaio não pode ser bloqueado');
});

test('saque e export de keystore não dependem do aceite', async () => {
  const account = createAccount();
  const cookie = await login(account);
  await call('POST', '/api/terms/accept', { cookie });
  const agent = await call('POST', '/api/agents', {
    cookie, body: { label: 'saque', password: 'senha-de-teste-123', token: '0x' + '11'.repeat(20) },
  });

  esquecerAceite(account.address);

  const keystore = await call('GET', `/api/agents/${agent.body.id}/keystore`, { cookie });
  assert.equal(keystore.status, 200, 'ninguém pode ficar preso do lado de fora do próprio dinheiro');

  const saque = await call('POST', `/api/agents/${agent.body.id}/withdraw`, {
    cookie, body: { to: '0x' + '77'.repeat(20), password: 'senha-de-teste-123', live: false },
  });
  assert.ok(!/terms of use changed/.test(saque.body.error ?? ''), 'o saque não pode ser bloqueado pelo aceite');
});
