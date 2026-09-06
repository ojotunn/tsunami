// Pons V2: bonding curve + fee escrow.
//
// O que estes testes travam: a cotação reproduz a aritmética do contrato
// (conferida contra um eth_call real da curva do PONSDROP), a detecção só
// afirma "v2" quando a factory V2 responde, a compra vira UMA transação na
// curva com o ETH como value, a coleta vira varredura + saque no escrow, e
// tudo que envolve a pool V4 é recusado com o motivo em vez de fingido.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { CONTRACTS, BURN_ADDRESS } from '../src/chain/config.js';
import { V2, detectV2, quoteCurveBuy, curveSpotPrice, delegationCallsV2, curveItem, escrowItem, v2FactoryItem } from '../src/chain/v2.js';
import { inspectToken } from '../src/chain/token.js';
import { protocolLimits } from '../src/agent/guards.js';
import { compileDecision } from '../src/agent/executor.js';
import { estimateBuy, parseUnits } from '../src/market/pricing.js';
import { plan as planBuyback } from '../src/functions/buybackBurn.js';
import { plan as planRewards, delegationStatus } from '../src/functions/rewards.js';
import { preflight } from '../src/agent/preflight.js';
import { decodeRevert, errorSelector, V2_ERRORS } from '../src/chain/errors.js';
import { selectorOf } from '../src/core/abi.js';
import { openDb, getToken } from '../src/indexer/db.js';
import { ensureTokenIndexed } from '../src/indexer/run.js';
import { createAgent } from '../src/wallet/agentWallet.js';

const TOKEN = '0xca6e7dba9ccc2342f30439115f0c9ed4f5dd7698';
const CURVE = '0xa40483F032B2075C759F7A5a947983940147b058';
const CREATOR = '0xb47ADB5C00b32a76EEe1DdFdf7E7EFB11c190B99';
const AGENT = '0x' + 'ab'.repeat(20);
const NULL = '0x0000000000000000000000000000000000000000';
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// Foto real da curva do PONSDROP em 05/09/2026, usada para a cotação.
const RESERVES = {
  quoteReserve: 1764607441099965366n,
  tokenReserve: 952053108737190051607414592n,
  sellable: 666338823022904337321700307n,
  feeBps: 100n,
  creatorTaxBps: 200n,
  snipeBps: 0n,
};

const launchOf = (over = {}) => ({
  token: TOKEN, curve: CURVE, deployer: CREATOR, creatorFeeRecipient: CREATOR, pairToken: NULL,
  graduationThreshold: 42n * 10n ** 17n, poolFee: 0n, tickSpacing: 200n, creatorTaxBps: 200n,
  buybackEnabled: false, phase: 0n, sweptQuote: 0n, sweptTokens: 0n, sweptAt: 0n, exists: true, ...over,
});

/**
 * RPC de mentira que sabe responder pelas duas factories, pela curva, pelo
 * escrow e pelo token. Cada caso ajusta só o que precisa.
 */
