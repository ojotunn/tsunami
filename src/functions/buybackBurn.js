// Buyback & burn: usa ETH do agente para comprar o token no pool e envia o
// resultado para um endereço sem chave conhecida.
//
// Honestidade obrigatória aqui: o token da Pons NÃO tem função burn(). Enviar
// para 0x…dEaD tira as moedas de circulação, mas totalSupply() continua 1B para
// sempre. Qualquer site ou explorador que calcule market cap por totalSupply não
// vai refletir a queima. Por isso o módulo devolve `circulatingSupply` e o painel
// mostra os dois números.
import { BURN_ADDRESS, NULL_ADDRESS, TOKEN_ABI, abiItem } from '../chain/config.js';
import { simulateSwap, formatUnits, parseUnits } from '../market/pricing.js';

export const spec = {
  id: 'buyback_burn',
  label: 'Buyback & burn',
  description: 'Buys the token with the agent balance and sends it to the burn address.',
  needsCapital: true,
  needsDelegation: false,
  params: {
    amountEth: { type: 'decimal', default: '0.005', label: 'ETH per run' },
    minIntervalMinutes: { type: 'int', default: 60, label: 'Minimum interval between runs (min)' },
    burnAddress: { type: 'address', default: BURN_ADDRESS, label: 'Burn address' },
  },
};

/** Supply realmente em circulação = total − queimado − preso no endereço nulo. */
export async function circulatingSupply(rpc, token, totalSupply, burnAddress = BURN_ADDRESS) {
  const balanceOf = abiItem(TOKEN_ABI, 'balanceOf');
  const res = await rpc.readMany([
    { address: token, item: balanceOf, args: [burnAddress] },
    { address: token, item: balanceOf, args: [NULL_ADDRESS] },
  ]);
  const burned = (res[0].ok ? res[0].value : 0n) + (res[1].ok ? res[1].value : 0n);
  return { total: BigInt(totalSupply), burned, circulating: BigInt(totalSupply) - burned };
}

export async function plan(ctx, params) {
  const { token, state, balances } = ctx;
  const amountIn = parseUnits(params.amountEth, 18);
  const notes = [];

  const spendable = balances.eth + balances.weth;
  if (spendable < amountIn) {
    return { decisions: [], notes: [`insufficient balance: has ${formatUnits(spendable, 18)} ETH, needs ${params.amountEth}`] };
  }

  const sim = simulateSwap({
    sqrtPriceX96: state.sqrtPriceX96, liquidity: state.liquidity, amountIn,
    side: 'buy', isToken0: state.isToken0, feePips: state.poolFee ?? 10000,
  });

  if (sim.crossedRangeRisk) notes.push('order is large for this pool depth; the estimate loses accuracy');

  const supply = ctx.supply ?? null;
  if (supply) {
    notes.push(`circulating supply today: ${formatUnits(supply.circulating, state.decimals ?? 18, 0)} ` +
      `of ${formatUnits(supply.total, state.decimals ?? 18, 0)} (burned: ${formatUnits(supply.burned, state.decimals ?? 18, 0)})`);
  }
  notes.push('totalSupply() does not change when you burn — the pons token has no burn()');

  return {
    decisions: [{
      kind: 'buyback_burn',
      token,
      side: 'buy',
      notionalWei: amountIn.toString(),
      priceImpactBps: sim.priceImpactBps,
      expectedTokensOut: sim.amountOut.toString(),
      rationale: `buyback of ${params.amountEth} ETH followed by a burn`,
      steps: [
        { action: 'swap', side: 'buy', amountInWei: amountIn.toString(), minOutWei: withSlippage(sim.amountOut, 100).toString() },
        { action: 'transfer', to: params.burnAddress || BURN_ADDRESS, amountRef: 'swap.out' },
      ],
    }],
    notes,
  };
}

export const withSlippage = (amount, bps) => (BigInt(amount) * BigInt(10000 - bps)) / 10000n;
