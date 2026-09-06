// Tesouraria: a taxa de serviço do site vira recompra e queima do token da casa.
//
// O desenho é deliberadamente pequeno. A taxa já é uma transferência de ETH
// para PONS_FEE_ADDRESS. Se esse endereço for a carteira de um agente criado
// no próprio app — o "agente tesouraria" — cada taxa cai direto nele, e a
// função buyback & burn que já existe, em modo "gastar o saldo inteiro", faz
// o resto. Nada muda para quem usa o site, e tudo fica público na chain: o
// endereço da tesouraria, cada compra e cada queima.
//
// O que faltava era alguém apertar o botão. Toda execução no app passa por
// aprovação humana e pela senha do keystore, digitada na hora. Aqui, para UM
// agente só, o do operador, o servidor faz isso sozinho, num laço:
//
//   1. o saldo (menos a reserva de gás) passou do mínimo?
//   2. roda o agente, que propõe a compra do saldo inteiro;
//   3. só decisões de buyback_burn que passaram na política são executadas,
//      com a senha vinda de PONS_TREASURY_PASSWORD;
//   4. o resultado vai para a mesma tabela de decisões, como se fosse um
//      clique — o histórico do agente conta a história inteira.
//
// Travas que continuam valendo: PONS_ALLOW_LIVE_EXECUTION (sem ela o laço só
// registra que não pode enviar), manutenção (pausa o laço), e a política do
// agente (reserva de gás, ritmo, profundidade mínima). A política é reescrita
// pelo servidor no boot para o perfil de tesouraria — modo automático e sem
// teto por operação —, porque a tesouraria existe para gastar tudo que entra.
import { getAgent, agentBalances, unlockAgent } from '../wallet/agentWallet.js';
import { enableFunction } from '../functions/index.js';
import { runAgent, approveDecision } from './runner.js';
import { executeDecision } from './executor.js';
import { validatePolicy, DEFAULT_POLICY } from './policy.js';
import { FEE } from './fee.js';
import { formatUnits, parseUnits } from '../market/pricing.js';
import { eqAddress } from '../core/hex.js';

const ETH_1000 = (1000n * 10n ** 18n).toString();

/** Política da tesouraria: automática, sem teto por operação nem por dia. */
export const TREASURY_POLICY = {
  ...DEFAULT_POLICY,
  mode: 'auto',
  maxNotionalPerTradeWei: ETH_1000,
  maxDailyNotionalWei: ETH_1000,
  requireApprovalAboveWei: ETH_1000,
};

/**
 * Lê a configuração do ambiente. Devolve `enabled:false` com o motivo quando
 * faltar algo — o servidor imprime o motivo no boot, para o operador não
 * descobrir semanas depois que a tesouraria nunca rodou.
 */
export function resolveTreasuryConfig(env = process.env) {
  const agentId = String(env.PONS_TREASURY_AGENT ?? '').trim();
  const password = String(env.PONS_TREASURY_PASSWORD ?? '');
  const intervalMin = Number(env.PONS_TREASURY_INTERVAL_MIN ?? 30);
  const minEth = String(env.PONS_TREASURY_MIN_ETH ?? '0.005').trim();

  const off = (problem) => ({ enabled: false, agentId: agentId || null, problem });
  if (!agentId && !password) return { enabled: false, agentId: null, problem: null };   // não configurada, e tudo bem
  if (!agentId) return off('PONS_TREASURY_PASSWORD is set but PONS_TREASURY_AGENT is not — the treasury is OFF');
  if (!password) return off('PONS_TREASURY_AGENT is set but PONS_TREASURY_PASSWORD is not — the treasury is OFF');
  if (!Number.isFinite(intervalMin) || intervalMin < 1) return off(`PONS_TREASURY_INTERVAL_MIN must be a number of minutes >= 1, got "${env.PONS_TREASURY_INTERVAL_MIN}"`);
  if (!/^\d+(\.\d+)?$/.test(minEth)) return off(`PONS_TREASURY_MIN_ETH must be a decimal amount of ETH, got "${minEth}"`);

  return {
    enabled: true,
    agentId,
    password,
    intervalMs: Math.round(intervalMin * 60_000),
    minWei: parseUnits(minEth, 18),
    problem: null,
  };
}