function fakeRpc({ launch = launchOf(), escrow = 0n, curveBalance = null, v1 = { exists: false } } = {}) {
  const reserves = RESERVES;
  const curveReads = {
    getReserves: { quoteReserve: reserves.quoteReserve, tokenReserve: reserves.tokenReserve },
    realQuoteReserve: 84607441099965366n,
    sellableTokens: reserves.sellable,
    reservedTokens: 285714285714285714285714285n,
    graduationThreshold: 42n * 10n ** 17n,
    feeBps: reserves.feeBps,
    creatorTaxBps: reserves.creatorTaxBps,
    currentSnipeTaxBps: 0n,
    graduated: false,
    readyToGraduate: false,
    buybackEnabled: false,
    deployer: launch.creatorFeeRecipient,
  };
  const read = async (address, item, args = []) => {
    if (eq(address, CONTRACTS.factory)) {
      if (item.name === 'getLaunchedToken') return v1;
      if (item.name === 'graduationStatus') throw new Error('execution reverted');
      return 0n;
    }
    if (eq(address, V2.factory)) {
      if (item.name === 'getLaunchedToken') return launch;
      if (item.name === 'getLaunchFeePolicy') return { protocolFeeRecipient: CREATOR, protocolFeeShareBps: 3000, buybackBurnBps: 5000, hookFeeBps: 100, maxInternalPriceImpactBps: 300 };
      return 0n;
    }
    if (eq(address, V2.feeEscrow)) {
      if (item.name === 'balanceOf') return eq(args[0], launch.creatorFeeRecipient) ? escrow : 0n;
      return 0n;
    }
    if (eq(address, CURVE)) return curveReads[item.name] ?? 0n;
    if (eq(address, CONTRACTS.locker)) throw new Error('execution reverted');
    if (eq(address, TOKEN)) {
      if (item.name === 'name') return 'PONSDROP';
      if (item.name === 'symbol') return 'PONSDROP';
      if (item.name === 'decimals') return 18n;
      if (item.name === 'totalSupply') return 10n ** 27n;
      if (item.name === 'balanceOf') return 0n;
      throw new Error('execution reverted');
    }
    return 0n;
  };
  return {
    read,
    readMany: async (reads) => Promise.all(reads.map(async (r) => {
      try { return { ok: true, value: await read(r.address, r.item, r.args) }; }
      catch (e) { return { ok: false, error: e.message }; }
    })),
    getBalance: async (a) => (eq(a, CURVE) ? (curveBalance ?? 84609327418654702n) : 10n ** 18n),
    blockNumber: async () => 9_500_000n,
    chainId: async () => 4663,
    call: async (method, params) => {
      if (method === 'eth_getCode') return '0x6000';
      if (method === 'eth_call') {
        const tx = params[0];
        // Troca de recebedor por um estranho tem que ser recusada.
        if (eq(tx.to, V2.factory) && tx.data.startsWith(selectorOf(v2FactoryItem('transferCreatorFeeRecipient')))) {
          throw Object.assign(new Error('execution reverted'), { rpcData: errorSelector({ name: 'NotCreatorFeeRecipient', inputs: [] }) });
        }
        return '0x';
      }
      throw new Error('unexpected ' + method);
    },
  };
}

// ------------------------------------------------------------ cotação

test('a cotação de compra reproduz a aritmética da curva (conferida contra eth_call real)', () => {
  // eth_call de buy(1e14, 0, deployer) na curva do PONSDROP devolveu este valor.
  const q = quoteCurveBuy({ quoteIn: 10n ** 14n, ...RESERVES });
  assert.equal(q.tokensOut, 52331228616359630152965n);
  assert.equal(q.spent, 10n ** 14n);
  assert.equal(q.refund, 0n);
  assert.ok(q.priceImpactBps >= 0 && q.priceImpactBps < 5, `impacto de 0.0001 ETH deveria ser desprezível, foi ${q.priceImpactBps}`);
});

test('uma compra maior do que o que resta na curva é preenchida até a borda e o resto devolvido', () => {
  const q = quoteCurveBuy({ quoteIn: 100n * 10n ** 18n, ...RESERVES });
  assert.equal(q.tokensOut, RESERVES.sellable);
  assert.ok(q.spent < 100n * 10n ** 18n);
  assert.equal(q.refund, 100n * 10n ** 18n - q.spent);
});

test('a snipe tax entra na cotação e é limitada para o comprador ficar com 1%', () => {
  const sem = quoteCurveBuy({ quoteIn: 10n ** 16n, ...RESERVES });
  const com = quoteCurveBuy({ quoteIn: 10n ** 16n, ...RESERVES, snipeBps: 9900n });
  assert.ok(com.tokensOut < sem.tokensOut);
  // 9900 estoura o teto (10000 − 100 − 200 − 100 = 9600): o líquido é 1% do gasto
  const net = (10n ** 16n * 100n) / 10000n;
  const esperado = (net * RESERVES.tokenReserve) / (RESERVES.quoteReserve + net);
  assert.equal(com.tokensOut, esperado);
});

test('preço à vista da curva na escala do tokenPriceInPair', () => {
  const p = curveSpotPrice(RESERVES);
  assert.equal(p, (RESERVES.quoteReserve * 10n ** 18n) / RESERVES.tokenReserve);
});

test('estimateBuy despacha para a curva e recusa a pool v4 com o motivo', () => {
  const onCurve = estimateBuy({ venue: 'curve', curve: RESERVES }, 10n ** 14n);
  assert.equal(onCurve.amountOut, 52331228616359630152965n);
  assert.throws(() => estimateBuy({ venue: 'v4' }, 10n ** 14n), /Uniswap v4.*not supported/);
});

// ------------------------------------------------------------ detecção

test('detectV2 devolve o lançamento quando a factory V2 conhece o token', async () => {
  const v2 = await detectV2(fakeRpc(), TOKEN);
  assert.equal(v2.version, 'v2');
  assert.ok(eq(v2.curve, CURVE));
  assert.equal(v2.phase, 0);
  assert.equal(v2.phaseName, 'bonding curve');
  assert.equal(v2.nativeQuote, true);
  assert.equal(v2.graduated, false);
});

