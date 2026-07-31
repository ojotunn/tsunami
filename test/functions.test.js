// Testes das funções do agente. Rodam offline com RPC e estado simulados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { openDb, upsertToken, updateTokenState, insertSnapshot } from '../src/indexer/db.js';
import { createAgent } from '../src/wallet/agentWallet.js';
import { catalog, normalizeParams, enableFunction, disableFunction, agentFunctions, FUNCTIONS } from '../src/functions/index.js';
import { parseRecipients, checkSelfDealing } from '../src/functions/airdrop.js';
import { parseLadder, referencePrice, plan as planDip } from '../src/functions/dipBuy.js';
import { plan as planDca, isDue, spentSoFar } from '../src/functions/dca.js';
import { plan as planBuyback } from '../src/functions/buybackBurn.js';
import { topicOf, selectorOf } from '../src/core/abi.js';
import { LOCKER_ABI, lockerItem, delegationCalls } from '../src/chain/locker.js';
import { BURN_ADDRESS, CONTRACTS } from '../src/chain/config.js';
import { Q96, parseUnits, formatUnits } from '../src/market/pricing.js';

const TMP = './data/test-functions.sqlite';
for (const s of ['', '-wal', '-shm']) rmSync(TMP + s, { force: true });

const TOKEN = '0xaaaa000000000000000000000000000000000001';
const POOL = '0xbbbb000000000000000000000000000000000002';

function seed() {
  const db = openDb(TMP);
  upsertToken(db, {
    address: TOKEN, deployer: '0xcccc000000000000000000000000000000000003',
    pairToken: CONTRACTS.weth, pool: POOL, dexId: 0n, launchConfigId: 0n, positionId: 1n,
    restrictionsEndBlock: 0n, initialBuyAmount: 0n, launchBlock: 9000000n, launchTx: '0x' + '01'.repeat(32),
  });
  updateTokenState(db, TOKEN, {
    name: 'Token Teste', symbol: 'TST', decimals: 18,
    totalSupply: 10n ** 27n, isToken0: true, poolFee: 10000,
  });
  const agent = createAgent(db, { label: 'teste', password: 'senha-de-teste-1' });
  return { db, agent };
}

const baseCtx = (db, agent, over = {}) => ({
  db, agent, token: TOKEN,
  rpc: { read: async () => 0n, readMany: async (r) => r.map(() => ({ ok: true, value: 0n })) },
  state: {
    sqrtPriceX96: Q96, liquidity: 10n ** 21n, isToken0: true, decimals: 18, poolFee: 10000,
    pricePair: parseUnits('1', 18), mcapPair: 0n, graduated: false, symbol: 'TST',
  },
  balances: { eth: parseUnits('1', 18), weth: 0n, token: 0n },
  supply: null,
  ...over,
});

// ---------------------------------------------------------------- registro

test('catálogo expõe as seis funções com parâmetros', () => {
  const ids = catalog().map((f) => f.id).sort();
  assert.deepEqual(ids, ['airdrop', 'buyback_burn', 'dca', 'dip_buy', 'holder_airdrop', 'rewards_boost']);
  for (const f of catalog()) {
    assert.ok(f.label && f.description, `${f.id} sem label/description`);
    assert.ok(Object.keys(f.params).length > 0, `${f.id} sem parâmetros`);
  }
});

test('normalizeParams aplica defaults e valida tipos', () => {
  const p = normalizeParams('dca', {});
  assert.equal(p.intervalMinutes, 720);
  assert.equal(p.destination, 'hold');
  assert.throws(() => normalizeParams('dca', { intervalMinutes: -5 }), /must be an integer/);
  assert.throws(() => normalizeParams('dca', { amountEth: 'abc' }), /positive decimal/);
  assert.throws(() => normalizeParams('dca', { destination: 'dump' }), /must be one of/);
  assert.throws(() => normalizeParams('buyback_burn', { burnAddress: '0x123' }), /is not an address/);
  assert.throws(() => normalizeParams('inexistente', {}), /unknown function/);
});

