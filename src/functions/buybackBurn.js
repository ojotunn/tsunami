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
import { FEE } from '../agent/fee.js';

export const spec = {
  id: 'buyback_burn',
  label: 'Buyback & burn',
  description: 'Buys the token with the agent balance and sends it to the burn address.',
  needsCapital: true,
  needsDelegation: false,
  params: {
    amountEth: { type: 'decimal', default: '0.005', label: 'ETH per run' },
    minIntervalMinutes: { type: 'int', default: 60, label: 'Minimum interval between runs (min)' },
    // As duas opcoes abaixo existiam so dentro do rewards_boost, que exige a
    // carteira que lancou o token. Aqui nao exige nada: comprar no pool nao
    // pede permissao de ninguem, entao quem opera o token de outra pessoa
    // tambem alcanca esse comportamento.
    afterGraduation: { type: 'bool', default: false, label: 'Only buy after the token graduates' },
    useFullBalance: { type: 'bool', default: false, label: 'Spend the whole balance instead of the amount above' },
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
  const notes = [];

  // Esperar a graduação. Antes dela a pool ainda está na curva de lançamento e
  // uma compra grande move o preço muito mais; quem quer entrar só depois da
  // migração agora não precisa vigiar a tela para isso.
  if (params.afterGraduation && !state.graduated) {
    return { decisions: [], notes: ['waiting for graduation before buying — the token has not migrated yet'] };
  }

  let amountIn = parseUnits(params.amountEth, 18);

  if (params.useFullBalance) {
    // Gastar "tudo" não é gastar o saldo inteiro. Precisa sobrar a reserva de
    // gás da política — senão o agente fica sem como sair de uma posição — e
    // precisa sobrar a taxa de serviço, que sai da mesma carteira logo depois
    // da compra. Sem descontar as duas, a política recusaria a decisão e a
    // opção nunca funcionaria.
    //
    // A conta é sobre o saldo em ETH, não em ETH + WETH: é o saldo em ETH que a
    // política olha na checagem da reserva.
    const reserva = BigInt(ctx.agent?.policy?.reserveGasWei ?? 0);
    const folga = balances.eth - reserva;
    if (folga <= 0n) {
      return {
        decisions: [],
        notes: [`nothing to spend: the ${formatUnits(reserva, 18)} ETH gas reserve already takes the whole balance`],
      };
    }
    // amountIn + taxa <= folga, com taxa = amountIn * bps / 10000
    amountIn = (folga * 10000n) / (10000n + BigInt(FEE.enabled ? FEE.bps : 0));
    notes.push(`spending the whole balance: ${formatUnits(amountIn, 18)} ETH, `
      + `keeping ${formatUnits(reserva, 18)} ETH for gas`
      + (FEE.enabled ? ` and ${formatUnits(folga - amountIn, 18)} ETH for the service fee` : ''));

    const teto = BigInt(ctx.agent?.policy?.maxNotionalPerTradeWei ?? 0);
    if (teto > 0n && amountIn > teto) {
      notes.push(`this is above your per-trade limit of ${formatUnits(teto, 18)} ETH and will be blocked — `
        + 'raise the limit in the policy or turn this option off');
    }
  }

  const spendable = balances.eth + balances.weth;
  if (spendable < amountIn || amountIn <= 0n) {
    return { decisions: [], notes: [...notes, `insufficient balance: has ${formatUnits(spendable, 18)} ETH, needs ${formatUnits(amountIn, 18)}`] };
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
      // O valor sai de `amountIn`, nao do parametro: com "gastar tudo" o
      // parametro nao e o que vai ser gasto, e a tela mentiria.
      rationale: `buyback of ${formatUnits(amountIn, 18)} ETH followed by a burn`,
      steps: [
        { action: 'swap', side: 'buy', amountInWei: amountIn.toString(), minOutWei: withSlippage(sim.amountOut, 100).toString() },
        { action: 'transfer', to: params.burnAddress || BURN_ADDRESS, amountRef: 'swap.out' },
      ],
    }],
    notes,
  };
}

export const withSlippage = (amount, bps) => (BigInt(amount) * BigInt(10000 - bps)) / 10000n;
