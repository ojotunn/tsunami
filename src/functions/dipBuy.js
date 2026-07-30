// Compra em quedas: o agente compra quando o preço cai X% em relação à maior
// cotação das últimas horas.
//
// A referência é a MÁXIMA da janela, não o último preço. Se fosse o último,
// qualquer oscilação de um minuto pareceria queda e dispararia compra.
//
// Os parâmetros já foram um mini-idioma: `10:0.002, 20:0.004, 35:0.008` numa
// caixa de texto, significando três degraus de compra. Era poderoso e ilegível
// — ninguém que não tivesse escrito o parser adivinharia a sintaxe, e errar a
// pontuação virava erro de validação em vez de compra. Agora são dois números
// em português claro: de quanto é a queda, e quanto comprar. Um degrau só.
import { parseUnits, formatUnits, simulateSwap, tokenPriceInPair } from '../market/pricing.js';
import { withSlippage } from './buybackBurn.js';

export const spec = {
  id: 'dip_buy',
  label: 'Dip buying',
  description: 'Buys when the price falls below its recent high by the percentage you choose.',
  needsCapital: true,
  needsDelegation: false,
  params: {
    dropPercent: { type: 'int', default: 10, label: 'Buy when the price falls this much (%)' },
    amountEth: { type: 'decimal', default: '0.002', label: 'How much ETH to spend each time' },
    windowHours: { type: 'int', default: 24, label: 'Compare against the highest price of the last (hours)' },
    cooldownMinutes: { type: 'int', default: 180, label: 'Wait at least this long between buys (minutes)' },
    destination: { type: 'enum', options: ['hold', 'burn'], default: 'hold', label: 'Where the tokens go' },
  },
};

/**
 * Aceita ainda o formato antigo de escada (`10:0.002, 20:0.004`) para não quebrar
 * agentes configurados antes desta simplificação. Configuração salva de alguém
 * não deve parar de funcionar porque a tela mudou.
 */
export function parseLadder(text) {
  return String(text).split(',').map((part) => {
    const [drop, eth] = part.trim().split(':');
    const dropBps = Math.round(Number(drop) * 100);
    if (!Number.isFinite(dropBps) || !eth) throw new Error(`invalid ladder step: "${part.trim()}"`);
    return { dropBps, amountEth: eth.trim() };
  }).sort((a, b) => a.dropBps - b.dropBps);
}

/** Um degrau vindo dos campos simples, ou a escada antiga se ela existir. */
function stepsFrom(params) {
  if (params.ladder) return parseLadder(params.ladder);
  return [{ dropBps: Math.round(Number(params.dropPercent) * 100), amountEth: String(params.amountEth) }];
}

/** Máxima e mínima de preço na janela, a partir dos snapshots e swaps indexados. */
export function referencePrice(db, token, windowHours, decimals = 18) {
  const since = Math.floor(Date.now() / 1000) - windowHours * 3600;
  const rows = db.prepare(
    'SELECT price_pair FROM snapshots WHERE token = ? AND ts >= ? ORDER BY ts',
  ).all(token.toLowerCase(), since);

  const swaps = db.prepare(`
    SELECT s.sqrt_price, t.is_token0, t.decimals FROM swaps s
    JOIN tokens t ON t.pool = s.pool
    WHERE t.address = ? AND s.block > 0 ORDER BY s.block DESC LIMIT 500
  `).all(token.toLowerCase());

  const prices = rows.map((r) => BigInt(r.price_pair || '0')).filter((p) => p > 0n);
  for (const s of swaps) {
    try {
      prices.push(tokenPriceInPair({
        sqrtPriceX96: BigInt(s.sqrt_price), isToken0: !!s.is_token0,
        tokenDecimals: s.decimals ?? decimals, pairDecimals: 18,
      }));
    } catch { /* snapshot inconsistente, ignora */ }
  }
  if (!prices.length) return null;
  return {
    high: prices.reduce((a, b) => (b > a ? b : a)),
    low: prices.reduce((a, b) => (b < a ? b : a)),
    samples: prices.length,
  };
}

export async function plan(ctx, params) {
  const { db, agent, token, state, balances } = ctx;
  const notes = [];
  const ladder = stepsFrom(params);

  const ref = referencePrice(db, token, params.windowHours, state.decimals ?? 18);
  if (!ref || ref.high === 0n) {
    return { decisions: [], notes: ['there is no price history yet for this window — leave the agent running for a while and try again'] };
  }

  const now = state.pricePair;
  const dropBps = Number(((ref.high - now) * 10000n) / ref.high);
  notes.push(
    `now ${formatUnits(now, 18, 12)} ETH · highest in ${params.windowHours}h: ${formatUnits(ref.high, 18, 12)} ETH ` +
    `· that is ${(dropBps / 100).toFixed(2)}% below the high`,
  );

  if (dropBps <= 0) return { decisions: [], notes: [...notes, 'price is at the window high — nothing to do'] };

  const step = [...ladder].reverse().find((s) => dropBps >= s.dropBps);
  if (!step) {
    return { decisions: [], notes: [...notes, `the drop has not reached ${ladder[0].dropBps / 100}% yet — no buy`] };
  }

  const last = db.prepare("SELECT ts FROM decisions WHERE agent_id = ? AND kind = 'dip_buy' ORDER BY ts DESC LIMIT 1")
    .get(agent.id);
  if (last && Math.floor(Date.now() / 1000) - last.ts < params.cooldownMinutes * 60) {
    return { decisions: [], notes: [...notes, `waiting: the last dip buy was less than ${params.cooldownMinutes} minutes ago`] };
  }

  const amountIn = parseUnits(step.amountEth, 18);
  if (balances.eth < amountIn) {
    return { decisions: [], notes: [...notes, `the ${step.dropBps / 100}% drop was reached, but the agent only has ${formatUnits(balances.eth, 18)} ETH`] };
  }

  const sim = simulateSwap({
    sqrtPriceX96: state.sqrtPriceX96, liquidity: state.liquidity, amountIn,
    side: 'buy', isToken0: state.isToken0, feePips: state.poolFee ?? 10000,
  });

  const steps = [{ action: 'swap', side: 'buy', amountInWei: amountIn.toString(), minOutWei: withSlippage(sim.amountOut, 150).toString() }];
  if (params.destination === 'burn') {
    steps.push({ action: 'transfer', to: '0x000000000000000000000000000000000000dEaD', amountRef: 'swap.out' });
  }

  return {
    decisions: [{
      kind: 'dip_buy',
      token,
      side: 'buy',
      notionalWei: amountIn.toString(),
      priceImpactBps: sim.priceImpactBps,
      expectedTokensOut: sim.amountOut.toString(),
      rationale: `the price is ${(dropBps / 100).toFixed(2)}% below the ${params.windowHours}h high, ` +
        `past the ${step.dropBps / 100}% you set — buying ${step.amountEth} ETH`,
      steps,
    }],
    notes,
  };
}