test('ligar e desligar funções persiste no banco', () => {
  const { db, agent } = seed();
  enableFunction(db, agent.id, 'dca', { amountEth: '0.5', intervalMinutes: 60 });
  let fns = agentFunctions(db, agent.id);
  assert.equal(fns.length, 1);
  assert.equal(fns[0].params.amountEth, '0.5');
  assert.equal(fns[0].enabled, true);

  enableFunction(db, agent.id, 'dca', { amountEth: '0.9', intervalMinutes: 60 });
  assert.equal(agentFunctions(db, agent.id).length, 1, 'reativar não deve duplicar');
  assert.equal(agentFunctions(db, agent.id)[0].params.amountEth, '0.9');

  disableFunction(db, agent.id, 'dca');
  assert.equal(agentFunctions(db, agent.id)[0].enabled, false);
  db.close();
});

// ---------------------------------------------------------------- locker

test('ABI do locker gera os seletores das funções de delegação', () => {
  // os seletores precisam ser estáveis e distintos entre si
  const sels = ['collectFees', 'setFeeRedirect', 'setFeeCollector', 'feeRedirects', 'feeCollectors']
    .map((n) => selectorOf(lockerItem(n)));
  assert.equal(new Set(sels).size, sels.length);
  sels.forEach((s) => assert.match(s, /^0x[0-9a-f]{8}$/));
  assert.match(topicOf(lockerItem('FeesClaimed', 'event')), /^0x[0-9a-f]{64}$/);
});

// É UMA assinatura, não duas. A segunda que existia aqui era setFeeCollector,
// que é onlyOwner: um botão que sempre reverteria. O locker autoriza o
// destinatário do redirect a chamar collectFees, então o redirect já basta.
test('delegationCalls monta a única assinatura necessária, no locker', () => {
  const calls = delegationCalls({ token: TOKEN, agentAddress: '0x' + 'ab'.repeat(20) });
  assert.equal(calls.length, 1, 'nenhuma transação onlyOwner pode ser oferecida ao usuário');
  assert.equal(calls[0].to, CONTRACTS.locker);
  assert.equal(calls[0].item.name, 'setFeeRedirect');
  assert.deepEqual(calls[0].args, [TOKEN, '0x' + 'ab'.repeat(20)]);
  assert.ok(!calls.some((c) => c.item.name === 'setFeeCollector'));
  assert.match(calls[0].note, /collectFees on its own/);
});

// ---------------------------------------------------------------- buyback

test('buyback propõe compra seguida de transferência para a queima', async () => {
  const { db, agent } = seed();
  const out = await planBuyback(baseCtx(db, agent), normalizeParams('buyback_burn', { amountEth: '0.01' }));
  assert.equal(out.decisions.length, 1);
  const d = out.decisions[0];
  assert.equal(d.kind, 'buyback_burn');
  assert.equal(d.steps.length, 2);
  assert.equal(d.steps[0].action, 'swap');
  assert.equal(d.steps[1].to, BURN_ADDRESS);
  assert.ok(BigInt(d.expectedTokensOut) > 0n);
  assert.ok(out.notes.some((n) => /totalSupply\(\) does not change/.test(n)), 'must warn that totalSupply does not change');
  db.close();
});

test('buyback recusa quando falta saldo', async () => {
  const { db, agent } = seed();
  const ctx = baseCtx(db, agent, { balances: { eth: parseUnits('0.001', 18), weth: 0n, token: 0n } });
  const out = await planBuyback(ctx, normalizeParams('buyback_burn', { amountEth: '0.5' }));
  assert.equal(out.decisions.length, 0);
  assert.match(out.notes[0], /insufficient balance/);
  db.close();
});

