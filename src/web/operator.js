// Controles do operador — quem hospeda a instância.
//
// Duas coisas que qualquer serviço que segura dinheiro precisa ter no primeiro
// dia, e que quase sempre só são feitas depois do primeiro susto:
//
//   1. um jeito de PARAR sem derrubar o servidor. Se algo estiver errado, você
//      quer bloquear criação e execução mantendo todo mundo capaz de ler o
//      estado e exportar o keystore. Derrubar o processo faz o oposto: impede
//      as pessoas de tirarem o próprio dinheiro.
//   2. um jeito de responder "o que aconteceu com a minha transação" com um
//      registro, e não com memória.
import { eqAddress } from '../core/hex.js';
import { resolveFeeConfig } from '../agent/fee.js';
import { dataPersistence } from '../wallet/persistence.js';

export function migrateOperator(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS operator_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );
  `);
  const cols = db.prepare('PRAGMA table_info(decisions)').all().map((c) => c.name);
  if (!cols.includes('error')) db.exec('ALTER TABLE decisions ADD COLUMN error TEXT');
  if (!cols.includes('steps_log')) db.exec('ALTER TABLE decisions ADD COLUMN steps_log TEXT');
}

const get = (db, key) => db.prepare('SELECT value FROM operator_state WHERE key = ?').get(key)?.value;
const set = (db, key, value, by) =>
  db.prepare(`INSERT INTO operator_state (key, value, updated_at, updated_by) VALUES (?,?,?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .run(key, String(value), Date.now(), by ?? null);

export const isAdmin = (address) => {
  const admin = process.env.PONS_ADMIN_ADDRESS;
  return !!admin && !!address && eqAddress(admin, address);
};

/**
 * Manutenção pode vir do ambiente (para subir já pausado) ou do botão do
 * operador. Qualquer um dos dois liga.
 */
export function maintenance(db) {
  if (process.env.PONS_MAINTENANCE === '1') {
    return { on: true, source: 'environment', reason: process.env.PONS_MAINTENANCE_REASON || null };
  }
  const flag = get(db, 'maintenance');
  if (flag === '1') {
    return { on: true, source: 'operator', reason: get(db, 'maintenance_reason') || null };
  }
  return { on: false };
}

export function setMaintenance(db, on, { reason, by } = {}) {
  set(db, 'maintenance', on ? '1' : '0', by);
  if (reason !== undefined) set(db, 'maintenance_reason', reason ?? '', by);
  return maintenance(db);
}

/** Ações que ficam bloqueadas em manutenção. Leitura e export nunca entram aqui. */
export const BLOCKED_IN_MAINTENANCE = new Set([
  'POST /api/agents',
  'POST /api/agents/:id/run',
  'POST /api/decisions/:id/execute',
]);

export function operatorStatus(db) {
  const count = (sql, ...args) => db.prepare(sql).get(...args)?.n ?? 0;
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;
  return {
    maintenance: maintenance(db),
    liveExecution: process.env.PONS_ALLOW_LIVE_EXECUTION === '1',
    keystoresSealed: !!process.env.PONS_MASTER_KEY,
    network: process.env.PONS_NETWORK === 'testnet' ? 'testnet' : 'mainnet',
    // Rota só de admin, então aqui o `problem` pode aparecer: é exatamente onde
    // o operador vai olhar para descobrir por que não está recebendo.
    serviceFee: resolveFeeConfig(),
    // Se isto vier `persistent:false`, nada mais nesta tela importa: as chaves
    // dos agentes somem no proximo deploy.
    storage: dataPersistence(),
    users: count('SELECT COUNT(*) n FROM users'),
    agents: count('SELECT COUNT(*) n FROM agents'),
    decisions24h: count('SELECT COUNT(*) n FROM decisions WHERE ts > ?', dayAgo),
    executed: count("SELECT COUNT(*) n FROM decisions WHERE status = 'executed'"),
    failed: count("SELECT COUNT(*) n FROM decisions WHERE status = 'failed'"),
    recentFailures: db.prepare(
      "SELECT id, agent_id, kind, ts, error FROM decisions WHERE status = 'failed' ORDER BY ts DESC LIMIT 10",
    ).all(),
  };
}

/**
 * Guarda o que aconteceu numa execução, inclusive quando ela falha no meio.
 * O caso que importa é a falha parcial: duas transações confirmadas e a terceira
 * revertida. Sem esse registro, ninguém consegue dizer onde o dinheiro parou.
 */
export function recordExecution(db, decisionId, { status, error, steps }) {
  db.prepare('UPDATE decisions SET status = ?, error = ?, steps_log = ? WHERE id = ?')
    .run(status, error ?? null, JSON.stringify(steps ?? []), decisionId);
}

export { get as operatorGet, set as operatorSet };
