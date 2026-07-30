// Suíte offline: vetores conhecidos + RPC simulada. Roda sem rede.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { keccakHex, toChecksumAddress } from '../src/core/hex.js';
import { topicOf, selectorOf, encodeFunctionData, decodeFunctionResult, decodeEventLog, encodeTuple, decodeTuple } from '../src/core/abi.js';
import { FACTORY_ABI, POOL_ABI, TOKEN_ABI, abiItem, CONTRACTS, CHAIN } from '../src/chain/config.js';
import { accountFromPrivateKey, createAccount } from '../src/wallet/account.js';
import { encryptKeystore, decryptKeystore } from '../src/wallet/keystore.js';
import { tokenPriceInPair, simulateSwap, swapSide, formatUnits, parseUnits, marketCapInPair, Q96 } from '../src/market/pricing.js';
import { DEFAULT_POLICY, validatePolicy, evaluate } from '../src/agent/policy.js';
import { checkOrderAgainstLimits, largestAllowedOrder } from '../src/agent/guards.js';
import { openDb, upsertToken, updateTokenState, insertSwap, listTokens, getToken } from '../src/indexer/db.js';
import { createAgent, getAgent, listAgents, unlockAgent } from '../src/wallet/agentWallet.js';
import { backfillLaunches } from '../src/indexer/run.js';

const TMP_DB = './data/test.sqlite';
rmSync(TMP_DB, { force: true });
rmSync(TMP_DB + '-wal', { force: true });
rmSync(TMP_DB + '-shm', { force: true });

// ---------------------------------------------------------------- keccak