/**
 * Deixa o agente pronto para ser tesouraria: política de tesouraria e a
 * função buyback & burn ligada em "gastar o saldo inteiro". Idempotente —
 * roda em todo boot, e reescreve o que o operador possa ter mexido na tela.
 */
export function prepareTreasuryAgent(db, config) {
  const agent = getAgent(db, config.agentId);
  if (!agent) throw new Error(`treasury agent "${config.agentId}" not found — create it in the app first`);
  if (!agent.target_token) throw new Error(`treasury agent ${agent.id} has no target token — set the token to burn in the app`);

  const policy = validatePolicy(TREASURY_POLICY);
  db.prepare('UPDATE agents SET policy = ? WHERE id = ?').run(JSON.stringify(policy), agent.id);
  enableFunction(db, agent.id, 'buyback_burn', {
    amountEth: '0',
    useFullBalance: true,
    minIntervalMinutes: Math.max(1, Math.round(config.intervalMs / 60_000)),
  });
  return getAgent(db, agent.id);
}

/** Estado vivo do laço, para a tela do operador. Um só por processo. */
const state = {
  enabled: false, problem: null, agentId: null, address: null, token: null,
  intervalMs: null, minWei: null, feeAddressMatches: null,
  runs: 0, executed: 0, failed: 0, lastRunAt: null, nextRunAt: null,
  lastResult: null, lastError: null, lastTxHash: null,
};
export const treasuryStatus = () => ({ ...state, minWei: state.minWei?.toString() ?? null });

/**
 * Uma volta do laço. Devolve um resumo serializável do que aconteceu, e nunca
 * lança: erro aqui é registrado e o laço tenta de novo na próxima volta.
 *
 * `deps` existe para os testes trocarem as partes que falam com a chain.
 */
export async function treasuryTick({
  db, rpc, config, live, maintenanceOn = false, recordExecution,
  log = () => {},
  deps = {},
}) {
  const run = deps.runAgent ?? runAgent;
  const execute = deps.executeDecision ?? executeDecision;
  const balancesOf = deps.agentBalances ?? agentBalances;

  if (maintenanceOn) return { skipped: 'maintenance mode is on' };
  if (!live) return { skipped: 'PONS_ALLOW_LIVE_EXECUTION is not 1 — the treasury can only run live' };

  const agent = getAgent(db, config.agentId);
  if (!agent) return { error: `treasury agent "${config.agentId}" not found` };
  if (!agent.target_token) return { skipped: 'the treasury agent has no target token' };

  const balances = await balancesOf(rpc, agent.address);
  const reserve = BigInt(agent.policy?.reserveGasWei ?? 0);
  const available = balances.eth > reserve ? balances.eth - reserve : 0n;
  if (available < config.minWei) {
    return {
      skipped: `below the minimum: ${formatUnits(available, 18)} ETH available after the gas reserve, ` +
        `buying starts at ${formatUnits(config.minWei, 18)} ETH`,
      availableWei: available.toString(),
    };
  }

  // O agente propõe; a política julga. Só o que passou vira transação.
  const proposed = await run(db, rpc, agent.id, { persist: true });
  const buybacks = proposed.results
    .flatMap((r) => r.decisions ?? [])
    .filter((d) => d.id && d.decision?.kind === 'buyback_burn' && d.verdict?.violations?.length === 0);

  if (!buybacks.length) {
    const notes = proposed.results.flatMap((r) => r.notes ?? []);
    const blocked = proposed.results.flatMap((r) => r.decisions ?? []).flatMap((d) => d.verdict?.violations ?? []);
    return { skipped: 'no buyback passed the policy this round', notes, blocked };
  }

  let unlocked;
  try { unlocked = unlockAgent(db, agent.id, config.password); }
  catch (err) { return { error: `could not unlock the treasury agent: ${err.message}` }; }

  const done = [];
  try {
    for (const d of buybacks) {
      if (d.verdict.needsApproval) approveDecision(db, d.id);
      const trace = [];
      try {
        const result = await execute({
          rpc, db, decision: d.decision,
          agent: { address: unlocked.address, id: unlocked.id },
          privateKey: unlocked.privateKey,
          dryRun: false,
          reserveWei: reserve,
          onStep: (s) => { trace.push({ label: s.label, phase: s.phase, hash: s.hash ?? null }); log(`treasury · ${s.label} · ${s.phase}${s.hash ? ' · ' + s.hash : ''}`); },
        });
        const hash = result.steps.find((x) => x.hash)?.hash ?? null;
        db.prepare('UPDATE decisions SET tx_hash = ? WHERE id = ?').run(hash, d.id);
        recordExecution(db, d.id, { status: 'executed', steps: result.steps.map(serialize) });
        done.push({ id: d.id, hash, notionalWei: d.decision.notionalWei });
      } catch (err) {
        // Falha parcial importa: pode haver transação confirmada antes do erro.
        recordExecution(db, d.id, { status: 'failed', error: err.message, steps: trace });
        return { executed: done, error: `decision ${d.id} stopped: ${err.message}` };
      }
    }
  } finally {
    unlocked.privateKey = null;
  }
  return { executed: done };
}

