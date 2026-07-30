// Registro das funções que o usuário pode ligar em cada agente.
import * as buybackBurn from './buybackBurn.js';
import * as rewards from './rewards.js';
import * as dca from './dca.js';
import * as dipBuy from './dipBuy.js';
import * as airdrop from './airdrop.js';
import * as holderAirdrop from './holderAirdrop.js';

export const FUNCTIONS = {
  [buybackBurn.spec.id]: buybackBurn,
  [rewards.spec.id]: rewards,
  [dca.spec.id]: dca,
  [dipBuy.spec.id]: dipBuy,
  [airdrop.spec.id]: airdrop,
  [holderAirdrop.spec.id]: holderAirdrop,
};

export const catalog = () => Object.values(FUNCTIONS).map((m) => m.spec);

/** Preenche os defaults do spec e valida os tipos do que o usuário mandou. */
export function normalizeParams(functionId, input = {}) {
  const mod = FUNCTIONS[functionId];
  if (!mod) throw new Error(`unknown function: ${functionId}`);
  const out = {};
  for (const [key, def] of Object.entries(mod.spec.params)) {
    const raw = input[key] ?? def.default;
    switch (def.type) {
      case 'int': {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) throw new Error(`${functionId}.${key} must be an integer >= 0`);
        out[key] = n; break;
      }
      case 'decimal': {
        if (!/^\d+(\.\d+)?$/.test(String(raw))) throw new Error(`${functionId}.${key} must be a positive decimal`);
        out[key] = String(raw); break;
      }
      case 'bool': out[key] = raw === true || raw === 'true'; break;
      case 'enum':
        if (!def.options.includes(raw)) throw new Error(`${functionId}.${key} must be one of ${def.options.join(', ')}`);
        out[key] = raw; break;
      case 'address':
        if (raw && !/^0x[0-9a-fA-F]{40}$/.test(String(raw))) throw new Error(`${functionId}.${key} is not an address`);
        out[key] = raw || def.default; break;
      default: out[key] = raw ?? '';
    }
  }
  return out;
}

// -------------------------------------------------------- persistência

export function enableFunction(db, agentId, functionId, params = {}) {
  const normalized = normalizeParams(functionId, params);
  db.prepare(`INSERT INTO agent_functions (agent_id, function_id, enabled, params, updated_at)
              VALUES (?,?,1,?,?)
              ON CONFLICT(agent_id, function_id) DO UPDATE SET enabled=1, params=excluded.params, updated_at=excluded.updated_at`)
    .run(agentId, functionId, JSON.stringify(normalized), Math.floor(Date.now() / 1000));
  return normalized;
}

export const disableFunction = (db, agentId, functionId) =>
  db.prepare('UPDATE agent_functions SET enabled = 0, updated_at = ? WHERE agent_id = ? AND function_id = ?')
    .run(Math.floor(Date.now() / 1000), agentId, functionId);

export const agentFunctions = (db, agentId) =>
  db.prepare('SELECT * FROM agent_functions WHERE agent_id = ?').all(agentId)
    .map((r) => ({ ...r, enabled: !!r.enabled, params: JSON.parse(r.params) }));
