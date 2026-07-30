// Coleta de creator rewards e o "boost": acumular tudo e, depois da graduação,
// aplicar 100% em buyback & burn.
//
// O ponto central desta função é que ela NÃO precisa da chave privada do criador,
// e a coleta é automática de verdade — não "quase".
//
// O locker expõe setFeeRedirect(token, wallet). O criador assina uma vez apontando
// o payout para a carteira do agente. A partir daí duas coisas valem ao mesmo
// tempo, e a segunda é a que fecha o ciclo:
//
//   1. as rewards são pagas na carteira do agente;
//   2. o agente passa a poder CHAMAR collectFees, porque o controle de acesso
//      do locker aceita `msg.sender == recipient` — e o recipient é ele.
//
// Ou seja: uma assinatura habilita coleta autônoma. Ver o trecho da fonte citado
// em chain/locker.js, em delegationCalls.
import { CONTRACTS, FACTORY_ABI, abiItem } from '../chain/config.js';
import { feeRecipient, isFeeCollector, previewCollect, delegationCalls, tokensByFeeRecipient } from '../chain/locker.js';
import { formatUnits, parseUnits } from '../market/pricing.js';
import { plan as planBuyback } from './buybackBurn.js';

export const spec = {
  id: 'rewards_boost',
  label: 'Creator rewards → buyback & burn',
  description: 'Collects creator rewards, holds them in reserve, and after graduation puts 100% into buy and burn.',
  needsCapital: false,
  needsDelegation: true,
  params: {
    mode: { type: 'enum', options: ['reserve_until_graduation', 'burn_immediately', 'collect_only'], default: 'reserve_until_graduation', label: 'What to do with rewards' },
    deployPercent: { type: 'int', default: 100, label: '% of rewards spent on buyback' },
    minCollectWei: { type: 'decimal', default: '0.002', label: 'Only collect above (ETH)' },
    checkIntervalMinutes: { type: 'int', default: 240, label: 'Check interval (min)' },
  },
};

/** Diagnóstico da delegação: o agente consegue coletar sem a chave do criador? */
export async function delegationStatus(rpc, { token, agentAddress }) {
  const [recipient, collector, preview] = await Promise.all([
    feeRecipient(rpc, token).catch(() => null),
    isFeeCollector(rpc, agentAddress).catch(() => false),
    previewCollect(rpc, token, agentAddress).catch((e) => ({ authorized: false, reason: e.message })),
  ]);

  const redirected = recipient && recipient.toLowerCase() === agentAddress.toLowerCase();
  return {
    feeRecipient: recipient,
    redirectedToAgent: redirected,
    agentIsCollector: !!collector,
    canCollectNow: preview.authorized,
    pending: preview.authorized ? { amount0: preview.amount0, amount1: preview.amount1 } : null,
    reason: preview.reason,
    setupNeeded: redirected ? [] : delegationCalls({ token, agentAddress }),
  };
}

export async function plan(ctx, params) {
  const { rpc, token, agent, state } = ctx;
  const notes = [];
  const decisions = [];

  const status = await delegationStatus(rpc, { token, agentAddress: agent.address });
  if (!status.redirectedToAgent) {
    notes.push('rewards for this token do not point at the agent yet — sign setFeeRedirect once to enable it');
    if (status.feeRecipient) notes.push(`current payout: ${status.feeRecipient}`);
  }
  if (status.redirectedToAgent && status.canCollectNow) {
    notes.push('the agent can collect on its own: the locker authorizes the redirect recipient, and that is the agent');
  } else if (!status.canCollectNow) {
    notes.push(`the agent is not authorized to call collectFees${status.reason ? `: ${status.reason}` : ''}`);
  }

  // Quanto está acumulado na posição travada
  const pendingPair = status.pending
    ? (state.isToken0 ? status.pending.amount1 : status.pending.amount0)
    : 0n;
  const threshold = parseUnits(params.minCollectWei, 18);

  if (pendingPair > 0n) notes.push(`pending rewards: ${formatUnits(pendingPair, 18)} ETH`);

  if (pendingPair >= threshold && status.canCollectNow) {
    decisions.push({
      kind: 'collect_rewards',
      token,
      notionalWei: '0',
      // Estimativa do que está acumulado, para a taxa de serviço poder ser
      // mostrada antes da aprovação. NÃO é o valor cobrado: entre o plano e a
      // execução há aprovação humana, e nesse intervalo as fees acumulam ou
      // outro autorizado pode coletar antes. Cobrar sobre esta estimativa
      // cobraria sobre ETH que talvez não venha; o valor real é medido depois.
      pendingPairWei: pendingPair.toString(),
      priceImpactBps: 0,
      rationale: `collect ${formatUnits(pendingPair, 18)} ETH of creator rewards`,
      steps: [{ action: 'call', to: CONTRACTS.locker, method: 'collectFees', args: [token] }],
    });
  }

  // Graduação: só depois dela a reserva vira buyback
  const grad = await rpc.read(CONTRACTS.factory, abiItem(FACTORY_ABI, 'graduationStatus'), [token])
    .catch(() => null);
  const graduated = grad?.graduated ?? state.graduated ?? false;
  if (grad) {
    notes.push(`graduation: ${formatUnits(grad.pairedPrincipal, 18)} / ${formatUnits(grad.threshold, 18)} ETH` +
      `${graduated ? ' — graduated ✓' : ''}`);
  }

  const reserve = ctx.balances.eth;
  const deployable = (reserve * BigInt(params.deployPercent)) / 100n;

  if (params.mode === 'reserve_until_graduation' && !graduated) {
    notes.push('reserve mode: accumulating until graduation, no buying yet');
  } else if (params.mode !== 'collect_only' && deployable > 0n) {
    const buyback = await planBuyback(
      { ...ctx, balances: { ...ctx.balances, eth: deployable } },
      { amountEth: formatUnits(deployable, 18), burnAddress: undefined },
    );
    decisions.push(...buyback.decisions.map((d) => ({
      ...d,
      kind: 'rewards_buyback_burn',
      rationale: `put ${params.deployPercent}% of rewards (${formatUnits(deployable, 18)} ETH) into buy and burn`,
    })));
    notes.push(...buyback.notes);
  }

  return { decisions, notes, status };
}

export { tokensByFeeRecipient };