test('detectV2 devolve null num revert limpo e relança falha de rede', async () => {
  const clean = { read: async () => { throw new Error('execution reverted'); } };
  assert.equal(await detectV2(clean, TOKEN), null);
  const notFound = { read: async () => ({ exists: false }) };
  assert.equal(await detectV2(notFound, TOKEN), null);
  const down = { read: async () => { throw Object.assign(new Error('HTTP 429'), { httpStatus: 429 }); } };
  await assert.rejects(() => detectV2(down, TOKEN), /429/);
});

test('inspectToken reconhece um token v2 depois de a factory v1 negar', async () => {
  const r = await inspectToken(fakeRpc(), TOKEN);
  assert.equal(r.isPonsToken, true);
  assert.equal(r.version, 'v2');
  assert.ok(eq(r.deployer, CREATOR));
  assert.ok(eq(r.feeRecipient, CREATOR));
  assert.equal(r.v2.phaseName, 'bonding curve');
  assert.equal(r.verdict, null);
  assert.equal(r.note, undefined);
});

test('inspectToken avisa quando o lançamento v2 já graduou ou não é pareado com ETH', async () => {
  const grad = await inspectToken(fakeRpc({ launch: launchOf({ phase: 2n }) }), TOKEN);
  assert.equal(grad.isPonsToken, true);
  assert.match(grad.note, /graduated to a Uniswap v4 pool/);
  const pair = await inspectToken(fakeRpc({ launch: launchOf({ pairToken: '0x' + '11'.repeat(20) }) }), TOKEN);
  assert.equal(pair.isPonsToken, true);
  assert.match(pair.note, /not ETH/);
});

test('inspectToken: token de outra plataforma continua "não é da pons" quando as duas factories negam', async () => {
  const r = await inspectToken(fakeRpc({ launch: { exists: false } }), TOKEN);
  assert.equal(r.isPonsToken, false);
  assert.match(r.verdict, /not launched by the pons factory/);
});

// ------------------------------------------------------------ limites e rota

test('protocolLimits de um token v2 não inventa janela de restrição', async () => {
  const l = await protocolLimits(fakeRpc(), TOKEN);
  assert.equal(l.version, 'v2');
  assert.equal(l.restrictionsActive, false);
  assert.ok(eq(l.curve, CURVE));
  assert.equal(l.phase, 0);
});

test('compra v2 compila numa única chamada à curva, com o ETH como value', async () => {
  const amountIn = parseUnits('0.005', 18);
  const { calls } = await compileDecision({
    rpc: fakeRpc(), agentAddress: AGENT, token: TOKEN,
    decision: {
      kind: 'buyback_burn', token: TOKEN, notionalWei: amountIn.toString(),
      steps: [
        { action: 'swap', side: 'buy', amountInWei: amountIn.toString(), minOutWei: '1' },
        { action: 'transfer', to: BURN_ADDRESS, amountRef: 'swap.out' },
      ],
    },
  });
  const buy = calls[0];
  assert.ok(eq(buy.to, CURVE));
  assert.equal(buy.value, amountIn);
  assert.ok(buy.data.startsWith(selectorOf(curveItem('buy'))));
  assert.equal(buy.capturesTokenDelta, true);
  assert.ok(!calls.some((c) => /WETH|approve/i.test(c.label)), 'não há WETH nem allowance na curva');
  assert.match(calls[1].label, /burn/);
});

test('compra num lançamento v2 já graduado é recusada com o motivo', async () => {
  await assert.rejects(() => compileDecision({
    rpc: fakeRpc({ launch: launchOf({ phase: 2n }) }), agentAddress: AGENT, token: TOKEN,
    decision: { kind: 'buyback_burn', token: TOKEN, steps: [{ action: 'swap', side: 'buy', amountInWei: '1000', minOutWei: '0' }] },
  }), /Uniswap v4.*not supported/);
});

test('coleta v2 compila em varredura opcional + saque no escrow que mede o que entrou', async () => {
  const { calls } = await compileDecision({
    rpc: fakeRpc(), agentAddress: AGENT, token: TOKEN,
    decision: {
      kind: 'collect_rewards', token: TOKEN,
      steps: [
        { action: 'call', to: CURVE, method: 'sweepFees', args: [] },
        { action: 'call', to: V2.feeEscrow, method: 'claimEscrow', args: [] },
      ],
    },
  });
  assert.equal(calls.length, 2);
  assert.ok(eq(calls[0].to, CURVE));
  assert.ok(calls[0].data.startsWith(selectorOf(curveItem('sweepFees'))));
  assert.equal(calls[0].optional, true);
  assert.ok(eq(calls[1].to, V2.feeEscrow));
  assert.ok(calls[1].data.startsWith(selectorOf(escrowItem('claim'))));
  assert.equal(calls[1].capturesEthDelta, true);
});