test('keccak256 bate com vetores conhecidos', () => {
  assert.equal(keccakHex(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccakHex('abc'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(
    keccakHex('Transfer(address,address,uint256)'),
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  );
});

test('checksum EIP-55', () => {
  assert.equal(toChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'), '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  assert.equal(toChecksumAddress('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359'), '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359');
});

// ---------------------------------------------------------------- ABI

test('topics dos eventos batem com a documentação da Pons', () => {
  assert.equal(topicOf(abiItem(FACTORY_ABI, 'TokenLaunched', 'event')),
    '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a');
  assert.equal(topicOf(abiItem(POOL_ABI, 'Swap', 'event')),
    '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67');
});

test('seletores de função conhecidos', () => {
  assert.equal(selectorOf(abiItem(POOL_ABI, 'slot0')), '0x3850c7bd');
  assert.equal(selectorOf(abiItem(TOKEN_ABI, 'balanceOf')), '0x70a08231');
  assert.equal(selectorOf(abiItem(TOKEN_ABI, 'totalSupply')), '0x18160ddd');
});

test('encode/decode round-trip com tuplas e strings', () => {
  const comps = [
    { name: 'a', type: 'address' },
    { name: 's', type: 'string' },
    { name: 'n', type: 'uint256' },
    { name: 'i', type: 'int24' },
    { name: 'b', type: 'bool' },
  ];
  const values = ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'pons família', 12345678901234567890n, -6931n, true];
  const { named } = decodeTuple(comps, encodeTuple(comps, values), 0);
  assert.equal(named.a, values[0]);
  assert.equal(named.s, values[1]);
  assert.equal(named.n, values[2]);
  assert.equal(named.i, values[3]);
  assert.equal(named.b, true);
});

test('decodifica getLaunchedToken (tupla estática de 13 campos)', () => {
  const item = abiItem(FACTORY_ABI, 'getLaunchedToken');
  const fields = item.outputs[0].components;
  const sample = [
    '0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222',
    CONTRACTS.weth, '0x3333333333333333333333333333333333333333',
    42n, 0n, 1n, 8991200n, 10n ** 27n, true, 10000n, true, 5n * 10n ** 15n,
  ];
  const encoded = '0x' + Buffer.from(encodeTuple(fields, sample)).toString('hex');
  const out = decodeFunctionResult(item, encoded);
  assert.equal(out.isToken0, true);
  assert.equal(out.poolFee, 10000n);
  assert.equal(out.supply, 10n ** 27n);
  assert.equal(out.pairedToken.toLowerCase(), CONTRACTS.weth.toLowerCase());
});

test('decodifica um log Swap sintético', () => {
  const ev = abiItem(POOL_ABI, 'Swap', 'event');
  const body = [
    { name: 'amount0', type: 'int256' }, { name: 'amount1', type: 'int256' },
    { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'liquidity', type: 'uint128' }, { name: 'tick', type: 'int24' },
  ];
  const data = '0x' + Buffer.from(encodeTuple(body, [-1000n, 2000n, Q96, 10n ** 18n, -6931n])).toString('hex');
  const log = {
    topics: [topicOf(ev),
      '0x000000000000000000000000' + 'aa'.repeat(20),
      '0x000000000000000000000000' + 'bb'.repeat(20)],
    data,
  };
  const args = decodeEventLog(ev, log);
  assert.equal(args.amount0, -1000n);
  assert.equal(args.amount1, 2000n);
  assert.equal(args.tick, -6931n);
  assert.equal(args.sender.toLowerCase(), '0x' + 'aa'.repeat(20));
  assert.equal(swapSide({ amount0: args.amount0, amount1: args.amount1, isToken0: true }), 'buy');
  assert.equal(swapSide({ amount0: args.amount0, amount1: args.amount1, isToken0: false }), 'sell');
});

// ---------------------------------------------------------------- carteira

test('derivação de endereço a partir da chave privada', () => {
  assert.equal(
    accountFromPrivateKey('0x0000000000000000000000000000000000000000000000000000000000000001').address,
    '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
  );
  assert.equal(
    accountFromPrivateKey('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318').address,
    '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23',
  );
});

test('chaves inválidas são rejeitadas', () => {
  assert.throws(() => accountFromPrivateKey('0x' + '00'.repeat(32)), /out of range|outside the valid/);
  assert.throws(() => accountFromPrivateKey('0x' + 'ff'.repeat(32)), /out of range|outside the valid/);
});

test('keystore V3: round-trip e rejeição de senha errada', () => {
  const acc = createAccount();
  const ks = encryptKeystore(acc.privateKey, 'senha-de-teste-1', { n: 1024 });
  assert.equal(ks.version, 3);
  assert.equal('0x' + ks.address, acc.address.toLowerCase());
  assert.equal(decryptKeystore(ks, 'senha-de-teste-1'), acc.privateKey);
  assert.throws(() => decryptKeystore(ks, 'senha-de-teste-2'), /MAC mismatch/);
});

test('senha curta é recusada', () => {
  assert.throws(() => encryptKeystore(createAccount().privateKey, '123'), /at least 8 characters/);
});

// ---------------------------------------------------------------- preço

test('preço a partir de sqrtPriceX96', () => {
  // sqrtPriceX96 = 2^96 => razão bruta 1:1, decimais iguais => preço 1
  assert.equal(formatUnits(tokenPriceInPair({ sqrtPriceX96: Q96, isToken0: true, tokenDecimals: 18, pairDecimals: 18 }), 18), '1');
  assert.equal(formatUnits(tokenPriceInPair({ sqrtPriceX96: Q96, isToken0: false, tokenDecimals: 18, pairDecimals: 18 }), 18), '1');
  // razão 4:1 => token0 vale 4 do token1
  const sqrt4 = 2n * Q96;
  assert.equal(formatUnits(tokenPriceInPair({ sqrtPriceX96: sqrt4, isToken0: true, tokenDecimals: 18, pairDecimals: 18 }), 18), '4');
  assert.equal(formatUnits(tokenPriceInPair({ sqrtPriceX96: sqrt4, isToken0: false, tokenDecimals: 18, pairDecimals: 18 }), 18), '0.25');
});

test('market cap = preço * supply', () => {
  const price = parseUnits('0.000001', 18);
  const mcap = marketCapInPair(price, 10n ** 9n * 10n ** 18n, 18);
  assert.equal(formatUnits(mcap, 18), '1000');
});

test('simulateSwap: compra move o preço para cima e respeita a taxa', () => {
  const base = { sqrtPriceX96: Q96, liquidity: 10n ** 21n, isToken0: true, feePips: 10000 };
  const buy = simulateSwap({ ...base, amountIn: 10n ** 18n, side: 'buy' });
  assert.ok(buy.sqrtPriceX96After > Q96, 'preço deve subir na compra');
  assert.ok(buy.amountOut > 0n);
  // com fee de 1%, a saída é menor que a de um pool sem taxa
  const noFee = simulateSwap({ ...base, amountIn: 10n ** 18n, side: 'buy', feePips: 0 });
  assert.ok(noFee.amountOut > buy.amountOut);
  // venda empurra o preço para baixo
  const sell = simulateSwap({ ...base, amountIn: 10n ** 18n, side: 'sell' });
  assert.ok(sell.sqrtPriceX96After < Q96, 'preço deve cair na venda');
});

test('simulateSwap: ordem maior gera mais impacto', () => {
  const base = { sqrtPriceX96: Q96, liquidity: 10n ** 21n, isToken0: true, side: 'buy' };
  const small = simulateSwap({ ...base, amountIn: 10n ** 18n });
  const big = simulateSwap({ ...base, amountIn: 10n ** 20n });
  assert.ok(big.priceImpactBps > small.priceImpactBps);
  assert.ok(small.priceImpactBps > 0);
});

test('pool sem liquidez é erro explícito', () => {
  assert.throws(() => simulateSwap({ sqrtPriceX96: Q96, liquidity: 0n, amountIn: 1n, side: 'buy', isToken0: true }),
    /no active liquidity/);
});

// ---------------------------------------------------------------- política

test('política padrão é válida e coerente', () => {
  const p = validatePolicy(DEFAULT_POLICY);
  assert.equal(p.mode, 'propose');
  assert.ok(BigInt(p.maxNotionalPerTradeWei) <= BigInt(p.maxDailyNotionalWei));
});

test('política rejeita configurações imprudentes', () => {
  assert.throws(() => validatePolicy({ ...DEFAULT_POLICY, mode: 'yolo' }), /propose/);
  assert.throws(() => validatePolicy({ ...DEFAULT_POLICY, maxNotionalPerTradeWei: '999' + '0'.repeat(18) }), /cannot exceed/);
});

test('evaluate bloqueia violações de limite', () => {
  const policy = validatePolicy(DEFAULT_POLICY);
  const ok = evaluate(
    { kind: 'swap', side: 'buy', token: '0xabc', notionalWei: 10n ** 15n, priceImpactBps: 40 },
    { policy, ethBalanceWei: 10n ** 17n, spentTodayWei: 0n, poolLiquidityWei: 10n ** 18n, tradesLastHour: 0, inventoryBps: 100, drawdownBps: 0, secondsSinceLastTrade: 999 },
  );
  assert.deepEqual(ok.violations, []);
  assert.equal(ok.needsApproval, true);          // modo 'propose' sempre exige aval

  const bad = evaluate(
    { kind: 'swap', side: 'buy', token: '0xabc', notionalWei: 10n ** 18n, priceImpactBps: 900 },
    { policy, ethBalanceWei: 10n ** 18n, spentTodayWei: 0n, poolLiquidityWei: 1n, tradesLastHour: 99, inventoryBps: 9000, drawdownBps: 9999, secondsSinceLastTrade: 1 },
  );
  assert.ok(bad.violations.length >= 6, `esperava várias violações, veio ${bad.violations.length}`);
  assert.equal(bad.approved, false);
});

test('kill switch derruba qualquer decisão', () => {
  const policy = validatePolicy({ ...DEFAULT_POLICY, killSwitch: true });
  const v = evaluate({ kind: 'noop', token: '0xabc' }, { policy, tradesLastHour: 0 });
  assert.ok(v.violations.includes('kill switch is on'));
});

// ---------------------------------------------------------------- guards

// Os limites do token valem SÓ dentro da janela de restrição, e só para compras
// vindas da pool. Fora dela o contrato não impõe teto nenhum. Ver o `_update` do
// PonsLauncherToken, citado em guards.js.
const janela = (extra = {}) => ({
  restrictionsActive: true, isLaunchBlock: false, blocksUntilFree: 40n, supply: 10n ** 27n,
  maxTxTokens: 55n * 10n ** 24n, maxWalletTokens: 5n * 10n ** 25n, ...extra,
});

test('dentro da janela, ordens grandes demais são barradas', () => {
  const limits = janela();
  assert.deepEqual(checkOrderAgainstLimits({ tokenAmount: 10n ** 24n, currentBalance: 0n }, limits), []);
  const grande = checkOrderAgainstLimits({ tokenAmount: 10n ** 26n, currentBalance: 0n }, limits);
  assert.ok(grande.some((p) => p.includes('maxWallet')));
  assert.ok(grande.some((p) => p.includes('maxTx')));
});

// A regressão que motivou tudo isto: uma ordem minúscula durante a janela era
// recusada como se a janela proibisse comprar. Ela não proíbe — limita tamanho.
test('ordem pequena passa mesmo com a janela de restrição ativa', () => {
  const problems = checkOrderAgainstLimits({ tokenAmount: 10n ** 21n, currentBalance: 0n }, janela());
  assert.deepEqual(problems, [], `ordem 100.000x abaixo do teto não pode ser bloqueada: ${problems}`);
});

test('fora da janela não existe teto nenhum', () => {
  const limits = janela({ restrictionsActive: false });
  assert.deepEqual(checkOrderAgainstLimits({ tokenAmount: 10n ** 27n, currentBalance: 0n }, limits), []);
});

test('no bloco de lançamento a compra pela pool é recusada', () => {
  const problems = checkOrderAgainstLimits({ tokenAmount: 1n, currentBalance: 0n }, janela({ isLaunchBlock: true }));
  assert.ok(problems[0].includes('launch block'));
});

test('o teto de maxTx conta o acumulado, não a ordem isolada', () => {
  // Saldo já perto do teto: uma ordem pequena ainda estoura o acumulado.
  const limits = janela();
  const problems = checkOrderAgainstLimits(
    { tokenAmount: 10n ** 24n, currentBalance: 55n * 10n ** 24n }, limits,
  );
  assert.ok(problems.some((p) => p.includes('cumulative')));
});

test('largestAllowedOrder respeita o teto mais apertado', () => {
  // Os dois tetos descontam o que já foi comprado: maxWallet porque olha o saldo
  // resultante, maxTx porque é acumulado por carteira.
  const limits = {
    restrictionsActive: true, supply: 10n ** 27n,
    maxTxTokens: 2n * 10n ** 25n, maxWalletTokens: 15n * 10n ** 24n,
  };
  assert.equal(largestAllowedOrder(limits, 10n ** 25n), 5n * 10n ** 24n, 'maxWallet é o teto mais apertado aqui');
  assert.equal(largestAllowedOrder(limits, 2n * 10n ** 25n), 0n, 'saldo acima do teto não deixa espaço');
});

test('sem janela de restrição, largestAllowedOrder é o supply inteiro', () => {
  const limits = {
    restrictionsActive: false, supply: 10n ** 27n,
    maxTxTokens: 10n ** 25n, maxWalletTokens: 15n * 10n ** 24n,
  };
  assert.equal(largestAllowedOrder(limits, 10n ** 26n), 10n ** 27n);
});

// ---------------------------------------------------------------- banco + agente

test('ciclo de vida do agente: criar, listar, desbloquear', () => {
  const db = openDb(TMP_DB);
  const agent = createAgent(db, { label: 'teste', password: 'senha-de-teste-1' });
  assert.match(agent.address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(agent.status, 'awaiting_funding');
  assert.equal(agent.chainId, CHAIN.id);

  assert.equal(listAgents(db).length, 1);
  assert.equal(getAgent(db, agent.address).id, agent.id);

  const unlocked = unlockAgent(db, agent.id, 'senha-de-teste-1');
  assert.equal(accountFromPrivateKey(unlocked.privateKey).address, agent.address);
  assert.throws(() => unlockAgent(db, agent.id, 'senha-errada-9'), /MAC mismatch/);
  db.close();
});

test('indexador persiste tokens e swaps sem duplicar', () => {
  const db = openDb(TMP_DB);
  upsertToken(db, {
    address: '0xAaA0000000000000000000000000000000000001', deployer: '0xbbb0000000000000000000000000000000000002',
    pairToken: CONTRACTS.weth, pool: '0xCcC0000000000000000000000000000000000003',
    dexId: 0n, launchConfigId: 1n, positionId: 7n, restrictionsEndBlock: 8991200n,
    initialBuyAmount: 0n, launchBlock: 8991150n, launchTx: '0x' + '11'.repeat(32),
  });
  updateTokenState(db, '0xAaA0000000000000000000000000000000000001', {
    name: 'Teste', symbol: 'TST', decimals: 18, totalSupply: 10n ** 27n, isToken0: true, poolFee: 10000,
  });
  const t = getToken(db, '0xaaa0000000000000000000000000000000000001');
  assert.equal(t.symbol, 'TST');
  assert.equal(t.is_token0, 1);
  assert.equal(t.total_supply, (10n ** 27n).toString());

  const swap = {
    txHash: '0x' + '22'.repeat(32), logIndex: 3, pool: '0xCcC0000000000000000000000000000000000003',
    block: 8991160, sender: '0x' + 'dd'.repeat(20), recipient: '0x' + 'ee'.repeat(20),
    amount0: -5n, amount1: 10n, sqrtPriceX96: Q96, liquidity: 10n ** 18n, tick: 0, side: 'buy', pairVolume: 10n,
  };
  insertSwap(db, swap);
  insertSwap(db, swap);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM swaps').get().c, 1);
  assert.ok(listTokens(db).length >= 1);
  db.close();
});

// ---------------------------------------------------------------- RPC simulada

test('backfill decodifica logs de uma RPC simulada', async () => {
  const db = openDb(TMP_DB);
  const ev = abiItem(FACTORY_ABI, 'TokenLaunched', 'event');
  const body = ev.inputs.filter((i) => !i.indexed);
  const token = '0x' + '1a'.repeat(20);
  const data = '0x' + Buffer.from(encodeTuple(body, [
    CONTRACTS.weth, '0x' + '2b'.repeat(20), 0n, 1n, 99n, 8991300n, 0n,
  ])).toString('hex');

  const fakeRpc = {
    getLogs: async () => [{
      address: CONTRACTS.factory,
      blockNumber: 8991250n,
      logIndex: 0,
      transactionHash: '0x' + '33'.repeat(32),
      args: decodeEventLog(ev, {
        topics: [topicOf(ev), '0x000000000000000000000000' + '1a'.repeat(20),
          '0x000000000000000000000000' + '3c'.repeat(20), '0x000000000000000000000000' + '4d'.repeat(20)],
        data,
      }),
    }],
  };

  const total = await backfillLaunches({ rpc: fakeRpc, db, fromBlock: 8991200n, toBlock: 8991300n, step: 1000n });
  assert.equal(total, 1);
  const row = getToken(db, token);
  assert.ok(row, 'token do log deveria ter sido persistido');
  assert.equal(row.pool, '0x' + '2b'.repeat(20));
  assert.equal(row.pair_token, CONTRACTS.weth.toLowerCase());
  assert.equal(row.launch_block, 8991250);
  db.close();
});

test('formatUnits / parseUnits são inversos', () => {
  for (const v of ['0', '1', '0.5', '123.456789', '1000000']) {
    assert.equal(formatUnits(parseUnits(v, 18), 18), String(Number(v)));
  }
  assert.equal(formatUnits(-1500000000000000000n, 18), '-1.5');
});
