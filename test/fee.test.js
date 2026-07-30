// Taxa de serviço do operador.
//
// O que estes testes protegem, em ordem de importância:
//   1. sem PONS_FEE_ADDRESS nada muda — é o que mantém a suíte antiga honesta;
//   2. a taxa nunca é cobrada duas vezes sobre a mesma reward;
//   3. a taxa nunca derruba uma operação que já aconteceu;
//   4. arredondamento sempre a favor do usuário;
//   5. saque e airdrop nunca pagam.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveFeeConfig, applyFee, feeOf, feeNote, MAX_FEE_BPS, DEFAULT_FEE_BPS,
} from '../src/agent/fee.js';
import { evaluate, DEFAULT_POLICY } from '../src/agent/policy.js';
import { compileDecision, executeDecision, withdrawFromAgent } from '../src/agent/executor.js';
import { CHAIN, CONTRACTS, BURN_ADDRESS, NULL_ADDRESS } from '../src/chain/config.js';
import { createAccount } from '../src/wallet/account.js';
import { parseTransaction } from '../src/chain/tx.js';

const TOKEN = '0x9f2b4c7e1a83d5064b7e2c9a15fd3e8b7c04a621';
const ROUTER = '0x1111111111111111111111111111111111117777';
const FEE_TO = '0x00000000000000000000000000000000feeabc01';
const ON = { enabled: true, address: FEE_TO, bps: 500, problem: null };
const OFF = { enabled: false, address: null, bps: 0, problem: null };

const ETH = 10n ** 18n;

const buyback = () => ({
  kind: 'buyback_burn', token: TOKEN, side: 'buy', notionalWei: '5000000000000000',
  steps: [
    { action: 'swap', side: 'buy', amountInWei: '5000000000000000', minOutWei: '1000' },
    { action: 'transfer', to: BURN_ADDRESS, amountRef: 'swap.out' },
  ],
});

const collect = () => ({
  kind: 'collect_rewards', token: TOKEN, notionalWei: '0', pendingPairWei: (ETH / 100n).toString(),
  steps: [{ action: 'call', to: CONTRACTS.locker, method: 'collectFees', args: [TOKEN] }],
});

/**
 * RPC falsa. `onSend` deixa o teste mexer no saldo quando a transação sai, que
 * é como se mede o delta de uma coleta sem tocar a rede.
 */
