// Testes do site: login por assinatura, sessão e isolamento entre contas.
// Sobe o servidor de verdade numa porta efêmera e fala com ele por HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';

const DB = './data/test-web.sqlite';
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });
process.env.PONS_DB = DB;
process.env.PONS_KEYSTORE_DIR = './data/test-keystores';

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
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json(), setCookie: res.headers.get('set-cookie') };
};

/** Faz o login completo de uma conta nova e devolve o cookie de sessão. */
async function login(account, accept = true) {
  const nonce = await call('POST', '/api/auth/nonce', { body: { address: account.address } });
  const signature = signPersonalMessage(nonce.body.message, account.privateKey);
  const verified = await call('POST', '/api/auth/verify', {
    body: { address: account.address, nonce: nonce.body.nonce, signature },
  });
  assert.equal(verified.status, 200, `login falhou: ${verified.body.error}`);
  const cookie = verified.setCookie.split(';')[0];
  // Criar agente exige aceite dos termos; os testes que não são sobre isso já
  // entram aceitos, senão todo teste anterior teria que repetir esse passo.
  if (accept) await call('POST', '/api/terms/accept', { cookie });
  return { cookie, address: verified.body.address, nonce: nonce.body.nonce, signature };
}

// ---------------------------------------------------------------- páginas

test('landing e app são servidas', async () => {
  for (const path of ['/', '/app']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.ok((await res.text()).length > 3000, `${path} veio vazia demais`);
  }
});

test('config pública lista as funções sem exigir login', async () => {
  const { status, body } = await call('GET', '/api/config');
  assert.equal(status, 200);
  assert.equal(body.chain.id, 4663);
  assert.equal(body.functions.length, 6);
});

