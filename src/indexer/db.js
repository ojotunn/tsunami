// Persistência local em SQLite (node:sqlite, embutido no Node >= 22.5).
// Valores de 256 bits são gravados como TEXT para não perder precisão.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path = process.env.PONS_DB || './data/pons.sqlite') {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tokens (
      address               TEXT PRIMARY KEY,
      deployer              TEXT,
      pair_token            TEXT,
      pool                  TEXT,
      dex_id                TEXT,
      launch_config_id      TEXT,
      position_id           TEXT,
      restrictions_end_block TEXT,
      initial_buy_amount    TEXT,
      launch_block          INTEGER,
      launch_tx             TEXT,
      name                  TEXT,
      symbol                TEXT,
      decimals              INTEGER,
      total_supply          TEXT,
      is_token0             INTEGER,
      pool_fee              INTEGER,
      state_synced_at       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tokens_block ON tokens(launch_block DESC);
    CREATE INDEX IF NOT EXISTS idx_tokens_pool  ON tokens(pool);

    CREATE TABLE IF NOT EXISTS swaps (
      tx_hash      TEXT NOT NULL,
      log_index    INTEGER NOT NULL,
      pool         TEXT NOT NULL,
      block        INTEGER NOT NULL,
      sender       TEXT,
      recipient    TEXT,
      amount0      TEXT,
      amount1      TEXT,
      sqrt_price   TEXT,
      liquidity    TEXT,
      tick         INTEGER,
      side         TEXT,
      pair_volume  TEXT,
      PRIMARY KEY (tx_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_swaps_pool_block ON swaps(pool, block DESC);

    CREATE TABLE IF NOT EXISTS snapshots (
      token       TEXT NOT NULL,
      block       INTEGER NOT NULL,
      ts          INTEGER NOT NULL,
      sqrt_price  TEXT,
      liquidity   TEXT,
      price_pair  TEXT,
      mcap_pair   TEXT,
      graduated   INTEGER,
      PRIMARY KEY (token, block)
    );

    CREATE TABLE IF NOT EXISTS agents (
      id            TEXT PRIMARY KEY,
      label         TEXT,
      address       TEXT NOT NULL UNIQUE,
      keystore_path TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'created',
      policy        TEXT NOT NULL DEFAULT '{}',
      target_token  TEXT,
      custody       TEXT NOT NULL DEFAULT 'hosted'
    );

    CREATE TABLE IF NOT EXISTS agent_functions (
      agent_id    TEXT NOT NULL REFERENCES agents(id),
      function_id TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      params      TEXT NOT NULL DEFAULT '{}',
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (agent_id, function_id)
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id   TEXT NOT NULL REFERENCES agents(id),
      ts         INTEGER NOT NULL,
      token      TEXT,
      kind       TEXT NOT NULL,
      rationale  TEXT,
      payload    TEXT,
      risk       TEXT,
      status     TEXT NOT NULL DEFAULT 'proposed',
      tx_hash    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_agent ON decisions(agent_id, ts DESC);
  `);
}

export const getMeta = (db, key, fallback = null) =>
  db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? fallback;

export const setMeta = (db, key, value) =>
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));

export function upsertToken(db, t) {
  db.prepare(`
    INSERT INTO tokens (address, deployer, pair_token, pool, dex_id, launch_config_id, position_id,
                        restrictions_end_block, initial_buy_amount, launch_block, launch_tx)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(address) DO UPDATE SET
      pool = excluded.pool, pair_token = excluded.pair_token
  `).run(
    t.address.toLowerCase(), t.deployer?.toLowerCase() ?? null, t.pairToken?.toLowerCase() ?? null,
    t.pool?.toLowerCase() ?? null, String(t.dexId ?? ''), String(t.launchConfigId ?? ''),
    String(t.positionId ?? ''), String(t.restrictionsEndBlock ?? ''), String(t.initialBuyAmount ?? ''),
    Number(t.launchBlock ?? 0), t.launchTx ?? null,
  );
}

export function updateTokenState(db, address, s) {
  db.prepare(`
    UPDATE tokens SET name=?, symbol=?, decimals=?, total_supply=?, is_token0=?, pool_fee=?, state_synced_at=?
    WHERE address=?
  `).run(s.name ?? null, s.symbol ?? null, s.decimals ?? null, String(s.totalSupply ?? ''),
    s.isToken0 ? 1 : 0, Number(s.poolFee ?? 0), Math.floor(Date.now() / 1000), address.toLowerCase());
}

export function insertSwap(db, s) {
  db.prepare(`
    INSERT OR IGNORE INTO swaps (tx_hash, log_index, pool, block, sender, recipient,
                                 amount0, amount1, sqrt_price, liquidity, tick, side, pair_volume)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(s.txHash, s.logIndex, s.pool.toLowerCase(), Number(s.block), s.sender?.toLowerCase() ?? null,
    s.recipient?.toLowerCase() ?? null, String(s.amount0), String(s.amount1), String(s.sqrtPriceX96),
    String(s.liquidity), Number(s.tick), s.side, String(s.pairVolume));
}

export const insertSnapshot = (db, s) =>
  db.prepare(`INSERT OR REPLACE INTO snapshots (token, block, ts, sqrt_price, liquidity, price_pair, mcap_pair, graduated)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(s.token.toLowerCase(), Number(s.block), s.ts, String(s.sqrtPriceX96), String(s.liquidity),
      String(s.pricePair), String(s.mcapPair), s.graduated ? 1 : 0);

export const listTokens = (db, limit = 50) =>
  db.prepare('SELECT * FROM tokens ORDER BY launch_block DESC LIMIT ?').all(limit);

export const getToken = (db, address) =>
  db.prepare('SELECT * FROM tokens WHERE address = ?').get(address.toLowerCase());

export const trackedPools = (db) =>
  db.prepare("SELECT pool FROM tokens WHERE pool IS NOT NULL AND pool != ''").all().map((r) => r.pool);
