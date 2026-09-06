// Política de risco editável pelo dono do agente, pela tela.
//
// Existe porque o teto padrão de 0,01 ETH por operação bloqueou uma compra
// real ("notional … exceeds the per-trade limit") e não havia onde mudar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const DB = './data/test-policy-web.sqlite';
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
process.env.PONS_DB = DB;
process.env.PONS_KEYSTORE_DIR = './data/test-keystores-policy';

const { start } = await import('../src/web/server.js');
const { createAccount } = await import('../src/wallet/account.js');
const { signPersonalMessage } = await import('../src/core/secp256k1.js');

let server, base;
before(async () => {
  server = start({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const call = async (method, path, { body, cookie } = {}) => {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json(), setCookie: res.headers.get('set-cookie') };
};

async function login(account) {
  const nonce = await call('POST', '/api/auth/nonce', { body: { address: account.address } });
  const verified = await call('POST', '/api/auth/verify', {
    body: { address: account.address, nonce: nonce.body.nonce, signature: signPersonalMessage(nonce.body.message, account.privateKey) },
  });
  const cookie = verified.setCookie.split(';')[0];
  await call('POST', '/api/terms/accept', { cookie });
  return { cookie, address: verified.body.address };
}

async function agentFor(session) {
  const r = await call('POST', '/api/agents', { cookie: session.cookie, body: { label: 'a', password: 'senha-de-teste-1' } });
  return r.body;
}

test('o agente novo nasce com a política padrão visível na leitura', async () => {
  const dono = await login(createAccount());
  const a = await agentFor(dono);
  const r = await call('GET', `/api/agents/${a.id}`, { cookie: dono.cookie });
  assert.equal(r.body.policy.maxNotionalPerTradeWei, '10000000000000000');
  assert.equal(r.body.policy.mode, 'propose');
});

test('o dono sobe o teto por operação em ETH e ele é guardado em wei', async () => {
  const dono = await login(createAccount());
  const a = await agentFor(dono);
  const r = await call('PATCH', `/api/agents/${a.id}/policy`, {
    cookie: dono.cookie, body: { maxPerTradeEth: '0.05', maxDailyEth: '0.5', mode: 'auto', approveAboveEth: '0.02', maxTradesPerHour: '12' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.policy.maxNotionalPerTradeWei, '50000000000000000');
  assert.equal(r.body.policy.maxDailyNotionalWei, '500000000000000000');
  assert.equal(r.body.policy.requireApprovalAboveWei, '20000000000000000');
  assert.equal(r.body.policy.mode, 'auto');
  assert.equal(r.body.policy.maxTradesPerHour, 12);
  // o que não foi enviado fica como estava
  assert.equal(r.body.policy.reserveGasWei, '2000000000000000');
  const again = await call('GET', `/api/agents/${a.id}`, { cookie: dono.cookie });
  assert.equal(again.body.policy.maxNotionalPerTradeWei, '50000000000000000');
});

test('teto por operação acima do diário é recusado com frase em ETH, não em wei', async () => {
  const dono = await login(createAccount());
  const a = await agentFor(dono);
  const r = await call('PATCH', `/api/agents/${a.id}/policy`, { cookie: dono.cookie, body: { maxPerTradeEth: '1', maxDailyEth: '0.5' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /per-trade limit cannot be higher than the daily limit/);
});

test('valor que não é ETH e modo inválido são recusados', async () => {
  const dono = await login(createAccount());
  const a = await agentFor(dono);
  const bad = await call('PATCH', `/api/agents/${a.id}/policy`, { cookie: dono.cookie, body: { maxPerTradeEth: 'muito' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /positive amount of ETH/);
  const mode = await call('PATCH', `/api/agents/${a.id}/policy`, { cookie: dono.cookie, body: { mode: 'yolo' } });
  assert.equal(mode.status, 400);
  assert.match(mode.body.error, /mode must be/);
});

test('outra conta não edita a política de um agente que não é dela', async () => {
  const dono = await login(createAccount());
  const intruso = await login(createAccount());
  const a = await agentFor(dono);
  const r = await call('PATCH', `/api/agents/${a.id}/policy`, { cookie: intruso.cookie, body: { maxPerTradeEth: '9' } });
  assert.ok(r.status === 403 || r.status === 404, `esperava recusa, veio ${r.status}`);
  const check = await call('GET', `/api/agents/${a.id}`, { cookie: dono.cookie });
  assert.equal(check.body.policy.maxNotionalPerTradeWei, '10000000000000000');
});
