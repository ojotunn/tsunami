// Coleta de creator rewards e o "boost": acumular tudo e, depois da graduação,
// aplicar 100% em buyback & burn.
//
// O ponto central desta função é que ela NÃO precisa da chave privada do criador,
// e a coleta é automática de verdade — não "quase".
//
// Pons V1: o locker expõe setFeeRedirect(token, wallet). O criador assina uma
// vez apontando o payout para a carteira do agente. A partir daí duas coisas
// valem ao mesmo tempo, e a segunda é a que fecha o ciclo:
//
//   1. as rewards são pagas na carteira do agente;
//   2. o agente passa a poder CHAMAR collectFees, porque o controle de acesso
//      do locker aceita `msg.sender == recipient` — e o recipient é ele.
//
// Pons V2: não há locker. O criador assina transferCreatorFeeRecipient na
// factory apontando o agente. A partir daí o fee escrow credita o agente
// (`claim()` paga a quem chama) e a curva passa a tê-lo como `deployer`, o que
// autoriza `sweepFees`. Mesma ideia: uma assinatura, coleta autônoma.
//
// Ver os trechos de fonte citados em chain/locker.js e chain/v2.js.
import { CONTRACTS, FACTORY_ABI, abiItem } from '../chain/config.js';
import { feeRecipient, isFeeCollector, previewCollect, delegationCalls, tokensByFeeRecipient } from '../chain/locker.js';
import { detectV2, delegationStatusV2 } from '../chain/v2.js';
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

/**
 * Diagnóstico da delegação: o agente consegue coletar sem a chave do criador?
 * Pergunta primeiro à V2 (um lançamento V2 não existe para o locker V1); se a
 * factory V2 não conhece o token, segue o caminho do locker.
 */
export async function delegationStatus(rpc, { token, agentAddress }) {
  const v2 = await detectV2(rpc, token).catch(() => null);
  if (v2) return delegationStatusV2(rpc, { launch: v2, agentAddress });

  const [recipient, collector, preview] = await Promise.all([
    feeRecipient(rpc, token).catch(() => null),
    isFeeCollector(rpc, agentAddress).catch(() => false),
    previewCollect(rpc, token, agentAddress).catch((e) => ({ authorized: false, reason: e.message })),
  ]);

  const redirected = recipient && recipient.toLowerCase() === agentAddress.toLowerCase();
  return {
    version: 'v1',
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
  if (status.version === 'v2') return planV2(ctx, params, status, notes, decisions);

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

  await planDeploy(ctx, params, { graduated, notes, decisions });
  return { decisions, notes, status };
}

/**
 * Pons v2. A coleta são até duas transações — varrer a curva para o escrow e
 * sacar do escrow — e a compra, quando houver, é na própria curva. Depois da
 * graduação o token negocia numa pool Uniswap V4, onde este projeto ainda não
 * compra: o ETH coletado fica na carteira do agente, sacável a qualquer hora.
 */
async function planV2(ctx, params, status, notes, decisions) {
  const { token } = ctx;
  const threshold = parseUnits(params.minCollectWei, 18);

  notes.push(`pons v2 launch · ${status.phaseName}`);
  if (!status.redirectedToAgent) {
    notes.push('creator fees for this launch do not point at the agent yet — sign transferCreatorFeeRecipient once to enable it');
    if (status.feeRecipient) notes.push(`current recipient: ${status.feeRecipient}`);
  } else if (status.canCollectNow) {
    notes.push('the agent can collect on its own: the fee escrow credits the recipient, and that is the agent');
  } else if (status.reason) {
    notes.push(status.reason);
  }

  const inEscrow = status.pending?.inEscrow ?? 0n;
  const onCurve = status.pending?.onCurve ?? 0n;
  const pendingPair = inEscrow + (status.canSweep ? onCurve : 0n);
  if (inEscrow > 0n || onCurve > 0n) {
    notes.push(`pending rewards: ${formatUnits(inEscrow, 18)} ETH claimable in the escrow` +
      (onCurve > 0n ? ` + ~${formatUnits(onCurve, 18)} ETH still on the curve` : ''));
  }
  if (onCurve > 0n && status.redirectedToAgent && !status.canSweep && !status.phase) {
    notes.push('this launch has buybacks enabled, so only the pons operator sweeps its curve; the agent claims what reaches the escrow');
  }

  if (pendingPair >= threshold && status.canCollectNow) {
    const steps = [];
    if (status.canSweep && onCurve > 0n) {
      steps.push({ action: 'call', to: status.curve?.curve, method: 'sweepFees', args: [] });
    }
    steps.push({ action: 'call', to: CONTRACTS.v2FeeEscrow, method: 'claimEscrow', args: [] });
    decisions.push({
      kind: 'collect_rewards',
      token,
      notionalWei: '0',
      pendingPairWei: pendingPair.toString(),
      priceImpactBps: 0,
      rationale: `collect ${formatUnits(pendingPair, 18)} ETH of creator rewards from the fee escrow`,
      steps,
    });
  }

  const graduated = !!status.phase;
  if (status.curve && !graduated) {
    notes.push(`graduation: ${formatUnits(status.curve.realQuoteReserve, 18)} / ${formatUnits(status.curve.graduationThreshold, 18)} ETH raised on the curve`);
  }

  await planDeploy(ctx, params, { graduated, notes, decisions, v2: true });
  return { decisions, notes, status };
}

/** O que fazer com o ETH já na carteira: segurar, ou comprar e queimar. */
async function planDeploy(ctx, params, { graduated, notes, decisions, v2 = false }) {
  const reserve = ctx.balances.eth;
  const deployable = (reserve * BigInt(params.deployPercent)) / 100n;

  if (params.mode === 'reserve_until_graduation' && !graduated) {
    notes.push('reserve mode: accumulating until graduation, no buying yet');
    if (v2) {
      notes.push('note: after graduation this launch trades on Uniswap v4, where this tool cannot buy yet — ' +
        'switch to "burn_immediately" to buy on the bonding curve now');
    }
  } else if (params.mode !== 'collect_only' && deployable > 0n) {
    if (v2 && graduated) {
      notes.push('the launch has graduated to Uniswap v4; buying there is not supported yet, so the collected ETH stays ' +
        'in the agent wallet (withdraw anytime)');
      return;
    }
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
}

export { tokensByFeeRecipient };