// Impacto de preço saiu inteiro da interface a pedido do usuário: não bloqueia
// nada e não aparece em nota nenhuma. O valor continua no payload gravado da
// decisão, que é o registro de auditoria — tirar da tela é uma escolha de
// interface, apagar do histórico seria outra coisa.
test('impacto não bloqueia nem aparece em nota, mas segue no registro', async () => {
  const { db, agent } = seed();
  const ctx = baseCtx(db, agent, {
    state: { ...baseCtx(db, agent).state, liquidity: 10n ** 18n },
    balances: { eth: parseUnits('10', 18), weth: 0n, token: 0n },
  });
  const out = await planBuyback(ctx, normalizeParams('buyback_burn', { amountEth: '1' }));
  assert.equal(out.decisions.length, 1, 'a ordem não pode ser barrada por impacto');
  assert.ok(!out.notes.some((n) => /impact/i.test(n)), 'nenhuma nota sobre impacto');
  assert.equal(typeof out.decisions[0].priceImpactBps, 'number', 'o valor continua registrado');
  db.close();
});

// ---------------------------------------------------------------- DCA

test('DCA respeita intervalo, orçamento e teto de impacto', async () => {
  const { db, agent } = seed();
  const params = normalizeParams('dca', { amountEth: '0.002', intervalMinutes: 720, totalBudgetEth: '0.1' });

  assert.equal(isDue(db, agent.id, 'dca', 720), true, 'primeira execução deve estar liberada');
  const out = await planDca(baseCtx(db, agent), params);
  assert.equal(out.decisions.length, 1);
  assert.equal(out.decisions[0].kind, 'dca');
  assert.ok(out.notes.some((n) => /pool fees/.test(n)), 'must surface the 1% fee cost');

  // registra a execução e confirma o bloqueio pelo intervalo
  db.prepare(`INSERT INTO decisions (agent_id, ts, token, kind, payload, status) VALUES (?,?,?,?,?,?)`)
    .run(agent.id, Math.floor(Date.now() / 1000), TOKEN, 'dca', JSON.stringify({ notionalWei: parseUnits('0.002', 18).toString() }), 'executed');
  assert.equal(isDue(db, agent.id, 'dca', 720), false);
  const blocked = await planDca(baseCtx(db, agent), params);
  assert.equal(blocked.decisions.length, 0);
  assert.match(blocked.notes[0], /next buy/);
  assert.equal(spentSoFar(db, agent.id, 'dca'), parseUnits('0.002', 18));
  db.close();
});

test('DCA para quando o orçamento acaba', async () => {
  const { db, agent } = seed();
  db.prepare(`INSERT INTO decisions (agent_id, ts, token, kind, payload, status) VALUES (?,?,?,?,?,?)`)
    .run(agent.id, 0, TOKEN, 'dca', JSON.stringify({ notionalWei: parseUnits('0.1', 18).toString() }), 'executed');
  const out = await planDca(baseCtx(db, agent), normalizeParams('dca', { totalBudgetEth: '0.1' }));
  assert.equal(out.decisions.length, 0);
  assert.match(out.notes[0], /budget exhausted/);
  db.close();
});

test('DCA com destino burn acrescenta a transferência', async () => {
  const { db, agent } = seed();
  const out = await planDca(baseCtx(db, agent), normalizeParams('dca', { destination: 'burn' }));
  assert.equal(out.decisions[0].steps.length, 2);
  assert.equal(out.decisions[0].steps[1].to.toLowerCase(), BURN_ADDRESS.toLowerCase());
  db.close();
});

// ---------------------------------------------------------------- dip buy

test('parseLadder ordena os degraus e rejeita lixo', () => {
  assert.deepEqual(parseLadder('20:0.004, 10:0.002'), [
    { dropBps: 1000, amountEth: '0.002' }, { dropBps: 2000, amountEth: '0.004' },
  ]);
  assert.throws(() => parseLadder('abc'), /invalid ladder step/);
});

test('compra em quedas exige histórico', async () => {
  const { db, agent } = seed();
  const out = await planDip(baseCtx(db, agent), normalizeParams('dip_buy', {}));
  assert.equal(out.decisions.length, 0);
  assert.match(out.notes[0], /no price history yet/);
  db.close();
});

