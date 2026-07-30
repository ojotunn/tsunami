// Compras pequenas e programadas num intervalo definido pelo usuário.
//
// Duas coisas que o painel deixa explícitas para quem liga esta função:
//  1. A fee do pool é 1%. Cada compra perde 1% na entrada. Um DCA de 24 compras
//     por dia entrega ao pool ~24% do capital ao ano só em taxas.
//  2. DCA com capital real é uma estratégia de tesouraria legítima. O que ele NÃO
//     faz é "criar volume": trades do próprio dono não são demanda, e um gráfico
//     movimentado por uma única carteira é identificável on-chain por qualquer um.
import { parseUnits, formatUnits, simulateSwap } from '../market/pricing.js';
import { withSlippage } from './buybackBurn.js';

export const spec = {
  id: 'dca',
  label: 'Scheduled buys (DCA)',
  description: 'Buys a fixed amount on a regular interval, with a per-order impact ceiling.',
  needsCapital: true,
  needsDelegation: false,
  params: {
    amountEth: { type: 'decimal', default: '0.002', label: 'ETH per buy' },
    intervalMinutes: { type: 'int', default: 720, label: 'Interval between buys (min)' },
    totalBudgetEth: { type: 'decimal', default: '0.1', label: 'Total program budget (ETH)' },
    destination: { type: 'enum', options: ['hold', 'burn'], default: 'hold', label: 'Where bought tokens go' },
  },
};

/** Quanto o programa já gastou, a partir das decisões executadas. */
export function spentSoFar(db, agentId, kind = 'dca') {
  const rows = db.prepare(
    "SELECT payload FROM decisions WHERE agent_id = ? AND kind = ? AND status = 'executed'",
  ).all(agentId, kind);
  return rows.reduce((sum, r) => {
    try { return sum + BigInt(JSON.parse(r.payload).notionalWei ?? 0); } catch { return sum; }
  }, 0n);
}

export function lastRunAt(db, agentId, kind) {
  const row = db.prepare(
    'SELECT ts FROM decisions WHERE agent_id = ? AND kind = ? ORDER BY ts DESC LIMIT 1',
  ).get(agentId, kind);
  return row?.ts ?? 0;
}

export function isDue(db, agentId, kind, intervalMinutes, now = Math.floor(Date.now() / 1000)) {
  return now - lastRunAt(db, agentId, kind) >= intervalMinutes * 60;
}

export async function plan(ctx, params) {
  const { db, agent, token, state, balances } = ctx;
  const notes = [];
  const amountIn = parseUnits(params.amountEth, 18);
  const budget = parseUnits(params.totalBudgetEth, 18);
  const spent = spentSoFar(db, agent.id, 'dca');

  if (spent + amountIn > budget) {
    return { decisions: [], notes: [`program budget exhausted: ${formatUnits(spent, 18)} of ${params.totalBudgetEth} ETH`] };
  }
  if (!isDue(db, agent.id, 'dca', params.intervalMinutes)) {
    const mins = Math.ceil((params.intervalMinutes * 60 - (Math.floor(Date.now() / 1000) - lastRunAt(db, agent.id, 'dca'))) / 60);
    return { decisions: [], notes: [`next buy in about ${mins} min`] };
  }
  if (balances.eth < amountIn) {
    return { decisions: [], notes: [`insufficient balance: ${formatUnits(balances.eth, 18)} ETH`] };
  }

  const sim = simulateSwap({
    sqrtPriceX96: state.sqrtPriceX96, liquidity: state.liquidity, amountIn,
    side: 'buy', isToken0: state.isToken0, feePips: state.poolFee ?? 10000,
  });

  const perDay = (24 * 60) / params.intervalMinutes;
  const feeCostYear = parseUnits(params.amountEth, 18) * BigInt(Math.round(perDay * 365)) / 100n;
  notes.push(`estimated pool fees alone at this cadence: ~${formatUnits(feeCostYear, 18, 4)} ETH per year`);
  notes.push(`budget remaining: ${formatUnits(budget - spent - amountIn, 18)} ETH`);

  const steps = [{ action: 'swap', side: 'buy', amountInWei: amountIn.toString(), minOutWei: withSlippage(sim.amountOut, 100).toString() }];
  if (params.destination === 'burn') {
    steps.push({ action: 'transfer', to: '0x000000000000000000000000000000000000dEaD', amountRef: 'swap.out' });
  }

  return {
    decisions: [{
      kind: 'dca',
      token,
      side: 'buy',
      notionalWei: amountIn.toString(),
      priceImpactBps: sim.priceImpactBps,
      expectedTokensOut: sim.amountOut.toString(),
      rationale: `scheduled buy of ${params.amountEth} ETH (every ${params.intervalMinutes} min)`,
      steps,
    }],
    notes,
  };
}
