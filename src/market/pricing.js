// Matemática de preço e profundidade para pools Uniswap V3.
// Convenção: sqrtPriceX96 = sqrt(token1/token0) * 2^96, em unidades brutas.

export const Q96 = 2n ** 96n;
export const Q192 = 2n ** 192n;
const SCALE = 10n ** 18n;                       // precisão fixa interna (18 casas)

const pow10 = (n) => 10n ** BigInt(n);

/**
 * Preço de token1 em token0 (unidades humanas), com 18 casas de precisão.
 * @returns {bigint} preço * 1e18
 */
export function priceToken1PerToken0(sqrtPriceX96, decimals0, decimals1) {
  const sp = BigInt(sqrtPriceX96);
  return (sp * sp * SCALE * pow10(decimals0)) / (Q192 * pow10(decimals1));
}

/**
 * Preço do token do lançamento denominado no token do par (ex.: WETH).
 * @returns {bigint} preço * 1e18
 */
export function tokenPriceInPair({ sqrtPriceX96, isToken0, tokenDecimals, pairDecimals }) {
  if (isToken0) return priceToken1PerToken0(sqrtPriceX96, tokenDecimals, pairDecimals);
  const p = priceToken1PerToken0(sqrtPriceX96, pairDecimals, tokenDecimals);
  if (p === 0n) return 0n;
  return (SCALE * SCALE) / p;
}

/** Market cap em token do par, escalado por 1e18. */
export const marketCapInPair = (priceScaled, totalSupply, tokenDecimals) =>
  (priceScaled * BigInt(totalSupply)) / pow10(tokenDecimals);

/** tick -> preço (float, só para exibição). */
export const tickToPrice = (tick) => Math.pow(1.0001, Number(tick));
/** preço -> tick mais próximo, alinhado ao tickSpacing. */
export function priceToTick(price, tickSpacing = 200) {
  const raw = Math.log(price) / Math.log(1.0001);
  return Math.round(raw / tickSpacing) * tickSpacing;
}

/** Direção do trade a partir de um evento Swap, conforme docs da Pons. */
export function swapSide({ amount0, amount1, isToken0 }) {
  const pairSigned = isToken0 ? BigInt(amount1) : BigInt(amount0);
  return pairSigned > 0n ? 'buy' : 'sell';   // par entrando no pool = compra do token
}

/** Valor absoluto do lado do par (quanto de WETH trocou de mãos). */
export const swapPairVolume = ({ amount0, amount1, isToken0 }) => {
  const v = isToken0 ? BigInt(amount1) : BigInt(amount0);
  return v < 0n ? -v : v;
};

// ------------------------------------------------------- profundidade

/**
 * Simula um swap assumindo liquidez L constante na faixa ativa.
 * Válido para as posições full-range criadas pela Pons; degrada se o preço
 * atravessar limites de faixa — por isso `crossedRangeRisk` é sinalizado.
 *
 * @param {'buy'|'sell'} side  buy = entra token do par, sai token do lançamento
 * @returns {{amountOut: bigint, sqrtPriceX96After: bigint, priceImpactBps: number}}
 */
export function simulateSwap({ sqrtPriceX96, liquidity, amountIn, side, isToken0, feePips = 10000 }) {
  const L = BigInt(liquidity);
  if (L === 0n) throw new Error('pool has no active liquidity');
  const sp = BigInt(sqrtPriceX96);
  const inAfterFee = (BigInt(amountIn) * BigInt(1_000_000 - feePips)) / 1_000_000n;

  // "token do par sobe de preço o token" => o par é token1 quando o token é token0
  const pairIsToken1 = isToken0;
  const addingToken1 = side === 'buy' ? pairIsToken1 : !pairIsToken1;

  let spAfter;
  let amountOut;
  if (addingToken1) {
    // ΔY = L * Δ√P  =>  √P' = √P + ΔY/L
    spAfter = sp + (inAfterFee * Q96) / L;
    // ΔX = L * Q96 * (√P' - √P) / (√P' * √P)
    amountOut = (L * Q96 * (spAfter - sp)) / (spAfter * sp);
  } else {
    // adicionando token0: √P' = 1 / (1/√P + ΔX/L)
    const denom = (L * Q96) / sp + inAfterFee;
    spAfter = (L * Q96) / denom;
    amountOut = (L * (sp - spAfter)) / Q96;
  }

  const impact = sp === 0n ? 0 : Number(((spAfter > sp ? spAfter - sp : sp - spAfter) * 20000n) / sp);
  return {
    amountOut,
    sqrtPriceX96After: spAfter,
    priceImpactBps: impact,                  // aprox: 2 * Δ√P/√P em bps
    crossedRangeRisk: impact > 2000,         // >20% de impacto: simulação pouco confiável
  };
}

/** Quanto do token do par é preciso para mover o preço em `bps`. */
export function pairAmountForMove({ sqrtPriceX96, liquidity, bps, isToken0 }) {
  const sp = BigInt(sqrtPriceX96);
  const L = BigInt(liquidity);
  const target = sp + (sp * BigInt(bps)) / 20000n;      // Δ√P ≈ √P * bps/2 /10000
  const delta = target - sp;
  return isToken0 ? (L * delta) / Q96 : (L * Q96 * delta) / (target * sp);
}

// ------------------------------------------------------- formatação

export function formatUnits(value, decimals = 18, precision = 6) {
  const v = BigInt(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = pow10(decimals);
  const int = abs / base;
  let frac = (abs % base).toString().padStart(decimals, '0').slice(0, precision).replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}`;
}

export function parseUnits(text, decimals = 18) {
  const [i, f = ''] = String(text).split('.');
  return BigInt(i + f.padEnd(decimals, '0').slice(0, decimals));
}