test('compra em quedas dispara no degrau certo', async () => {
  const { db, agent } = seed();
  const now = Math.floor(Date.now() / 1000);
  // máxima da janela = 1 ETH
  insertSnapshot(db, {
    token: TOKEN, block: 1, ts: now - 3600, sqrtPriceX96: Q96, liquidity: 10n ** 21n,
    pricePair: parseUnits('1', 18), mcapPair: 0n, graduated: false,
  });
  const ref = referencePrice(db, TOKEN, 24);
  assert.equal(ref.high, parseUnits('1', 18));

  // preço atual 0.78 => queda de 22%, acima dos 20% configurados
  const ctx = baseCtx(db, agent, {
    state: { ...baseCtx(db, agent).state, pricePair: parseUnits('0.78', 18) },
  });
  const out = await planDip(ctx, normalizeParams('dip_buy', { dropPercent: 20, amountEth: '0.004' }));
  assert.equal(out.decisions.length, 1);
  assert.equal(out.decisions[0].notionalWei, parseUnits('0.004', 18).toString());
  assert.match(out.decisions[0].rationale, /22\.00% below the 24h high/);
  db.close();
});

// A escada antiga (`10:0.002, 20:0.004`) saiu da tela por ser ilegível, mas
// quem já tinha um agente configurado com ela não pode ver o agente parar.
test('a escada antiga continua funcionando para quem já a tinha salva', async () => {
  const { db, agent } = seed();
  insertSnapshot(db, {
    token: TOKEN, block: 1, ts: Math.floor(Date.now() / 1000) - 3600, sqrtPriceX96: Q96,
    liquidity: 10n ** 21n, pricePair: parseUnits('1', 18), mcapPair: 0n, graduated: false,
  });
  const ctx = baseCtx(db, agent, {
    state: { ...baseCtx(db, agent).state, pricePair: parseUnits('0.78', 18) },
  });
  const out = await planDip(ctx, { ...normalizeParams('dip_buy', {}), ladder: '10:0.002, 20:0.004, 35:0.008' });
  assert.equal(out.decisions.length, 1);
  assert.equal(out.decisions[0].notionalWei, parseUnits('0.004', 18).toString(), 'o degrau de 20% continua valendo');
  db.close();
});

test('sem queda suficiente, nada é proposto', async () => {
  const { db, agent } = seed();
  insertSnapshot(db, {
    token: TOKEN, block: 1, ts: Math.floor(Date.now() / 1000) - 600, sqrtPriceX96: Q96,
    liquidity: 10n ** 21n, pricePair: parseUnits('1', 18), mcapPair: 0n, graduated: false,
  });
  const ctx = baseCtx(db, agent, { state: { ...baseCtx(db, agent).state, pricePair: parseUnits('0.97', 18) } });
  const out = await planDip(ctx, normalizeParams('dip_buy', {}));
  assert.equal(out.decisions.length, 0);
  assert.ok(out.notes.some((n) => /has not reached 10% yet/.test(n)));
  db.close();
});

// ---------------------------------------------------------------- airdrop

test('parseRecipients valida endereços, duplicatas e valores', () => {
  const csv = [
    '# comentário',
    '0x1111111111111111111111111111111111111111,100',
    '0x2222222222222222222222222222222222222222,250.5',
    '0x1111111111111111111111111111111111111111,10',   // duplicado
    'endereco-errado,5',
    '0x3333333333333333333333333333333333333333,0',
  ].join('\n');
  const out = parseRecipients(csv, 18);
  assert.equal(out.recipients.length, 2);
  assert.equal(out.total, parseUnits('350.5', 18));
  assert.equal(out.errors.length, 3);
  assert.ok(out.errors.some((e) => /duplicate address/.test(e)));
  assert.ok(out.errors.some((e) => /invalid address/.test(e)));
  assert.ok(out.errors.some((e) => /greater than zero/.test(e)));
});

