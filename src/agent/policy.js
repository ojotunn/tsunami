// Política de risco do agente. Tudo que a camada de execução puder fazer
// precisa passar por aqui primeiro — o agente de IA propõe, a política decide.

export const DEFAULT_POLICY = {
  // --- capital -----------------------------------------------------------
  minFundingWei: '1000000000000000',      // 0.001 ETH mínimo para ativar
  maxNotionalPerTradeWei: '10000000000000000',  // 0.01 ETH por operação
  maxDailyNotionalWei: '100000000000000000',    // 0.1 ETH por dia
  reserveGasWei: '2000000000000000',      // nunca gastar abaixo desta reserva

  // --- risco de mercado --------------------------------------------------
  maxSlippageBps: 100,
  minPoolLiquidityWei: '50000000000000000', // ignora pools sem profundidade
  maxDrawdownBps: 2000,                   // 20% de queda do NAV pausa o agente
  maxInventoryBps: 6000,                  // no máx. 60% do NAV no token

  // --- ritmo -------------------------------------------------------------
  maxTradesPerHour: 6,
  minSecondsBetweenTrades: 120,

  // --- governança --------------------------------------------------------
  mode: 'propose',                        // 'propose' | 'auto'
  requireApprovalAboveWei: '5000000000000000',
  allowedTokens: [],                      // vazio = qualquer token indexado
  blockedTokens: [],
  killSwitch: false,
};

/** wei -> ETH legível. Sem dependência: a política não importa nada de fora. */
const fmtEth = (wei) => {
  const v = BigInt(wei);
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
};

const BIG_FIELDS = [
  'minFundingWei', 'maxNotionalPerTradeWei', 'maxDailyNotionalWei',
  'reserveGasWei', 'minPoolLiquidityWei', 'requireApprovalAboveWei',
];

export function validatePolicy(policy) {
  const p = { ...policy };
  for (const f of BIG_FIELDS) {
    if (p[f] === undefined) throw new Error(`incomplete policy: ${f}`);
    p[f] = BigInt(p[f]).toString();
  }
  if (!['propose', 'auto'].includes(p.mode)) throw new Error("mode must be 'propose' or 'auto'");
  if (BigInt(p.maxNotionalPerTradeWei) > BigInt(p.maxDailyNotionalWei)) {
    throw new Error('maxNotionalPerTradeWei cannot exceed maxDailyNotionalWei');
  }
  return p;
}

/**
 * Avalia uma decisão proposta pelo agente contra a política e o estado atual.
 * Retorna sempre uma lista de violações — vazia significa aprovado.
 */
export function evaluate(decision, ctx) {
  const p = ctx.policy;
  const v = [];

  if (p.killSwitch) v.push('kill switch is on');
  if (decision.notionalWei !== undefined) {
    const n = BigInt(decision.notionalWei);
    // Taxa de serviço, quando houver. Ausente = 0, e aí a conta inteira fica
    // idêntica à de antes da taxa existir.
    const fee = BigInt(decision.feeWei ?? 0);

    // Os limites de notional continuam olhando SÓ o notional: taxa não é
    // exposição de mercado, e somá-la aqui encolheria em silêncio o orçamento
    // de todo agente já salvo.
    if (n > BigInt(p.maxNotionalPerTradeWei)) v.push(`notional ${n} exceeds the per-trade limit`);
    if (BigInt(ctx.spentTodayWei ?? 0) + n > BigInt(p.maxDailyNotionalWei)) v.push('daily notional limit exceeded');

    // A reserva de gás, sim, olha a saída TOTAL de ETH. Ela existe para o
    // agente sempre conseguir sair de uma posição, e a taxa também sai da
    // carteira. Sem isso a decisão passaria na aprovação e só estouraria no
    // meio da execução, com o WETH já embrulhado.
    //
    // Diz o número que resolve, não só que está errado. "eat into the gas
    // reserve" deixa a pessoa adivinhando quanto cabe; o teto é uma subtração.
    const balance = BigInt(ctx.ethBalanceWei ?? 0);
    const reserve = BigInt(p.reserveGasWei);
    if (balance - (n + fee) < reserve) {
      const room = balance > reserve ? balance - reserve : 0n;
      v.push(
        `this would eat into the gas reserve — balance ${fmtEth(balance)} ETH minus the ` +
        `${fmtEth(reserve)} ETH reserved for gas` +
        (fee > 0n ? ` minus the ${fmtEth(fee)} ETH service fee` : '') +
        ` leaves at most ${fmtEth(room)} ETH per trade` +
        (room === 0n ? '. Deposit more ETH into the agent wallet.' : ''),
      );
    }
  }
  if (ctx.poolLiquidityWei !== undefined && BigInt(ctx.poolLiquidityWei) < BigInt(p.minPoolLiquidityWei)) {
    v.push('pool liquidity below the minimum');
  }
  if (ctx.drawdownBps !== undefined && ctx.drawdownBps > p.maxDrawdownBps) v.push('maximum drawdown reached');
  if (ctx.inventoryBps !== undefined && decision.side === 'buy' && ctx.inventoryBps > p.maxInventoryBps) {
    v.push('token inventory above the cap');
  }
  // "trades" aqui significa operações ENVIADAS. Quem passa esse contador é o
  // runner, e ele conta só decisões com status 'executed' — simular não gasta
  // nada e não pode consumir cota.
  if (ctx.tradesLastHour >= p.maxTradesPerHour) {
    v.push(`hourly trade limit reached (${ctx.tradesLastHour} of ${p.maxTradesPerHour} executed in the last hour)`);
  }
  if (ctx.secondsSinceLastTrade !== undefined && ctx.secondsSinceLastTrade < p.minSecondsBetweenTrades) {
    v.push('minimum interval between trades not met');
  }
  if (p.blockedTokens.map((t) => t.toLowerCase()).includes(String(decision.token).toLowerCase())) {
    v.push('token is on the block list');
  }
  if (p.allowedTokens.length && !p.allowedTokens.map((t) => t.toLowerCase()).includes(String(decision.token).toLowerCase())) {
    v.push('token is not on the allow list');
  }

  const needsApproval = p.mode === 'propose'
    || (decision.notionalWei !== undefined && BigInt(decision.notionalWei) >= BigInt(p.requireApprovalAboveWei));

  return { violations: v, approved: v.length === 0, needsApproval };
}

/** Registra a decisão para auditoria antes de qualquer execução. */
export function recordDecision(db, agentId, decision, verdict) {
  const info = db.prepare(`INSERT INTO decisions (agent_id, ts, token, kind, rationale, payload, risk, status)
                           VALUES (?,?,?,?,?,?,?,?)`)
    .run(agentId, Math.floor(Date.now() / 1000), decision.token ?? null, decision.kind,
      decision.rationale ?? null, JSON.stringify(decision), JSON.stringify(verdict),
      verdict.violations.length ? 'rejected' : (verdict.needsApproval ? 'pending_approval' : 'approved'));
  return Number(info.lastInsertRowid);
}
