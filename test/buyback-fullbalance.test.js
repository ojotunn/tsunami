// "Gastar tudo" com a taxa de serviço ligada.
//
// Arquivo separado porque a config da taxa é lida no carregamento do módulo:
// para testá-la ligada é preciso setar o ambiente ANTES do import, e imports
// estáticos são avaliados antes do corpo do arquivo. Daí o import dinâmico.
//
// A conta importa mais do que parece. Se a função gastar o saldo inteiro sem
// descontar a taxa, a política recusa a decisão pela reserva de gás — e a opção
// simplesmente nunca funciona, sem erro que explique o porquê.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const TMP = './data/test-fullbalance.sqlite';
for (const s of ['', '-wal', '-shm']) rmSync(TMP + s, { force: true });
process.env.PONS_FEE_ADDRESS = '0x00000000000000000000000000000000feeabc01';
process.env.PONS_FEE_BPS = '500';

const { openDb, upsertToken, updateTokenState } = await import('../src/indexer/db.js');
const { createAgent } = await import('../src/wallet/agentWallet.js');
const { normalizeParams } = await import('../src/functions/index.js');
const { plan: planBuyback } = await import('../src/functions/buybackBurn.js');
const { FEE } = await import('../src/agent/fee.js');
const { Q96, parseUnits } = await import('../src/market/pricing.js');
const { CONTRACTS } = await import('../src/chain/config.js');

const TOKEN = '0xaaaa000000000000000000000000000000000001';

function contexto(saldoEth) {
  const db = openDb(TMP);
  upsertToken(db, {
    address: TOKEN, deployer: '0xcccc000000000000000000000000000000000003',
    pairToken: CONTRACTS.weth, pool: '0xbbbb000000000000000000000000000000000002',
    dexId: 0n, launchConfigId: 0n, positionId: 1n, restrictionsEndBlock: 0n,
    initialBuyAmount: 0n, launchBlock: 9000000n, launchTx: '0x' + '01'.repeat(32),
  });
  updateTokenState(db, TOKEN, {
    name: 'Token Teste', symbol: 'TST', decimals: 18,
    totalSupply: 10n ** 27n, isToken0: true, poolFee: 10000,
  });
  const agent = createAgent(db, { label: 'teste', password: 'senha-de-teste-1' });
  return {
    db,
    agent,
    ctx: {
      db, agent, token: TOKEN,
      rpc: { read: async () => 0n, readMany: async (r) => r.map(() => ({ ok: true, value: 0n })) },
      state: {
        sqrtPriceX96: Q96, liquidity: 10n ** 21n, isToken0: true, decimals: 18, poolFee: 10000,
        pricePair: parseUnits('1', 18), mcapPair: 0n, graduated: true, symbol: 'TST',
      },
      balances: { eth: parseUnits(saldoEth, 18), weth: 0n, token: 0n },
      supply: null,
    },
  };
}

test('a taxa esta ligada neste arquivo', () => {
  assert.equal(FEE.enabled, true);
  assert.equal(FEE.bps, 500);
});

test('gastar tudo reserva espaço para o gás E para a taxa', () => {
  const { db, agent, ctx } = contexto('1');
  return planBuyback(ctx, normalizeParams('buyback_burn', { useFullBalance: true })).then((out) => {
    const saldo = parseUnits('1', 18);
    const reserva = BigInt(agent.policy.reserveGasWei);
    const notional = BigInt(out.decisions[0].notionalWei);
    const taxa = (notional * 500n) / 10000n;

    // O que sai da carteira é o notional mais a taxa; tem que caber no saldo
    // menos a reserva, senão a política bloqueia.
    assert.ok(notional + taxa <= saldo - reserva,
      `notional + taxa (${notional + taxa}) estourou o saldo menos a reserva (${saldo - reserva})`);

    // E não pode sobrar dinheiro parado. Não dá para exigir o máximo exato:
    // a taxa arredonda para baixo, então uns poucos wei ainda caberiam. O que
    // importa é que a sobra seja poeira, não uma fatia do saldo.
    const sobra = (saldo - reserva) - (notional + taxa);
    assert.ok(sobra >= 0n && sobra < 1000n,
      `sobrou ${sobra} wei parado — o cálculo está deixando dinheiro para trás`);

    assert.ok(out.notes.some((n) => /for the service fee/.test(n)),
      'a nota precisa dizer quanto ficou separado para a taxa');
    db.close();
  });
});

test('sem "gastar tudo" o valor continua sendo o do campo', () => {
  const { db, ctx } = contexto('1');
  return planBuyback(ctx, normalizeParams('buyback_burn', { amountEth: '0.005' })).then((out) => {
    assert.equal(BigInt(out.decisions[0].notionalWei), parseUnits('0.005', 18));
    db.close();
  });
});