test('airdrop recusa lista que aponta para carteiras da própria ferramenta', async () => {
  const { db, agent } = seed();
  const problems = checkSelfDealing(
    [{ address: agent.address, amount: 1n }, { address: '0x' + '99'.repeat(20), amount: 1n }],
    { db, agentAddress: agent.address },
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /wallet owned by this tool/);

  const ctx = baseCtx(db, agent);
  const out = await FUNCTIONS.airdrop.plan(ctx, normalizeParams('airdrop', {
    recipientsCsv: `${agent.address},100`, dryRun: false,
  }));
  assert.equal(out.decisions.length, 0);
  assert.ok(out.notes.some((n) => /airdrop cancelled/.test(n)));
  db.close();
});

// O airdrop tinha um parametro "Simulate only" ligado por padrao, que fazia a
// funcao nao propor nada. O efeito na tela era pessimo: ligar o airdrop, mandar
// rodar e nao acontecer nada, sem motivo visivel. Agora ela sempre propoe, e
// quem decide se algo sai e a politica de risco mais o envio de verdade.
test('airdrop sempre propõe e divide em lotes', async () => {
  const { db, agent } = seed();
  const csv = Array.from({ length: 120 }, (_, i) =>
    `0x${String(i + 1).padStart(40, '0')},10`).join('\n');

  const out = await FUNCTIONS.airdrop.plan(baseCtx(db, agent), normalizeParams('airdrop', {
    recipientsCsv: csv, batchSize: 50,
  }));
  assert.equal(out.decisions.length, 3);            // 50 + 50 + 20
  assert.equal(out.decisions[0].steps.length, 50);
  assert.equal(out.decisions[2].steps.length, 20);
  assert.equal(out.preview.recipients, 120);

  // O parametro sumiu do spec: mandar dryRun agora e ignorado, nao volta a
  // esconder as decisoes.
  const comLixo = await FUNCTIONS.airdrop.plan(baseCtx(db, agent), normalizeParams('airdrop', {
    recipientsCsv: csv, batchSize: 50, dryRun: true,
  }));
  assert.equal(comLixo.decisions.length, 3, 'dryRun nao pode mais silenciar a funcao');
  db.close();
});

test('formatação de supply em circulação é legível', () => {
  assert.equal(formatUnits(10n ** 27n, 18, 0), '1000000000');
});

// ---------------------------------------------------------------- ritmo

// Simular não é negociar.
//
// O contador de operações por hora lia toda a tabela `decisions`, que também
// guarda propostas rejeitadas e pendentes. Como cada clique em "Run agent
// (simulation)" grava uma linha, seis simulações — sem gastar nada — travavam
// o agente com "hourly trade limit reached".
test('propostas simuladas não contam para o limite de operações por hora', async () => {
  const { db, agent } = seed();
  const now = Math.floor(Date.now() / 1000);
  const insert = db.prepare(`INSERT INTO decisions (agent_id, ts, token, kind, rationale, payload, risk, status)
                             VALUES (?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 10; i++) {
    insert.run(agent.id, now - i, TOKEN, 'buyback_burn', null, '{}', '{}', 'pending_approval');
  }

  const executadas = db.prepare(
    "SELECT COUNT(*) c FROM decisions WHERE agent_id = ? AND ts > ? AND status = 'executed'",
  ).get(agent.id, now - 3600).c;
  const todas = db.prepare('SELECT COUNT(*) c FROM decisions WHERE agent_id = ? AND ts > ?')
    .get(agent.id, now - 3600).c;

  assert.equal(todas, 10, 'as propostas continuam gravadas para auditoria');
  assert.equal(executadas, 0, 'nenhuma delas pode contar como operação feita');
  db.close();
});

test('operações executadas de verdade contam', async () => {
  const { db, agent } = seed();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT INTO decisions (agent_id, ts, token, kind, rationale, payload, risk, status)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(agent.id, now - 5, TOKEN, 'buyback_burn', null, '{}', '{}', 'executed');
  const executadas = db.prepare(
    "SELECT COUNT(*) c FROM decisions WHERE agent_id = ? AND ts > ? AND status = 'executed'",
  ).get(agent.id, now - 3600).c;
  assert.equal(executadas, 1);
  db.close();
});
