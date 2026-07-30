// Motor do agente: monta o contexto, roda cada função habilitada, passa tudo
// pelos guards e pela política, e grava o resultado. Nada é executado — esta
// versão produz propostas auditáveis (fase 3 liga a execução).
import { FUNCTIONS, agentFunctions } from '../functions/index.js';
import { evaluate, recordDecision } from './policy.js';
import { applyFee, feeNote } from './fee.js';
import { checkOrderAgainstLimits, protocolLimits } from './guards.js';
import { getAgent, agentBalances, syncFundedStatus } from '../wallet/agentWallet.js';
import { getToken } from '../indexer/db.js';
import { snapshotToken, ensureTokenIndexed } from '../indexer/run.js';
import { circulatingSupply } from '../functions/buybackBurn.js';

/** Estado de mercado + saldos + limites, compartilhado por todas as funções. */
export async function buildContext(db, rpc, agentId, tokenAddress) {
  const agent = getAgent(db, agentId);
  if (!agent) throw new Error('agent not found');
  const token = (tokenAddress || agent.target_token || '').toLowerCase();
  if (!token) throw new Error('this agent has no target token set');

  // Se o token ainda não estiver no banco, ele é buscado na hora a partir dos
  // contratos. Mandar o usuário rodar um backfill de milhares de blocos só para
  // ver o próprio token era um pedágio sem motivo — o endereço já é conhecido.
  const row = getToken(db, token)?.pool ? getToken(db, token) : await ensureTokenIndexed(db, rpc, token);
  if (!row) throw new Error('token not found on chain');

  const snap = await snapshotToken(db, rpc, token);
  const balances = await agentBalances(rpc, agent.address, [token]);
  agent.status = syncFundedStatus(db, agent, balances.eth);
  const supply = await circulatingSupply(rpc, token, row.total_supply || '0').catch(() => null);
  const limits = await protocolLimits(rpc, token).catch(() => null);

  return {
    db, rpc, agent, token,
    state: {
      ...snap,
      isToken0: !!row.is_token0,
      decimals: row.decimals ?? 18,
      poolFee: row.pool_fee || 10000,
      symbol: row.symbol,
    },
    balances: { eth: balances.eth, weth: balances.weth, token: balances.tokens[token] ?? 0n },
    supply,
    limits,
  };
}

/**
 * Roda todas as funções habilitadas do agente.
 * Retorna propostas com o veredito de cada camada de controle.
 */