function mockRpc(over = {}) {
  const state = {
    sent: [], simulated: [], codeReads: [], estimated: 0,
    chainId: CHAIN.id,
    balance: ETH,
    wethBalance: 0n,
    tokenBalance: 0n,
    allowance: 0n,
    baseFee: 10n ** 9n,
    code: '0x',                       // destino da taxa é carteira comum por padrão
    gasUsed: '0x1388',                // 5000
    effectiveGasPrice: '0x3b9aca00',  // 1 gwei
    failSendTo: null,                 // endereço cujo envio deve falhar
    onSend: null,
    ...over,
  };

  const rpc = {
    state,
    chainId: async () => state.chainId,
    getBalance: async () => state.balance,
    gasPrice: async () => 2n * 10n ** 9n,
    getBlock: async () => ({ baseFeePerGas: '0x' + state.baseFee.toString(16) }),

    read: async (address, item) => {
      if (item.name === 'balanceOf') {
        return String(address).toLowerCase() === CONTRACTS.weth.toLowerCase()
          ? state.wethBalance : state.tokenBalance;
      }
      if (item.name === 'allowance') return state.allowance;
      if (item.name === 'getLaunchedToken') {
        return {
          exists: true, isToken0: true, poolFee: 10000n, dexId: 0n, launchConfigId: 0n,
          supply: 10n ** 27n, restrictionsEndBlock: 0n, pairedToken: CONTRACTS.weth,
          positionManager: '0x' + '22'.repeat(20), positionId: 1n,
        };
      }
      if (item.name === 'getLaunchConfig') {
        return {
          pairToken: CONTRACTS.weth, graduationThreshold: 42n * 10n ** 17n, initialTick: 0n,
          supply: 10n ** 27n, maxWalletBps: 2000, maxTxBps: 1000, restrictionBlocks: 0,
          reservedFee: 0n, enabled: true, routerRequiresDeadline: true,
        };
      }
      if (item.name === 'getDexConfig') {
        return {
          name: 'uniswap-v3', factory: CONTRACTS.v3Factory, positionManager: '0x' + '22'.repeat(20),
          swapRouter: ROUTER, poolFee: 10000n, tickSpacing: 200n, enabled: true,
        };
      }
      return 0n;
    },
    readMany: async (reads) => reads.map(() => ({ ok: true, value: 0n })),
    blockNumber: async () => 9_000_000n,

    call: async (method, params) => {
      if (method === 'eth_call') { state.simulated.push(params[0]); return '0x'; }
      if (method === 'eth_estimateGas') { state.estimated++; return '0x186a0'; }
      if (method === 'eth_maxPriorityFeePerGas') return '0x3b9aca00';
      if (method === 'eth_getTransactionCount') return '0x5';
      if (method === 'eth_getCode') { state.codeReads.push(params[0]); return state.code; }
      if (method === 'eth_sendRawTransaction') {
        const tx = parseTransaction(params[0]);
        if (state.failSendTo && String(tx.to).toLowerCase() === state.failSendTo.toLowerCase()) {
          throw new Error('insufficient funds for transfer');
        }
        state.sent.push(params[0]);
        state.onSend?.(tx, state);
        return '0x' + 'ab'.repeat(32);
      }
      if (method === 'eth_getTransactionReceipt') {
        return { status: '0x1', gasUsed: state.gasUsed, effectiveGasPrice: state.effectiveGasPrice };
      }
      throw new Error(`unexpected rpc method ${method}`);
    },
  };
  return rpc;
}

// ------------------------------------------------- retrocompatibilidade

test('sem PONS_FEE_ADDRESS a decisão sai idêntica', () => {
  const original = buyback();
  const out = applyFee(structuredClone(original), { agentAddress: createAccount().address, config: OFF });
  assert.deepEqual(out, original);
  assert.equal(out.feeWei, undefined);
  assert.equal(out.steps.length, 2);
});

test('sem taxa a compilação continua com as mesmas quatro chamadas', async () => {
  const rpc = mockRpc();
  const decision = applyFee(buyback(), { agentAddress: createAccount().address, config: OFF });
  const { calls } = await compileDecision({
    rpc, decision, agentAddress: createAccount().address, token: TOKEN,
  });
  assert.equal(calls.length, 4);
  assert.ok(!calls.some((c) => /service fee/.test(c.label)));
});

test('decisão sem feeWei avalia igual ao que avaliava antes', () => {
  const ctx = { policy: DEFAULT_POLICY, ethBalanceWei: ETH, tradesLastHour: 0 };
  const semCampo = evaluate({ ...buyback(), token: TOKEN }, ctx);
  const comZero = evaluate({ ...buyback(), token: TOKEN, feeWei: '0' }, ctx);
  assert.deepEqual(semCampo, comZero);
});

// ------------------------------------------------------------ aritmética

test('a fatia em bps arredonda para baixo, a favor do usuário', () => {
  assert.equal(feeOf(1000n, 500), 50n);
  assert.equal(feeOf(19n, 500), 0n);          // 0,95 wei vira 0, não 1
  assert.equal(feeOf(ETH, 500), 5n * 10n ** 16n);
  assert.equal(feeOf(123456789012345678901n, 500), 6172839450617283945n);
  assert.equal(feeOf(ETH, 0), 0n);
});

test('taxa que dá zero não vira transação', () => {
  const d = applyFee({ kind: 'dca', token: TOKEN, notionalWei: '19', steps: [] }, { config: ON });
  assert.equal(d.feeWei, undefined);
  assert.equal(d.steps.length, 0);
});

// ------------------------------------------------------------- injeção