// A carteira do usuário não conhece a Robinhood Chain por padrão. A página
// adiciona a rede sozinha via wallet_addEthereumChain, e esse pedido precisa de
// chainId em hexa, nome, moeda nativa e RPC. Se qualquer um sumir do /api/config,
// a MetaMask abre na rede errada na hora de assinar — foi o que aconteceu num
// teste real. Este teste existe para isso não voltar em silêncio.
test('config traz o que a carteira precisa para adicionar a rede', async () => {
  const { body } = await call('GET', '/api/config');
  assert.equal(body.chain.idHex, '0x1237');
  assert.equal(parseInt(body.chain.idHex, 16), body.chain.id);
  assert.ok(body.chain.name, 'falta o nome da rede');
  assert.match(body.chain.rpc, /^https:\/\//);
  assert.equal(body.chain.nativeCurrency.decimals, 18);
  assert.ok(body.chain.nativeCurrency.symbol, 'falta o símbolo da moeda nativa');
});

// Teste estático do front: garante que nenhuma transação sai antes da troca de
// rede. O front não tem runtime de teste, mas esta ordem é justamente o que
// falhou na prática, então vale travar por texto.
test('a página só envia transação depois de garantir a rede', async () => {
  const html = readFileSync(new URL('../src/web/pages/app.html', import.meta.url), 'utf8');
  const i = html.indexOf('window.sendTx');
  assert.ok(i > 0, 'sendTx sumiu da página');
  const send = html.indexOf('eth_sendTransaction', i);
  assert.ok(send > i, 'eth_sendTransaction sumiu do sendTx');
  const guard = html.slice(i, send);
  assert.match(guard, /ensureChain\(/, 'sendTx envia sem garantir a rede antes');
  assert.match(html, /wallet_addEthereumChain/, 'a página não sabe adicionar a rede na carteira');
});

// ---------------------------------------------------------------- login

test('rota privada sem sessão é recusada', async () => {
  const { status, body } = await call('GET', '/api/agents');
  assert.equal(status, 401);
  assert.match(body.error, /connect your wallet/);
});

test('login por assinatura de carteira funciona', async () => {
  const acc = createAccount();
  const session = await login(acc);
  assert.equal(session.address, acc.address);
  const me = await call('GET', '/api/auth/me', { cookie: session.cookie });
  assert.equal(me.body.address, acc.address);
});

test('cookie de sessão é httpOnly e SameSite=Strict', async () => {
  const acc = createAccount();
  const nonce = await call('POST', '/api/auth/nonce', { body: { address: acc.address } });
  const verified = await call('POST', '/api/auth/verify', {
    body: {
      address: acc.address, nonce: nonce.body.nonce,
      signature: signPersonalMessage(nonce.body.message, acc.privateKey),
    },
  });
  assert.match(verified.setCookie, /HttpOnly/);
  assert.match(verified.setCookie, /SameSite=Strict/);
});

test('assinatura de outra mensagem não autentica', async () => {
  const acc = createAccount();
  const nonce = await call('POST', '/api/auth/nonce', { body: { address: acc.address } });
  const { status, body } = await call('POST', '/api/auth/verify', {
    body: {
      address: acc.address, nonce: nonce.body.nonce,
      signature: signPersonalMessage('mensagem diferente', acc.privateKey),
    },
  });
  assert.equal(status, 400);
  assert.match(body.error, /does not match/);
});

test('assinatura de outra carteira não autentica', async () => {
  const dono = createAccount();
  const intruso = createAccount();
  const nonce = await call('POST', '/api/auth/nonce', { body: { address: dono.address } });
  const { status } = await call('POST', '/api/auth/verify', {
    body: {
      address: dono.address, nonce: nonce.body.nonce,
      signature: signPersonalMessage(nonce.body.message, intruso.privateKey),
    },
  });
  assert.equal(status, 400);
});

test('nonce é de uso único — replay é bloqueado', async () => {
  const acc = createAccount();
  const s = await login(acc);
  const replay = await call('POST', '/api/auth/verify', {
    body: { address: acc.address, nonce: s.nonce, signature: s.signature },
  });
  assert.equal(replay.status, 400);
  assert.match(replay.body.error, /already used/);
});

test('nonce desconhecido é recusado', async () => {
  const acc = createAccount();
  const { status, body } = await call('POST', '/api/auth/verify', {
    body: { address: acc.address, nonce: 'inventado', signature: signPersonalMessage('x', acc.privateKey) },
  });
  assert.equal(status, 400);
  assert.match(body.error, /unknown nonce/);
});

test('logout invalida a sessão', async () => {
  const acc = createAccount();
  const s = await login(acc);
  await call('POST', '/api/auth/logout', { cookie: s.cookie });
  const after = await call('GET', '/api/agents', { cookie: s.cookie });
  assert.equal(after.status, 401);
});

test('cookie forjado não vale', async () => {
  const { status } = await call('GET', '/api/agents', { cookie: 'pons_session=token-inventado' });
  assert.equal(status, 401);
});

// ---------------------------------------------------------------- isolamento

test('cada conta só enxerga e opera os próprios agentes', async () => {
  const dono = await login(createAccount());
  const outro = await login(createAccount());

  const criado = await call('POST', '/api/agents', {
    cookie: dono.cookie,
    body: { label: 'meu agente', password: 'senha-de-teste-1', token: '0x' + 'aa'.repeat(20) },
  });
  assert.equal(criado.status, 200);
  assert.equal(criado.body.owner, dono.address);

  const listaDono = await call('GET', '/api/agents', { cookie: dono.cookie });
  assert.equal(listaDono.body.length, 1);

  const listaOutro = await call('GET', '/api/agents', { cookie: outro.cookie });
  assert.equal(listaOutro.body.length, 0, 'a lista não pode vazar agentes de outra conta');

  const leitura = await call('GET', `/api/agents/${criado.body.id}`, { cookie: outro.cookie });
  assert.equal(leitura.status, 403);
  assert.match(leitura.body.error, /another account/);

  const escrita = await call('POST', `/api/agents/${criado.body.id}/functions`, {
    cookie: outro.cookie, body: { functionId: 'dca', params: {} },
  });
  assert.equal(escrita.status, 403);

  const keystore = await call('GET', `/api/agents/${criado.body.id}/keystore`, { cookie: outro.cookie });
  assert.equal(keystore.status, 403, 'keystore de outra conta jamais pode ser exportado');
});

// Trocar o token alvo precisa ser barato. Criar outro agente para corrigir um
// endereço digitado errado significaria carteira nova, chave nova e fundos para
// mover — custo alto demais para um erro de digitação.
test('o dono troca o token alvo e o nome do agente sem recriar nada', async () => {
  const dono = await login(createAccount());
  const criado = await call('POST', '/api/agents', {
    cookie: dono.cookie, body: { label: 'antes', password: 'senha-de-teste-1' },
  });
  const id = criado.body.id;

  const renomeia = await call('PATCH', `/api/agents/${id}`, { cookie: dono.cookie, body: { label: 'depois' } });
  assert.equal(renomeia.status, 200);
  assert.equal(renomeia.body.agent.label, 'depois');
  assert.equal(renomeia.body.agent.address, criado.body.address, 'a carteira não pode mudar ao renomear');

  const vazio = await call('PATCH', `/api/agents/${id}`, { cookie: dono.cookie, body: { label: '   ' } });
  assert.equal(vazio.status, 400);

  const limpa = await call('PATCH', `/api/agents/${id}`, { cookie: dono.cookie, body: { token: '' } });
  assert.equal(limpa.status, 200);
  assert.equal(limpa.body.agent.target_token, null);
});

test('endereço de token malformado é recusado sem tocar na rede', async () => {
  const dono = await login(createAccount());
  const criado = await call('POST', '/api/agents', {
    cookie: dono.cookie, body: { label: 'agente', password: 'senha-de-teste-1' },
  });
  const r = await call('PATCH', `/api/agents/${criado.body.id}`, {
    cookie: dono.cookie, body: { token: 'nao-e-um-endereco' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not a valid address/);
});

test('ninguém troca o token do agente de outra conta', async () => {
  const dono = await login(createAccount());
  const outro = await login(createAccount());
  const criado = await call('POST', '/api/agents', {
    cookie: dono.cookie, body: { label: 'agente', password: 'senha-de-teste-1' },
  });
  const r = await call('PATCH', `/api/agents/${criado.body.id}`, {
    cookie: outro.cookie, body: { label: 'sequestrado' },
  });
  assert.equal(r.status, 403);
});

test('o dono consegue configurar funções do próprio agente', async () => {
  const dono = await login(createAccount());
  const criado = await call('POST', '/api/agents', {
    cookie: dono.cookie, body: { label: 'agente', password: 'senha-de-teste-1' },
  });
  const on = await call('POST', `/api/agents/${criado.body.id}/functions`, {
    cookie: dono.cookie, body: { functionId: 'dca', params: { amountEth: '0.003' } },
  });
  assert.equal(on.status, 200);
  assert.equal(on.body.params.amountEth, '0.003');

  const detalhe = await call('GET', `/api/agents/${criado.body.id}`, { cookie: dono.cookie });
  assert.equal(detalhe.body.functions.length, 1);
  assert.equal(detalhe.body.keystore_path, undefined, 'o caminho do keystore não pode ir para o cliente');
});

test('validação de airdrop é pública e reporta erros de lista', async () => {
  const { status, body } = await call('POST', '/api/airdrop/validate', {
    body: { csv: '0x1111111111111111111111111111111111111111,100\nlixo,5' },
  });
  assert.equal(status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.errors.length, 1);
});

test('rota inexistente devolve 404', async () => {
  assert.equal((await call('GET', '/api/nao-existe')).status, 404);
});

// ---------------------------------------------------------------- rate limit

test('nonce endpoint tem rate limit por IP', async () => {
  const { resetAll } = await import('../src/web/ratelimit.js');
  resetAll();
  const acc = createAccount();
  let blocked = 0;
  for (let i = 0; i < 25; i++) {
    const r = await call('POST', '/api/auth/nonce', { body: { address: acc.address } });
    if (r.status === 429) blocked++;
  }
  assert.ok(blocked > 0, 'o 21º pedido de nonce deveria ser bloqueado');
  resetAll();
});

test('criação de agentes tem limite mais apertado', async () => {
  const { resetAll } = await import('../src/web/ratelimit.js');
  resetAll();
  const dono = await login(createAccount());
  let blocked = 0;
  for (let i = 0; i < 8; i++) {
    const r = await call('POST', '/api/agents', {
      cookie: dono.cookie, body: { label: `a${i}`, password: 'senha-de-teste-1' },
    });
    if (r.status === 429) blocked++;
  }
  assert.ok(blocked >= 2, `esperava bloqueios após 5 criações, veio ${blocked}`);
  resetAll();
});

test('cabeçalhos de segurança presentes nas páginas', async () => {
  const res = await fetch(base + '/');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('/healthz responde sem autenticação', async () => {
  const res = await fetch(base + '/healthz');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

// O demo saiu do site. Quem chegar por link antigo — post, print, favorito —
// nao pode ver 404: vai para o app, que e o lugar util agora.
test('/demo redireciona para o app em vez de 404', async () => {
  for (const caminho of ['/demo', '/demo/']) {
    const res = await fetch(base + caminho, { redirect: 'manual' });
    assert.equal(res.status, 302, `${caminho} deveria redirecionar`);
    assert.equal(res.headers.get('location'), '/app');
  }
});

test('a landing nao oferece mais o demo', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.ok(!html.includes('/demo'), 'nenhum link para o demo pode sobrar na landing');
});

// ---------------------------------------------------------------- termos

test('página de termos é pública', async () => {
  const res = await fetch(base + '/terms');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Terms and risks'));
  assert.ok(/does not reduce total supply/i.test(html), 'os termos precisam avisar sobre a queima');
});

test('criar agente sem aceitar os termos é bloqueado', async () => {
  const dono = await login(createAccount(), false);
  const r = await call('POST', '/api/agents', {
    cookie: dono.cookie, body: { label: 'x', password: 'senha-de-teste-1' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /accept the terms/);
});

test('depois do aceite a criação passa e fica registrada', async () => {
  const dono = await login(createAccount(), false);
  assert.equal((await call('GET', '/api/auth/me', { cookie: dono.cookie })).body.termsAccepted, false);

  const ok = await call('POST', '/api/terms/accept', { cookie: dono.cookie });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/auth/me', { cookie: dono.cookie })).body.termsAccepted, true);

  const r = await call('POST', '/api/agents', {
    cookie: dono.cookie, body: { label: 'x', password: 'senha-de-teste-1' },
  });
  assert.equal(r.status, 200);
});

test('porta ocupada vira mensagem clara, não stack trace', async () => {
  const { describeListenError } = await import('../src/web/server.js');

  const msg = describeListenError({ code: 'EADDRINUSE' }, { port: 8787, host: '127.0.0.1' });
  assert.match(msg, /already in use/);
  assert.match(msg, /ALREADY RUNNING/, 'precisa dizer que o site provavelmente já está no ar');
  assert.match(msg, /http:\/\/127\.0\.0\.1:8787/, 'precisa oferecer o link para abrir');
  assert.match(msg, /PORT=8788/, 'precisa sugerir outra porta');
  assert.ok(!/at Server\./.test(msg), 'não pode vazar stack trace');

  assert.match(describeListenError({ code: 'EACCES' }, { port: 80, host: '0.0.0.0' }), /admin rights/);
  assert.match(describeListenError({ message: 'boom' }, { port: 1, host: 'x' }), /Could not start the server: boom/);
});

// ---------------------------------------------------------------- manutenção pelo HTTP

test('manutenção bloqueia criar agente mas deixa ler e exportar', async () => {
  const { setMaintenance } = await import('../src/web/operator.js');
  const { openDb } = await import('../src/indexer/db.js');
  const db = openDb(DB);

  const dono = await login(createAccount());
  const criado = await call('POST', '/api/agents', {
    cookie: dono.cookie, body: { label: 'antes', password: 'senha-de-teste-1' },
  });
  assert.equal(criado.status, 200);

  setMaintenance(db, true, { reason: 'testing' });
  try {
    const bloqueado = await call('POST', '/api/agents', {
      cookie: dono.cookie, body: { label: 'durante', password: 'senha-de-teste-1' },
    });
    assert.equal(bloqueado.status, 503);
    assert.match(bloqueado.body.error, /maintenance: testing/);

    // leitura e export continuam liberados de propósito
    assert.equal((await call('GET', '/api/agents', { cookie: dono.cookie })).status, 200);
    assert.equal((await call('GET', `/api/agents/${criado.body.id}`, { cookie: dono.cookie })).status, 200);
    assert.equal((await call('GET', `/api/agents/${criado.body.id}/keystore`, { cookie: dono.cookie })).status, 200,
      'quem quer tirar o próprio dinheiro nunca pode ficar preso do lado de fora');
  } finally {
    setMaintenance(db, false);
    db.close();
  }
});

test('status do operador exige o endereço configurado', async () => {
  const qualquer = await login(createAccount());
  assert.equal((await call('GET', '/api/operator/status', { cookie: qualquer.cookie })).status, 403);
});

// `beta` e `depositAdviceEth` sumiram junto com o aviso de early access: o
// produto foi lançado, e um alerta dizendo "isto é novo, cuidado" em toda
// visita deixa de informar e vira ruído. O que precisa ser dito sobre risco
// está nos termos, que são aceitos antes de criar agente.
test('config anuncia manutenção e não carrega mais o aviso de beta', async () => {
  const { body } = await call('GET', '/api/config');
  assert.equal(typeof body.maintenance.on, 'boolean');
  assert.equal(body.beta, undefined);
  assert.equal(body.depositAdviceEth, undefined);
});

// ---------------------------------------------------------------- regressão: endereço em minúsculas

test('login funciona com o endereço em minúsculas, como a MetaMask envia', async () => {
  const acc = createAccount();
  const daMetamask = acc.address.toLowerCase();      // eth_requestAccounts devolve assim
  assert.notEqual(daMetamask, acc.address, 'o teste só vale se as formas diferirem');

  const nonce = await call('POST', '/api/auth/nonce', { body: { address: daMetamask } });
  assert.ok(nonce.body.message.includes(daMetamask), 'a mensagem tem que conter o endereço como veio');

  const verified = await call('POST', '/api/auth/verify', {
    body: {
      address: daMetamask,
      nonce: nonce.body.nonce,
      signature: signPersonalMessage(nonce.body.message, acc.privateKey),
    },
  });
  assert.equal(verified.status, 200, `login recusado: ${verified.body.error}`);
  assert.equal(verified.body.address, acc.address, 'a sessão guarda o endereço com checksum');
});

test('login funciona com o endereço em MAIÚSCULAS', async () => {
  const acc = createAccount();
  const gritando = '0x' + acc.address.slice(2).toUpperCase();
  const nonce = await call('POST', '/api/auth/nonce', { body: { address: gritando } });
  const verified = await call('POST', '/api/auth/verify', {
    body: { address: gritando, nonce: nonce.body.nonce, signature: signPersonalMessage(nonce.body.message, acc.privateKey) },
  });
  assert.equal(verified.status, 200, `login recusado: ${verified.body.error}`);
});

test('assinar um texto diferente do emitido continua sendo recusado', async () => {
  const acc = createAccount();
  const nonce = await call('POST', '/api/auth/nonce', { body: { address: acc.address.toLowerCase() } });
  const verified = await call('POST', '/api/auth/verify', {
    body: {
      address: acc.address.toLowerCase(),
      nonce: nonce.body.nonce,
      signature: signPersonalMessage(nonce.body.message + ' extra', acc.privateKey),
    },
  });
  assert.equal(verified.status, 400);
});

// Trocar a marca não pode exigir editar HTML: quem hospeda não é
// necessariamente quem escreveu o código.
test('nenhum placeholder de marca vaza para a página servida', async () => {
  for (const path of ['/', '/app', '/terms']) {
    const res = await fetch(base + path);
    const html = await res.text();
    // Qualquer token, não só o da marca: este arquivo roda sem PONS_FEE_ADDRESS,
    // então é aqui que se prova que o aviso de taxa some limpo quando não há taxa.
    assert.ok(!html.includes('{{'), `${path} serviu um placeholder cru`);
    assert.ok(html.includes('Blizzard'), `${path} deveria trazer a marca padrão`);
    // Só nas páginas montadas no servidor. Em /app a frase existe no JS inline
    // sempre; o que a esconde é CONFIG.serviceFee vir null, coberto em fee-web.
    if (path !== '/app') {
      assert.ok(!/Service fee/.test(html), `${path} anunciou taxa sem haver taxa configurada`);
    }
  }
});