export async function runAgent(db, rpc, agentId, { tokenAddress, persist = true } = {}) {
  const ctx = await buildContext(db, rpc, agentId, tokenAddress);
  const enabled = agentFunctions(db, agentId).filter((f) => f.enabled);
  const results = [];

  const spentToday = db.prepare(
    "SELECT payload FROM decisions WHERE agent_id = ? AND ts > ? AND status = 'executed'",
  ).all(agentId, Math.floor(Date.now() / 1000) - 86400)
    .reduce((s, r) => { try { return s + BigInt(JSON.parse(r.payload).notionalWei ?? 0); } catch { return s; } }, 0n);

  // Conta operações EXECUTADAS, não propostas.
  //
  // Antes contava toda linha da tabela `decisions`, que guarda também as
  // propostas rejeitadas e as pendentes de aprovação. Como cada clique em
  // "Run agent (simulation)" grava uma linha, seis simulações — nenhuma delas
  // gastando um centavo — travavam o agente com "hourly trade limit reached".
  // O limite existe para conter frequência de negociação; simular não é negociar.
  const tradesLastHour = db.prepare(
    "SELECT COUNT(*) c FROM decisions WHERE agent_id = ? AND ts > ? AND status = 'executed'",
  ).get(agentId, Math.floor(Date.now() / 1000) - 3600).c;

  // Mesmo raciocínio para o intervalo mínimo entre operações: só conta o que
  // foi de fato enviado. Sem execução nenhuma, o intervalo é infinito.
  const lastExecuted = db.prepare(
    "SELECT MAX(ts) t FROM decisions WHERE agent_id = ? AND status = 'executed'",
  ).get(agentId)?.t ?? null;
  const secondsSinceLastTrade = lastExecuted === null
    ? Number.MAX_SAFE_INTEGER
    : Math.floor(Date.now() / 1000) - lastExecuted;

  for (const fn of enabled) {
    const mod = FUNCTIONS[fn.function_id];
    if (!mod) { results.push({ functionId: fn.function_id, error: 'function not registered' }); continue; }

    let planned;
    try {
      planned = await mod.plan(ctx, fn.params);
    } catch (err) {
      results.push({ functionId: fn.function_id, error: err.message });
      continue;
    }

    // Taxa de serviço do operador, quando configurada.
    //
    // A injeção é AQUI, num lugar só, e antes do evaluate/recordDecision de
    // propósito: recordDecision serializa a decisão para a trilha de auditoria,
    // então um passo criado depois deste ponto não apareceria no que fica
    // gravado, nem no preflight, nem na tela — o usuário veria uma transação a
    // menos do que sai de fato.
    const withFee = planned.decisions.map((d) => applyFee(d, {
      agentAddress: ctx.agent.address,
      estimateWei: d.pendingPairWei,
    }));

    const evaluated = withFee.map((decision) => {
      // 1) limites do próprio protocolo — evita transação que reverteria
      const protocolProblems = ctx.limits
        ? checkOrderAgainstLimits(
          { tokenAmount: decision.expectedTokensOut ?? 0n, currentBalance: ctx.balances.token },
          ctx.limits,
        )
        : [];

      // 2) política de risco do agente
      const verdict = evaluate(decision, {
        policy: ctx.agent.policy,
        ethBalanceWei: ctx.balances.eth,
        spentTodayWei: spentToday,
        poolLiquidityWei: ctx.state.liquidity,
        tradesLastHour,
        secondsSinceLastTrade,
      });
      verdict.violations = [...protocolProblems, ...verdict.violations];
      verdict.approved = verdict.violations.length === 0;

      const id = persist ? recordDecision(db, agentId, decision, verdict) : null;
      return { id, decision, verdict };
    });

    // A taxa é dita em texto além de aparecer como passo, para quem lê as notes
    // antes de aprovar não precisar somar transação.
    const feeNotes = [...new Set(withFee.map(feeNote).filter(Boolean))];

    results.push({
      functionId: fn.function_id,
      label: mod.spec.label,
      notes: [...(planned.notes ?? []), ...feeNotes],
      status: planned.status,
      preview: planned.preview,
      decisions: evaluated,
    });
  }

  return { agent: { id: ctx.agent.id, address: ctx.agent.address, status: ctx.agent.status }, token: ctx.token, state: serializeState(ctx), results };
}

const serializeState = (ctx) => ({
  symbol: ctx.state.symbol,
  pricePair: String(ctx.state.pricePair),
  mcapPair: String(ctx.state.mcapPair),
  liquidity: String(ctx.state.liquidity),
  graduated: ctx.state.graduated,
  balances: {
    eth: String(ctx.balances.eth),
    weth: String(ctx.balances.weth),
    token: String(ctx.balances.token),
  },
  supply: ctx.supply && {
    total: String(ctx.supply.total),
    burned: String(ctx.supply.burned),
    circulating: String(ctx.supply.circulating),
  },
  restrictionsActive: ctx.limits?.restrictionsActive ?? null,
});

export const pendingDecisions = (db, agentId) =>
  db.prepare("SELECT * FROM decisions WHERE agent_id = ? AND status = 'pending_approval' ORDER BY ts DESC").all(agentId);

export const recentDecisions = (db, agentId, limit = 50) =>
  db.prepare('SELECT * FROM decisions WHERE agent_id = ? ORDER BY ts DESC LIMIT ?').all(agentId, limit);

export const approveDecision = (db, id) =>
  db.prepare("UPDATE decisions SET status = 'approved' WHERE id = ? AND status = 'pending_approval'").run(id);

export const rejectDecision = (db, id) =>
  db.prepare("UPDATE decisions SET status = 'rejected_by_user' WHERE id = ?").run(id);