test('a taxa entra como último passo e preenche os campos auditáveis', () => {
  const d = applyFee(buyback(), { config: ON });
  assert.equal(d.feeWei, '250000000000000');   // 5% de 0,005 ETH
  assert.equal(d.feeBps, 500);
  assert.equal(d.feeTo, FEE_TO);
  assert.equal(d.steps.length, 3);

  const pay = d.steps.at(-1);
  assert.equal(pay.action, 'pay');
  assert.equal(pay.to, FEE_TO);
  assert.equal(pay.valueWei, '250000000000000');
  assert.equal(pay.optional, true);
});

test('a taxa não é somada ao notional', () => {
  const d = applyFee(buyback(), { config: ON });
  assert.equal(d.notionalWei, buyback().notionalWei);
});

for (const kind of ['airdrop', 'holder_airdrop', 'rewards_buyback_burn']) {
  test(`${kind} não paga taxa`, () => {
    const d = applyFee({ kind, token: TOKEN, notionalWei: '5000000000000000', steps: [] }, { config: ON });
    assert.equal(d.feeWei, undefined);
    assert.equal(d.steps.length, 0);
  });
}

// A cobrança dupla é o erro mais fácil de cometer aqui: rewards.js monta o
// rewards_buyback_burn reaproveitando o plano do buyback_burn, então uma regra
// do tipo "toda compra paga" cobraria na coleta e de novo no deploy.
test('a mesma reward não é cobrada na coleta e no deploy', () => {
  const daColeta = applyFee(collect(), { config: ON });
  const doDeploy = applyFee({
    kind: 'rewards_buyback_burn', token: TOKEN, notionalWei: '5000000000000000', steps: [],
  }, { config: ON });

  assert.equal(daColeta.feeBps, 500, 'a coleta cobra');
  assert.equal(doDeploy.feeWei, undefined, 'o deploy da mesma reward não cobra de novo');
});

test('coleta de rewards fica com o valor em aberto e uma estimativa', () => {
  const d = applyFee(collect(), { config: ON, estimateWei: collect().pendingPairWei });
  assert.equal(d.feeWei, '0', 'o valor real só existe depois da coleta');
  assert.equal(d.feeEstimateWei, (ETH / 100n * 5n / 100n).toString());
  assert.equal(d.steps.at(-1).valueRef, 'collect.eth');
  assert.equal(d.steps.at(-1).bps, 500);
});

test('coleta sem estimativa ainda cobra, só não tem o que mostrar antes', () => {
  const d = applyFee(collect(), { config: ON });
  assert.equal(d.feeEstimateWei, null);
  assert.equal(d.steps.at(-1).valueRef, 'collect.eth');
});

test('taxa apontando para a própria carteira do agente não cobra nada', () => {
  const agente = createAccount().address;
  const d = applyFee(buyback(), { agentAddress: agente, config: { ...ON, address: agente } });
  assert.equal(d.feeWei, undefined, 'seria uma auto-transferência que só queima gás');
  assert.equal(d.steps.length, 2);
});

