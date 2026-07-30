// Distribuição para holders reais: filtros, divisão e as travas.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchHolders, eligibleHolders, splitAmounts, protocolAddresses, plan } from '../src/functions/holderAirdrop.js';
import { normalizeParams, catalog } from '../src/functions/index.js';
import { CONTRACTS, BURN_ADDRESS } from '../src/chain/config.js';
import { parseUnits } from '../src/market/pricing.js';

const TOKEN = '0x9f2b4c7e1a83d5064b7e2c9a15fd3e8b7c04a621';
const addr = (n) => '0x' + String(n).padStart(40, '0');
const T = (n) => parseUnits(String(n), 18);

const fakeExplorer = (pages) => async (url) => {
  const page = Number(new URL(url).searchParams.get('page') ?? 0);
  return { ok: true, json: async () => pages[page] };
};

test('a nova função entra no catálogo', () => {
  assert.ok(catalog().some((f) => f.id === 'holder_airdrop'));
  assert.equal(catalog().length, 6);
});

test('fetchHolders segue a paginação e ordena por saldo', async () => {
  const pages = [
    { items: [{ address: { hash: addr(1) }, value: T(100).toString() }], next_page_params: { page: 1 } },
    { items: [{ address: { hash: addr(2) }, value: T(500).toString() }], next_page_params: null },
  ];
  const { holders } = await fetchHolders(TOKEN, { fetchImpl: fakeExplorer(pages) });
  assert.equal(holders.length, 2);
  assert.equal(holders[0].balance, T(500), 'o maior saldo vem primeiro');
});

test('explorador fora do ar vira erro, não lista parcial', async () => {
  const bad = async () => ({ ok: false, status: 503 });
  await assert.rejects(() => fetchHolders(TOKEN, { fetchImpl: bad }), /HTTP 503/);
});

test('contratos, poeira e endereços do protocolo ficam de fora', () => {
  const holders = [
    { address: addr(1), balance: T(5000), isContract: false },
    { address: addr(2), balance: T(10), isContract: false },        // abaixo do mínimo
    { address: addr(3), balance: T(9000), isContract: true },       // contrato
    { address: CONTRACTS.locker, balance: T(9000), isContract: false },
    { address: BURN_ADDRESS, balance: T(50000), isContract: false },
    { address: addr(6), balance: T(3000), isContract: false },
  ];
  const { eligible, removed } = eligibleHolders(holders, {
    minBalance: T(1000), maxHolders: 100, excluded: [], poolAddress: addr(9), agentAddress: addr(8),
  });
  assert.deepEqual(eligible.map((h) => h.address), [addr(1), addr(6)]);
  assert.equal(removed.contracts, 1);
  assert.equal(removed.tooSmall, 1);
  assert.equal(removed.excluded, 2);
});

test('o pool e as carteiras da própria ferramenta são excluídos', () => {
  const pool = addr(77), agente = addr(88), outroAgente = addr(99);
  const holders = [pool, agente, outroAgente, addr(1)].map((a) => ({ address: a, balance: T(5000), isContract: false }));
  const { eligible } = eligibleHolders(holders, {
    minBalance: T(1), maxHolders: 100, excluded: [], poolAddress: pool,
    agentAddress: agente, toolAddresses: [outroAgente],
  });
  assert.deepEqual(eligible.map((h) => h.address), [addr(1)]);
});

test('o corte por maxHolders é reportado, não silencioso', () => {
  const holders = Array.from({ length: 10 }, (_, i) => ({ address: addr(i + 1), balance: T(1000 * (10 - i)), isContract: false }));
  const { eligible, truncated } = eligibleHolders(holders, {
    minBalance: T(1), maxHolders: 3, excluded: [], poolAddress: addr(50), agentAddress: addr(51),
  });
  assert.equal(eligible.length, 3);
  assert.equal(truncated, 7);
  assert.equal(eligible[0].balance, T(10000), 'os maiores primeiro');
});

test('divisão igual dá o mesmo para todos', () => {
  const e = [addr(1), addr(2), addr(3)].map((a) => ({ address: a, balance: T(1) }));
  const out = splitAmounts(e, T(300), 'equal');
  assert.equal(out.length, 3);
  assert.ok(out.every((p) => p.amount === T(100)));
});

test('divisão proporcional segue o saldo de cada um', () => {
  const e = [
    { address: addr(1), balance: T(750) },
    { address: addr(2), balance: T(250) },
  ];
  const out = splitAmounts(e, T(1000), 'proportional');
  assert.equal(out[0].amount, T(750));
  assert.equal(out[1].amount, T(250));
  assert.equal(out[0].amount + out[1].amount, T(1000));
});

test('valor pequeno demais para dividir não vira transferência de zero', () => {
  const e = Array.from({ length: 100 }, (_, i) => ({ address: addr(i + 1), balance: T(1) }));
  assert.deepEqual(splitAmounts(e, 10n, 'equal'), []);
});

// ---------------------------------------------------------------- plan

const ctx = (over = {}) => ({
  rpc: {
    read: async (a, item) => {
      if (item.name === 'balanceOf') return over.balance ?? T(10000);
      if (item.name === 'maxWalletAmount') return over.maxWallet ?? 0n;
      return 0n;
    },
  },
  db: null,
  agent: { address: addr(8) },
  token: TOKEN,
  state: { decimals: 18, pool: addr(9) },
  ...over.ctx,
});

test('sem saldo do token não propõe nada', async () => {
  const out = await plan(ctx({ balance: 0n }), normalizeParams('holder_airdrop', {}));
  assert.equal(out.decisions.length, 0);
  assert.match(out.notes[0], /holds none of this token/);
});

test('pedir mais do que tem é recusado', async () => {
  const out = await plan(ctx({ balance: T(100) }), normalizeParams('holder_airdrop', { amountTokens: '5000' }));
  assert.equal(out.decisions.length, 0);
  assert.match(out.notes[0], /was requested/);
});