const serialize = (s) => ({
  label: s.label, hash: s.hash ?? null, skipped: s.skipped ?? null,
  failed: s.failed ?? null, notSimulated: s.notSimulated ?? null, reason: s.reason ?? null,
  gasUsed: s.gasUsed?.toString() ?? null,
});

/**
 * Liga o laço. Devolve `null` quando a tesouraria não está configurada, ou o
 * controle {stop} quando está. Timers são `unref`: o processo não fica vivo
 * só por causa deles.
 */
export function startTreasury({
  db, rpc, live, isMaintenanceOn, recordExecution, log = console.log, env = process.env,
  firstDelayMs = 60_000,
}) {
  const config = resolveTreasuryConfig(env);
  Object.assign(state, { enabled: config.enabled, problem: config.problem, agentId: config.agentId });
  if (!config.enabled) {
    if (config.problem) log(`TREASURY: ${config.problem}`);
    return null;
  }

  let agent;
  try { agent = prepareTreasuryAgent(db, config); }
  catch (err) {
    Object.assign(state, { enabled: false, problem: err.message });
    log(`TREASURY: ${err.message} — the treasury is OFF`);
    return null;
  }

  Object.assign(state, {
    address: agent.address, token: agent.target_token,
    intervalMs: config.intervalMs, minWei: config.minWei,
    feeAddressMatches: !!(FEE.enabled && eqAddress(FEE.address, agent.address)),
  });
  log(`treasury ON · agent ${agent.id} · wallet ${agent.address} · burns ${agent.target_token} · ` +
    `every ${Math.round(config.intervalMs / 60_000)} min from ${formatUnits(config.minWei, 18)} ETH`);
  if (!state.feeAddressMatches) {
    log(`TREASURY WARNING: PONS_FEE_ADDRESS is ${FEE.address ?? 'unset'}, not the treasury wallet ${agent.address}. ` +
      'Fees are NOT reaching the treasury — point PONS_FEE_ADDRESS at the treasury wallet.');
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    state.runs += 1;
    state.lastRunAt = Date.now();
    try {
      const out = await treasuryTick({
        db, rpc, config, live, maintenanceOn: isMaintenanceOn(), recordExecution, log,
      });
      state.lastResult = out;
      state.lastError = out.error ?? null;
      if (out.executed?.length) {
        state.executed += out.executed.length;
        state.lastTxHash = out.executed[out.executed.length - 1].hash ?? state.lastTxHash;
        log(`treasury · ${out.executed.length} buyback(s) sent`);
      }
      if (out.error) { state.failed += 1; log(`treasury · ${out.error}`); }
    } catch (err) {
      state.failed += 1; state.lastError = err.message;
      log(`treasury · unexpected: ${err.message}`);
    } finally {
      running = false;
      state.nextRunAt = Date.now() + config.intervalMs;
    }
  };

  const first = setTimeout(tick, firstDelayMs);
  first.unref?.();
  const timer = setInterval(tick, config.intervalMs);
  timer.unref?.();
  state.nextRunAt = Date.now() + firstDelayMs;

  return {
    stop: () => { clearTimeout(first); clearInterval(timer); },
    tick,
    config,
  };
}