test('a nota de divulgação distingue valor cobrado de estimativa', () => {
  assert.match(feeNote(applyFee(buyback(), { config: ON })), /service fee: 0\.00025 ETH \(5%/);
  assert.match(feeNote(applyFee(collect(), { config: ON, estimateWei: collect().pendingPairWei })), /estimated/);
  assert.equal(feeNote(buyback()), null, 'sem taxa não há nota');
});

// --------------------------------------------------------- configuração

test('endereço válido liga a taxa com o padrão de 5%', () => {
  const c = resolveFeeConfig({ PONS_FEE_ADDRESS: FEE_TO });
  assert.deepEqual(c, { enabled: true, address: FEE_TO, bps: DEFAULT_FEE_BPS, problem: null });
});

test('sem endereço a taxa fica desligada e isso não é erro', () => {
  const c = resolveFeeConfig({});
  assert.equal(c.enabled, false);
  assert.equal(c.problem, null);
});

test('configuração inválida desliga a taxa e explica o motivo', () => {
  const casos = [
    [{ PONS_FEE_ADDRESS: '0x123' }, /not a valid 0x address/],
    [{ PONS_FEE_ADDRESS: 'minha carteira' }, /not a valid 0x address/],
    [{ PONS_FEE_ADDRESS: NULL_ADDRESS }, /null or burn address/],
    [{ PONS_FEE_ADDRESS: BURN_ADDRESS }, /null or burn address/],
    [{ PONS_FEE_ADDRESS: FEE_TO, PONS_FEE_BPS: String(MAX_FEE_BPS + 1) }, /above the 10% ceiling/],
    [{ PONS_FEE_ADDRESS: FEE_TO, PONS_FEE_BPS: '5e2' }, /whole number of basis points/],
    [{ PONS_FEE_ADDRESS: FEE_TO, PONS_FEE_BPS: '-1' }, /whole number of basis points/],
    [{ PONS_FEE_ADDRESS: FEE_TO, PONS_FEE_BPS: 'cinco' }, /whole number of basis points/],
  ];
  for (const [env, esperado] of casos) {
    const c = resolveFeeConfig(env);
    assert.equal(c.enabled, false, JSON.stringify(env));
    assert.match(c.problem, esperado);
  }
});

test('bps zero desliga sem reclamar — é uma escolha, não um defeito', () => {
  const c = resolveFeeConfig({ PONS_FEE_ADDRESS: FEE_TO, PONS_FEE_BPS: '0' });
  assert.equal(c.enabled, false);
  assert.equal(c.problem, null);
});

// -------------------------------------------------------------- política

test('a reserva de gás conta a taxa junto com o notional', () => {
  const policy = { ...DEFAULT_POLICY, reserveGasWei: String(2n * 10n ** 15n) };
  const n = 5n * 10n ** 15n;
  const fee = n * 5n / 100n;
  const reserve = 2n * 10n ** 15n;
  const decision = { ...buyback(), token: TOKEN, notionalWei: n.toString(), feeWei: fee.toString() };

  const apertado = evaluate(decision, {
    policy, ethBalanceWei: n + fee + reserve - 1n, tradesLastHour: 0,
  });
  assert.ok(apertado.violations.some((v) => /gas reserve/.test(v)));
  assert.ok(apertado.violations.some((v) => /service fee/.test(v)), 'a mensagem precisa dizer que a taxa entrou na conta');

  const folgado = evaluate(decision, {
    policy, ethBalanceWei: n + fee + reserve, tradesLastHour: 0,
  });
  assert.deepEqual(folgado.violations, []);
});

test('a taxa não consome os limites de notional', () => {
  const policy = {
    ...DEFAULT_POLICY,
    maxNotionalPerTradeWei: '5000000000000000',
    maxDailyNotionalWei: '5000000000000000',
    reserveGasWei: '0',
  };
  const d = { ...buyback(), token: TOKEN, notionalWei: '5000000000000000', feeWei: '250000000000000' };
  const v = evaluate(d, { policy, ethBalanceWei: ETH, tradesLastHour: 0 });
  assert.deepEqual(v.violations, [], 'a taxa não pode empurrar o notional para fora do limite');
});

// -------------------------------------------------------------- executor

test('o passo de taxa compila numa transferência simples de ETH', async () => {
  const rpc = mockRpc();
  const acc = createAccount();
  const { calls } = await compileDecision({
    rpc, decision: applyFee(buyback(), { config: ON }), agentAddress: acc.address, token: TOKEN,
  });

  assert.equal(calls.length, 5);
  const pay = calls.at(-1);
  assert.match(pay.label, /service fee — 0\.00025 ETH/);
  assert.equal(pay.to, FEE_TO);
  assert.equal(pay.data, '0x');
  assert.equal(pay.value, 250000000000000n);
  assert.equal(pay.optional, true);
  // carteira comum: 21000 exatos e nada para simular
  assert.equal(pay.skipSimulation, true);
  assert.equal(pay.fixedGasLimit, 21000n);
});

test('destino com código é tratado como contrato: simula e estima', async () => {
  const rpc = mockRpc({ code: '0x60806040' });
  const acc = createAccount();
  const { calls } = await compileDecision({
    rpc, decision: applyFee(buyback(), { config: ON }), agentAddress: acc.address, token: TOKEN,
  });
  assert.equal(calls.at(-1).skipSimulation, false);
  assert.equal(calls.at(-1).fixedGasLimit, undefined);
});

test('falha ao ler o código não vira veredito: trata como contrato', async () => {
  const rpc = mockRpc();
  const original = rpc.call;
  rpc.call = async (m, p) => (m === 'eth_getCode' ? Promise.reject(new Error('429')) : original(m, p));
  const { calls } = await compileDecision({
    rpc, decision: applyFee(buyback(), { config: ON }), agentAddress: createAccount().address, token: TOKEN,
  });
  assert.equal(calls.at(-1).skipSimulation, false, 'sem saber, o caminho conservador');
});

test('a taxa é a última transação enviada e vai para o endereço configurado', async () => {
  const rpc = mockRpc();
  const acc = createAccount();
  let reads = 0;
  const originalRead = rpc.read;
  rpc.read = async (address, item, args) => {
    if (item.name === 'balanceOf' && String(address).toLowerCase() === TOKEN.toLowerCase()) {
      reads++; return reads > 1 ? 4200n * 10n ** 18n : 0n;
    }
    return originalRead(address, item, args);
  };

  await executeDecision({
    rpc, decision: applyFee(buyback(), { config: ON }), agent: { address: acc.address },
    privateKey: acc.privateKey, dryRun: false,
  });

  assert.equal(rpc.state.sent.length, 5, 'wrap, approve, swap, queima e taxa');
  const paga = parseTransaction(rpc.state.sent.at(-1));
  assert.equal(paga.to.toLowerCase(), FEE_TO.toLowerCase());
  assert.equal(paga.value, 250000000000000n);
  assert.equal(paga.data, '0x');

  const nonces = rpc.state.sent.map((r) => parseTransaction(r).nonce);
  assert.deepEqual(nonces, [5n, 6n, 7n, 8n, 9n], 'o passo extra estende a sequência');
});

// Este é o teste que impede o pior modo de falha: a compra acontece, a taxa
// falha, e a decisão inteira vira 'failed' — tirando do orçamento do DCA uma
// compra que de fato saiu.
test('taxa que falha não derruba a decisão', async () => {
  const rpc = mockRpc({ failSendTo: FEE_TO });
  const acc = createAccount();
  let reads = 0;
  const originalRead = rpc.read;
  rpc.read = async (address, item, args) => {
    if (item.name === 'balanceOf' && String(address).toLowerCase() === TOKEN.toLowerCase()) {
      reads++; return reads > 1 ? 4200n * 10n ** 18n : 0n;
    }
    return originalRead(address, item, args);
  };

  const out = await executeDecision({
    rpc, decision: applyFee(buyback(), { config: ON }), agent: { address: acc.address },
    privateKey: acc.privateKey, dryRun: false,
  });

  assert.equal(rpc.state.sent.length, 4, 'a compra inteira saiu');
  assert.ok(out.steps.slice(0, 4).every((s) => s.hash));
  assert.match(out.steps.at(-1).failed, /insufficient funds/);
});

test('no ensaio a taxa da coleta é pulada com motivo legível', async () => {
  const rpc = mockRpc();
  const acc = createAccount();
  const out = await executeDecision({
    rpc, decision: applyFee(collect(), { config: ON }), agent: { address: acc.address },
    privateKey: acc.privateKey, dryRun: true,
  });
  assert.equal(rpc.state.sent.length, 0);
  assert.match(out.steps.at(-1).skipped, /share of what the collection actually returns/);
});

// --------------------------------------------------- delta da coleta

test('a taxa da coleta usa o que entrou, com o gás somado de volta', async () => {
  const REWARD = ETH / 100n;                       // 0,01 ETH
  const GAS = 5000n * 10n ** 9n;                   // gasUsed * effectiveGasPrice
  const rpc = mockRpc({
    onSend: (tx, state) => { state.balance = state.balance + REWARD - GAS; },
  });
  const acc = createAccount();

  await executeDecision({
    rpc, decision: applyFee(collect(), { config: ON }), agent: { address: acc.address },
    privateKey: acc.privateKey, dryRun: false,
  });

  assert.equal(rpc.state.sent.length, 2, 'coleta e taxa');
  const paga = parseTransaction(rpc.state.sent.at(-1));
  assert.equal(paga.value, REWARD * 5n / 100n, 'sem somar o gás de volta a taxa sairia menor');
});

// O par do pool é WETH: se a reward vier embrulhada, o saldo de ETH só CAI (o
// gás) e medir apenas ETH daria zero — o operador nunca receberia.
test('reward paga em WETH também é medida', async () => {
  const REWARD = ETH / 100n;
  const GAS = 5000n * 10n ** 9n;
  const rpc = mockRpc({
    onSend: (tx, state) => {
      if (String(tx.to).toLowerCase() === CONTRACTS.locker.toLowerCase()) {
        state.balance -= GAS;
        state.wethBalance += REWARD;
      }
    },
  });
  const acc = createAccount();

  await executeDecision({
    rpc, decision: applyFee(collect(), { config: ON }), agent: { address: acc.address },
    privateKey: acc.privateKey, dryRun: false,
  });

  const paga = parseTransaction(rpc.state.sent.at(-1));
  assert.equal(paga.value, REWARD * 5n / 100n);
});

test('coleta que não trouxe nada não gera cobrança', async () => {
  const rpc = mockRpc({ onSend: (tx, state) => { state.balance -= 5000n * 10n ** 9n; } });
  const acc = createAccount();

  const out = await executeDecision({
    rpc, decision: applyFee(collect(), { config: ON }), agent: { address: acc.address },
    privateKey: acc.privateKey, dryRun: false,
  });

  assert.equal(rpc.state.sent.length, 1, 'só a coleta; nada de cobrar sobre nada');
  assert.match(out.steps.at(-1).skipped, /returned nothing/);
});

test('recibo sem effectiveGasPrice não quebra e cobra a menos, nunca a mais', async () => {
  const REWARD = ETH / 100n;
  const GAS = 5000n * 10n ** 9n;
  const rpc = mockRpc({
    effectiveGasPrice: undefined,
    onSend: (tx, state) => { state.balance = state.balance + REWARD - GAS; },
  });
  const acc = createAccount();

  await executeDecision({
    rpc, decision: applyFee(collect(), { config: ON }), agent: { address: acc.address },
    privateKey: acc.privateKey, dryRun: false,
  });

  const paga = parseTransaction(rpc.state.sent.at(-1));
  assert.equal(paga.value, (REWARD - GAS) * 5n / 100n);
  assert.ok(paga.value < REWARD * 5n / 100n, 'errar a favor do usuário');
});

// ----------------------------------------------------------------- saque

// Ninguém pode ficar preso do lado de fora do próprio dinheiro — nem por uma
// taxa. Vale para os dois ativos.
test('saque não paga taxa', async () => {
  const destino = '0x' + '77'.repeat(20);

  for (const asset of ['eth', 'token']) {
    const rpc = mockRpc({ tokenBalance: 1000n * ETH });
    const acc = createAccount();
    await withdrawFromAgent({
      rpc, agent: { address: acc.address }, privateKey: acc.privateKey,
      to: destino, asset, tokenAddress: TOKEN, dryRun: false,
    });

    for (const raw of rpc.state.sent) {
      const tx = parseTransaction(raw);
      assert.notEqual(String(tx.to).toLowerCase(), FEE_TO.toLowerCase(), `${asset}: o saque cobrou taxa`);
    }
  }
});
