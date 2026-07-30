// Indexação sob demanda de um único token.
//
// Existe porque "token is not indexed — run index backfill first" apareceu na
// tela de quem tinha acabado de colar o próprio endereço e vê-lo validado. O
// dado já estava a duas leituras de distância; pedir uma varredura de milhares
// de blocos era pedágio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { openDb, getToken } from '../src/indexer/db.js';
import { ensureTokenIndexed } from '../src/indexer/run.js';
import { CONTRACTS } from '../src/chain/config.js';

const DB = './data/test-ensure.sqlite';
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });

const TOKEN = '0x8546146066e2300000000000000000000000abcd';
const POOL = '0x2222222222222222222222222222222222222222';
const DEPLOYER = '0xb021905fD9eB00000000000000000000000000ff';

const launchedOk = {
  exists: true, deployer: DEPLOYER, pairedToken: CONTRACTS.weth,
  positionId: 7n, dexId: 0n, launchConfigId: 1n, restrictionsEndBlock: 0n,
  initialBuyAmount: 0n, isToken0: true, poolFee: 10000,
};

const fakeRpc = ({ launched = launchedOk, pool = POOL } = {}) => ({
  read: async () => launched,
  readMany: async (reads) => reads.map((r) => {
    const name = r.item.name;
    if (name === 'liquidityPool') return pool ? { ok: true, value: pool } : { ok: false, error: 'reverted' };
    if (name === 'name') return { ok: true, value: 'Pons Bank' };
    if (name === 'symbol') return { ok: true, value: 'PBANK' };
    if (name === 'decimals') return { ok: true, value: 18n };
    if (name === 'totalSupply') return { ok: true, value: 1000000000n * 10n ** 18n };
    return { ok: false, error: 'unexpected' };
  }),
});

test('um token da pons é indexado a partir dos contratos, sem backfill', async () => {
  const db = openDb(DB);
  const row = await ensureTokenIndexed(db, fakeRpc(), TOKEN);

  assert.equal(row.address, TOKEN.toLowerCase());
  assert.equal(row.pool, POOL.toLowerCase());
  assert.equal(row.deployer, DEPLOYER.toLowerCase());
  assert.equal(row.symbol, 'PBANK');
  assert.equal(row.decimals, 18);
  assert.equal(row.is_token0, 1);
  assert.equal(row.pool_fee, 10000);
  db.close();
});

test('chamar de novo não duplica nem perde o que já estava gravado', async () => {
  const db = openDb(DB);
  await ensureTokenIndexed(db, fakeRpc(), TOKEN);
  const again = await ensureTokenIndexed(db, {
    read: async () => { throw new Error('não deveria consultar a rede de novo'); },
    readMany: async () => { throw new Error('não deveria consultar a rede de novo'); },
  }, TOKEN);
  assert.equal(again.symbol, 'PBANK');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tokens').get().n, 1);
  db.close();
});

test('token que não saiu da factory da pons é recusado com o motivo', async () => {
  const db = openDb(DB);
  await assert.rejects(
    () => ensureTokenIndexed(db, fakeRpc({ launched: { exists: false } }), '0x' + 'cd'.repeat(20)),
    /not launched by the pons factory/,
  );
  db.close();
});

test('sem pool legível o erro é explícito, e nada meia-boca é gravado', async () => {
  const db = openDb(DB);
  const outro = '0x' + 'ef'.repeat(20);
  await assert.rejects(
    () => ensureTokenIndexed(db, fakeRpc({ pool: null }), outro),
    /liquidity pool/,
  );
  assert.equal(getToken(db, outro), undefined, 'token sem pool não pode ficar gravado pela metade');
  db.close();
});