// ------------------------------------------------------------ funções

const TMP = './data/test-v2.sqlite';
for (const s of ['', '-wal', '-shm']) rmSync(TMP + s, { force: true });

const ctxV2 = (over = {}) => {
  const db = openDb(TMP);
  const agent = createAgent(db, { label: 'v2', password: 'senha-de-teste-1' });
  return {
    db, agent, token: TOKEN, rpc: fakeRpc(over.rpc),
    state: { venue: 'curve', curve: RESERVES, sqrtPriceX96: 0n, liquidity: RESERVES.quoteReserve, isToken0: false, decimals: 18, poolFee: 0, pricePair: 0n, mcapPair: 0n, graduated: false, symbol: 'PONSDROP' },
    balances: { eth: parseUnits('0.01', 18), weth: parseUnits('1', 18), token: 0n },
    supply: null,
    ...over.ctx,
  };
};

test('buyback na curva ignora WETH e propõe compra seguida de queima', async () => {
  const ctx = ctxV2();
  const r = await planBuyback(ctx, { amountEth: '0.005', minIntervalMinutes: 0, burnAddress: BURN_ADDRESS });
  assert.equal(r.decisions.length, 1);
  assert.equal(r.decisions[0].steps[0].action, 'swap');
  assert.equal(r.decisions[0].steps[1].to, BURN_ADDRESS);
  assert.ok(r.notes.some((n) => /bonding curve/.test(n)));
  // WETH não serve na curva: 0.5 ETH pedido, 0.01 ETH em ETH, 1 WETH parado
  const big = await planBuyback(ctx, { amountEth: '0.5', minIntervalMinutes: 0, burnAddress: BURN_ADDRESS });
  assert.equal(big.decisions.length, 0);
  assert.ok(big.notes.some((n) => /insufficient balance/.test(n)));
});

test('buyback num lançamento graduado não propõe nada e diz por quê', async () => {
  const ctx = ctxV2({ ctx: { state: { venue: 'v4', graduated: true, decimals: 18 } } });
  const r = await planBuyback(ctx, { amountEth: '0.005', minIntervalMinutes: 0, burnAddress: BURN_ADDRESS });
  assert.equal(r.decisions.length, 0);
  assert.ok(r.notes.some((n) => /Uniswap v4/.test(n)));
});

test('delegationStatus v2: sem delegação aponta a assinatura única na factory', async () => {
  const st = await delegationStatus(fakeRpc(), { token: TOKEN, agentAddress: AGENT });
  assert.equal(st.version, 'v2');
  assert.equal(st.redirectedToAgent, false);
  assert.equal(st.canCollectNow, false);
  assert.equal(st.setupNeeded.length, 1);
  assert.ok(eq(st.setupNeeded[0].to, V2.factory));
  assert.equal(st.setupNeeded[0].item.name, 'transferCreatorFeeRecipient');
  assert.deepEqual(st.setupNeeded[0].args, [TOKEN, AGENT]);
});

test('rewards v2 com delegação feita: coleta do escrow, varrendo a curva antes', async () => {
  const ctx = ctxV2();
  const launch = launchOf({ creatorFeeRecipient: ctx.agent.address });
  ctx.rpc = fakeRpc({ launch, escrow: parseUnits('0.01', 18), curveBalance: 84607441099965366n + parseUnits('0.004', 18) });
  const r = await planRewards(ctx, { mode: 'collect_only', deployPercent: 100, minCollectWei: '0.002', checkIntervalMinutes: 1 });
  assert.equal(r.status.redirectedToAgent, true);
  assert.equal(r.status.canSweep, true);
  const collect = r.decisions.find((d) => d.kind === 'collect_rewards');
  assert.ok(collect, 'deveria propor a coleta');
  assert.deepEqual(collect.steps.map((s) => s.method), ['sweepFees', 'claimEscrow']);
  assert.ok(eq(collect.steps[0].to, CURVE));
  // 0.01 no escrow + 70% dos 0.004 ainda na curva
  assert.equal(BigInt(collect.pendingPairWei), parseUnits('0.01', 18) + (parseUnits('0.004', 18) * 7000n) / 10000n);
});

test('rewards v2 abaixo do mínimo não coleta; sem delegação não coleta', async () => {
  const c1 = ctxV2();
  c1.rpc = fakeRpc({ launch: launchOf({ creatorFeeRecipient: c1.agent.address }), escrow: 10n ** 14n });
  const pouco = await planRewards(c1, { mode: 'collect_only', deployPercent: 100, minCollectWei: '0.002', checkIntervalMinutes: 1 });
  assert.equal(pouco.decisions.length, 0);
  const sem = await planRewards(ctxV2({ rpc: { escrow: parseUnits('1', 18) } }),
    { mode: 'collect_only', deployPercent: 100, minCollectWei: '0.002', checkIntervalMinutes: 1 });
  assert.equal(sem.decisions.length, 0);
  assert.ok(sem.notes.some((n) => /transferCreatorFeeRecipient/.test(n)));
});

test('rewards v2 em burn_immediately compra na curva com o ETH que já está na carteira', async () => {
  const ctx = ctxV2();
  ctx.rpc = fakeRpc({ launch: launchOf({ creatorFeeRecipient: ctx.agent.address }) });
  const r = await planRewards(ctx, { mode: 'burn_immediately', deployPercent: 100, minCollectWei: '0.002', checkIntervalMinutes: 1 });
  const buy = r.decisions.find((d) => d.kind === 'rewards_buyback_burn');
  assert.ok(buy, 'deveria propor a compra na curva');
  assert.equal(buy.steps[0].action, 'swap');
});

test('rewards v2 em modo reserva avisa que a pool v4 ainda não é suportada', async () => {
  const ctx = ctxV2();
  ctx.rpc = fakeRpc({ launch: launchOf({ creatorFeeRecipient: ctx.agent.address }) });
  const r = await planRewards(ctx, { mode: 'reserve_until_graduation', deployPercent: 100, minCollectWei: '0.002', checkIntervalMinutes: 1 });
  assert.ok(r.notes.some((n) => /Uniswap v4/.test(n) && /burn_immediately/.test(n)));
  assert.ok(!r.decisions.some((d) => d.kind === 'rewards_buyback_burn'));
});

test('delegationCallsV2 é uma assinatura só, na factory v2', () => {
  const calls = delegationCallsV2({ token: TOKEN, agentAddress: AGENT });
  assert.equal(calls.length, 1);
  assert.ok(eq(calls[0].to, V2.factory));
  assert.equal(calls[0].item.name, 'transferCreatorFeeRecipient');
});

// ------------------------------------------------------------ preflight e erros

test('preflight de um token v2 checa a curva, a delegação e simula a compra', async () => {
  const r = await preflight(fakeRpc(), TOKEN, '0.005');
  assert.equal(r.version, 'v2');
  const failed = r.checks.filter((c) => !c.ok);
  assert.deepEqual(failed, [], 'checks que falharam: ' + JSON.stringify(failed));
  assert.equal(r.delegation, 'recipient-signed');
  assert.ok(r.route.length >= 2);
  assert.match(r.route[0].label, /bonding curve/);
  assert.equal(r.simulated, true);
  assert.match(r.market.pool, /bonding curve/);
});

test('preflight de um token v2 graduado avisa que a compra na v4 não é suportada', async () => {
  const r = await preflight(fakeRpc({ launch: launchOf({ phase: 2n }) }), TOKEN, '0.005');
  assert.ok(r.checks.some((c) => c.name === 'curve still open' && !c.ok));
  assert.ok(r.warnings.some((w) => /Uniswap v4/.test(w)));
  assert.equal(r.route, null);
});

test('os erros da v2 são decodificados pelo seletor', () => {
  for (const name of ['NotCreatorFeeRecipient', 'CurveGraduated', 'NotFeeSweepOperator']) {
    const e = V2_ERRORS.find((x) => x.name === name);
    assert.equal(decodeRevert(errorSelector(e)).name, name);
  }
});

// ------------------------------------------------------------ indexação

test('um token v2 é indexado com a curva no lugar da pool e a versão gravada', async () => {
  const db = openDb(TMP);
  const t = await ensureTokenIndexed(db, fakeRpc(), TOKEN);
  assert.equal(t.version, 'v2');
  assert.ok(eq(t.pool, CURVE));
  assert.ok(eq(t.curve, CURVE));
  assert.equal(t.phase, 0);
  assert.equal(t.symbol, 'PONSDROP');
  assert.ok(eq(getToken(db, TOKEN).deployer, CREATOR));
});
