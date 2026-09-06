// Pons V2 — bonding curve + Uniswap V4.
//
// Na V2 um lançamento não nasce como pool. Nasce numa CURVA que segura o supply
// inteiro; a pool V4 só existe na graduação. Isso muda três coisas para o agente:
//
//  1. onde se compra: antes da graduação, direto na curva (`buy` com ETH como
//     value); depois, numa pool V4 — que exige um router com callback, e este
//     projeto ainda não tem;
//  2. onde as creator rewards ficam: não há Locker. As taxas acumulam na curva,
//     são varridas para o FEE ESCROW (`sweepFees`), e o criador saca do escrow
//     com `claim()`, que paga ETH nativo a quem chama;
//  3. como se delega: o recebedor das taxas muda com
//     `transferCreatorFeeRecipient(token, novo)` na factory, assinado pelo
//     recebedor atual. É imediato, sem timelock — o timelock que existe na
//     factory é para a troca forçada pelo dono do protocolo, não para esta.
//
// Lido no fonte verificado da PonsV2LaunchFactory (Blockscout) e em
// docs.ponsfamily.com/docs/v2. Na curva, `sweepFees` aceita o operador do
// protocolo OU o `deployer` da curva — e `setCreatorFeeRecipient` reescreve o
// `deployer` da curva com o novo recebedor. Logo, depois da delegação o agente
// vira o `deployer` da curva e consegue varrer sozinho.
import { CONTRACTS, NULL_ADDRESS } from './config.js';
import { eqAddress } from '../core/hex.js';

export const V2 = {
  factory: CONTRACTS.v2Factory,
  feeEscrow: CONTRACTS.v2FeeEscrow,
  memeHook: CONTRACTS.v2MemeHook,
};

/** Fases do lançamento, na ordem do enum da factory. */
export const V2_PHASES = ['bonding curve', 'swept', 'uniswap v4 pool', 'rescued'];

const addr = (name) => ({ name, type: 'address' });
const u256 = (name) => ({ name, type: 'uint256' });
const bool = (name) => ({ name, type: 'bool' });
const view = (name, inputs, outputs) => ({ type: 'function', name, stateMutability: 'view', inputs, outputs });

export const V2_FACTORY_ABI = [
  view('getLaunchedToken', [addr('token')], [{
    name: '', type: 'tuple', components: [
      addr('token'), addr('curve'), addr('deployer'), addr('creatorFeeRecipient'), addr('pairToken'),
      u256('graduationThreshold'), { name: 'poolFee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' },
      { name: 'creatorTaxBps', type: 'uint16' }, bool('buybackEnabled'), { name: 'phase', type: 'uint8' },
      u256('sweptQuote'), u256('sweptTokens'), u256('sweptAt'), bool('exists'),
    ],
  }]),
  view('launchConfigCount', [], [u256('')]),
  view('getLaunchConfig', [u256('id')], [{
    name: '', type: 'tuple', components: [
      u256('supply'), u256('curveFeeBps'), u256('phantomQuote'), u256('graduationThreshold'),
      { name: 'poolFee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, bool('enabled'),
    ],
  }]),
  view('getLaunchFeePolicy', [addr('token')], [{
    name: '', type: 'tuple', components: [
      addr('protocolFeeRecipient'), { name: 'protocolFeeShareBps', type: 'uint16' },
      { name: 'buybackBurnBps', type: 'uint16' }, { name: 'hookFeeBps', type: 'uint16' },
      { name: 'maxInternalPriceImpactBps', type: 'uint16' },
    ],
  }]),
  view('launchFee', [], [u256('')]),
  view('launchEnabled', [], [bool('')]),
  view('feeEscrow', [], [addr('')]),
  view('memeHook', [], [addr('')]),
  {
    type: 'function', name: 'transferCreatorFeeRecipient', stateMutability: 'nonpayable',
    inputs: [addr('token'), addr('newRecipient')], outputs: [],
  },
  {
    type: 'event', name: 'CreatorFeeRecipientUpdated', anonymous: false, inputs: [
      { indexed: true, name: 'token', type: 'address' },
      { indexed: true, name: 'previousRecipient', type: 'address' },
      { indexed: true, name: 'newRecipient', type: 'address' },
    ],
  },
];

export const CURVE_ABI = [
  {
    type: 'function', name: 'buy', stateMutability: 'payable',
    inputs: [u256('quoteIn'), u256('minTokensOut'), addr('recipient')], outputs: [u256('tokensOut')],
  },
  {
    type: 'function', name: 'sell', stateMutability: 'nonpayable',
    inputs: [u256('tokensIn'), u256('minQuoteOut'), addr('recipient')], outputs: [u256('quoteOut')],
  },
  { type: 'function', name: 'sweepFees', stateMutability: 'nonpayable', inputs: [u256('minBuybackTokensOut')], outputs: [] },
  view('getReserves', [], [u256('quoteReserve'), u256('tokenReserve')]),
  view('realQuoteReserve', [], [u256('')]),
  view('quoteReserve', [], [u256('')]),
  view('tokenReserve', [], [u256('')]),
  view('sellableTokens', [], [u256('')]),
  view('reservedTokens', [], [u256('')]),
  view('graduationThreshold', [], [u256('')]),
  view('feeBps', [], [u256('')]),
  view('creatorTaxBps', [], [u256('')]),
  view('currentSnipeTaxBps', [addr('recipient')], [u256('')]),
  view('graduated', [], [bool('')]),
  view('readyToGraduate', [], [bool('')]),
  view('isNativeQuote', [], [bool('')]),
  view('buybackEnabled', [], [bool('')]),
  view('pairToken', [], [addr('')]),
  view('deployer', [], [addr('')]),
  {
    type: 'event', name: 'CurveBuy', anonymous: false, inputs: [
      { indexed: true, name: 'buyer', type: 'address' },
      { indexed: true, name: 'recipient', type: 'address' },
      { indexed: false, name: 'quoteIn', type: 'uint256' },
      { indexed: false, name: 'tokensOut', type: 'uint256' },
      { indexed: false, name: 'fee', type: 'uint256' },
      { indexed: false, name: 'tax', type: 'uint256' },
    ],
  },
  {
    type: 'event', name: 'FeesSwept', anonymous: false, inputs: [
      { indexed: false, name: 'protocolAmount', type: 'uint256' },
      { indexed: false, name: 'buybackAmount', type: 'uint256' },
      { indexed: false, name: 'creatorAmount', type: 'uint256' },
    ],
  },
];

export const ESCROW_ABI = [
  view('balanceOf', [addr('recipient')], [u256('')]),
  view('balanceOfToken', [addr('recipient'), addr('token')], [u256('')]),
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [], outputs: [u256('amount')] },
  { type: 'function', name: 'claimToken', stateMutability: 'nonpayable', inputs: [addr('token')], outputs: [u256('amount')] },
];

export const v2Item = (abi, name, type = 'function') =>
  abi.find((i) => i.name === name && i.type === type) ?? (() => { throw new Error(`ABI v2: ${name} not found`); })();

const factoryItem = (n) => v2Item(V2_FACTORY_ABI, n);
const curveItem = (n) => v2Item(CURVE_ABI, n);
const escrowItem = (n) => v2Item(ESCROW_ABI, n);

/** Falha de transporte (rede, timeout, 429) — não é resposta do contrato. */
const isTransport = (err) =>
  !!err?.transport || err?.httpStatus !== undefined ||
  /rate limit|HTTP \d{3}|failed after|fetch failed|timeout|aborted/i.test(err?.message || '');

/**
 * O token foi lançado pela factory V2? Devolve o registro do lançamento, ou
 * `null` quando a factory não o conhece. Falha de rede é relançada: "não sei"
 * e "não é" levam a conselhos opostos, e quem chama precisa distinguir.
 */
export async function detectV2(rpc, token) {
  let launched;
  try {
    launched = await rpc.read(V2.factory, factoryItem('getLaunchedToken'), [token]);
  } catch (err) {
    if (isTransport(err)) throw err;
    return null;                     // revert limpo: a factory realmente não conhece o token
  }
  if (!launched?.exists) return null;
  const phase = Number(launched.phase ?? 0);
  return {
    version: 'v2',
    token: launched.token,
    curve: launched.curve,
    deployer: launched.deployer,
    creatorFeeRecipient: launched.creatorFeeRecipient,
    pairToken: launched.pairToken,
    nativeQuote: !launched.pairToken || eqAddress(launched.pairToken, NULL_ADDRESS),
    graduationThreshold: BigInt(launched.graduationThreshold ?? 0),
    poolFee: Number(launched.poolFee ?? 0),
    tickSpacing: Number(launched.tickSpacing ?? 0),
    creatorTaxBps: Number(launched.creatorTaxBps ?? 0),
    buybackEnabled: !!launched.buybackEnabled,
    phase,
    phaseName: V2_PHASES[phase] ?? `phase ${phase}`,
    graduated: phase !== 0,
  };
}

/**
 * Estado da curva num instante: reservas de precificação, o que ainda está à
 * venda, as taxas e quanto de fee ainda não foi varrido para o escrow.
 *
 * `unswept` = saldo físico da curva − realQuoteReserve. A doc define
 * realQuoteReserve como "o que foi coletado e ainda está retido, líquido de
 * taxas"; a diferença para o saldo é exatamente o que uma varredura levaria.
 */
export async function curveState(rpc, curve, { recipient = NULL_ADDRESS } = {}) {
  const reads = [
    'getReserves', 'realQuoteReserve', 'sellableTokens', 'reservedTokens', 'graduationThreshold',
    'feeBps', 'creatorTaxBps', 'graduated', 'readyToGraduate', 'buybackEnabled', 'deployer',
  ].map((n) => ({ address: curve, item: curveItem(n) }));
  reads.push({ address: curve, item: curveItem('currentSnipeTaxBps'), args: [recipient] });

  const [r, real, sellable, reserved, threshold, feeBps, taxBps, graduated, ready, buyback, deployer, snipe] =
    await rpc.readMany(reads);
  if (!r.ok) throw new Error(`could not read the bonding curve reserves: ${r.error}`);

  const balance = await rpc.getBalance(curve).catch(() => 0n);
  const realQuote = real.ok ? BigInt(real.value) : 0n;
  const unswept = balance > realQuote ? balance - realQuote : 0n;

  return {
    curve,
    quoteReserve: BigInt(r.value.quoteReserve),
    tokenReserve: BigInt(r.value.tokenReserve),
    realQuoteReserve: realQuote,
    sellable: sellable.ok ? BigInt(sellable.value) : 0n,
    reserved: reserved.ok ? BigInt(reserved.value) : 0n,
    graduationThreshold: threshold.ok ? BigInt(threshold.value) : 0n,
    feeBps: feeBps.ok ? BigInt(feeBps.value) : 0n,
    creatorTaxBps: taxBps.ok ? BigInt(taxBps.value) : 0n,
    snipeBps: snipe.ok ? BigInt(snipe.value) : 0n,
    graduated: graduated.ok ? !!graduated.value : false,
    readyToGraduate: ready.ok ? !!ready.value : false,
    buybackEnabled: buyback.ok ? !!buyback.value : false,
    curveDeployer: deployer.ok ? deployer.value : null,
    balance,
    unswept,
  };
}

const BPS = 10_000n;
const ceilDiv = (a, b) => (a + b - 1n) / b;

/**
 * Cotação de compra na curva — a MESMA aritmética do contrato, na mesma ordem
 * inteira (docs.ponsfamily.com/docs/v2, "Getting a quote"). Sem chamada de
 * rede: a curva não expõe função de cotação, e reproduzir a conta é o jeito
 * de a proposta bater com o que a transação liquida.
 *
 * Taxas saem da ENTRADA (fee, creator tax, snipe tax), e só o resto move a
 * curva. Uma compra que cruzaria a alocação reservada é preenchida até a
 * borda e o excedente devolvido na mesma transação.
 *
 * @returns {{tokensOut, spent, refund, priceImpactBps, crossedRangeRisk, spotPriceWei, effectivePriceWei}}
 */
export function quoteCurveBuy({ quoteIn, quoteReserve, tokenReserve, sellable, feeBps, creatorTaxBps, snipeBps = 0n }) {
  const amountOut = (i, rIn, rOut) => (i * rOut) / (rIn + i);
  const amountIn = (o, rIn, rOut) => (o * rIn) / (rOut - o) + 1n;

  const R = BigInt(quoteReserve);
  const T = BigInt(tokenReserve);
  const S = BigInt(sellable);
  const fee = BigInt(feeBps);
  const tax = BigInt(creatorTaxBps);
  let snipe = BigInt(snipeBps);
  if (T === 0n || R === 0n) throw new Error('the bonding curve has no reserves');

  // A snipe tax é limitada para o comprador sempre ficar com ao menos 1%.
  if (snipe > 0n) {
    const maxSnipe = BPS - fee - tax - 100n;
    if (snipe > maxSnipe) snipe = maxSnipe;
  }

  let spent = BigInt(quoteIn);
  const feeAmt = (spent * fee) / BPS;
  const taxAmt = (spent * tax) / BPS;
  const snipeAmt = (spent * snipe) / BPS;
  let net = spent - feeAmt - taxAmt - snipeAmt;
  let tokensOut = amountOut(net, R, T);

  if (tokensOut > S) {
    tokensOut = S;
    net = amountIn(S, R, T);
    const grossed = ceilDiv(net * BPS, BPS - fee - tax - snipe);
    spent = grossed < BigInt(quoteIn) ? grossed : BigInt(quoteIn);
  }

  // Impacto no preço à vista, comparável ao que o simulador V3 devolve
  // (variação do preço, não da raiz): preço' = (R+net)² / (R·T).
  const after = R + net;
  const priceImpactBps = Number(((after * after - R * R) * BPS) / (R * R));

  return {
    tokensOut,
    spent,
    refund: BigInt(quoteIn) - spent,
    priceImpactBps,
    crossedRangeRisk: priceImpactBps > 2000,
    spotPriceWei: (R * 10n ** 18n) / T,                                   // ETH por token, escala 1e18
    effectivePriceWei: tokensOut > 0n ? (spent * 10n ** 18n) / tokensOut : 0n,
  };
}

/** Preço à vista de um token na curva, na mesma escala de tokenPriceInPair (1e18). */
export const curveSpotPrice = ({ quoteReserve, tokenReserve }) =>
  BigInt(tokenReserve) === 0n ? 0n : (BigInt(quoteReserve) * 10n ** 18n) / BigInt(tokenReserve);

/**
 * Quanto de creator reward este endereço tem a receber: o que já está no
 * escrow (sacável agora) mais o que ainda está na curva à espera de varredura.
 * A parte na curva só vira dinheiro depois de `sweepFees` — e só o recebedor
 * atual (ou o operador da pons) pode varrer.
 */
export async function pendingRewardsV2(rpc, { recipient, launch, curve = null }) {
  const escrow = BigInt(await rpc.read(V2.feeEscrow, escrowItem('balanceOf'), [recipient]).catch(() => 0n));
  let onCurve = 0n;
  if (!launch.graduated) {
    const cs = curve ?? await curveState(rpc, launch.curve, { recipient }).catch(() => null);
    if (cs) {
      // A varredura reparte entre protocolo e criador; a parte do criador é o
      // que resta depois do share do protocolo (30% hoje). A creator tax vai
      // inteira ao criador, mas o saldo não-varrido não separa as duas — então
      // esta estimativa é conservadora: usa só a fatia do criador sobre tudo.
      const policy = await rpc.read(V2.factory, factoryItem('getLaunchFeePolicy'), [launch.token]).catch(() => null);
      const protocolBps = policy ? BigInt(policy.protocolFeeShareBps) : 3000n;
      onCurve = (cs.unswept * (BPS - protocolBps)) / BPS;
    }
  }
  return { inEscrow: escrow, onCurve, total: escrow + onCurve, native: launch.nativeQuote };
}

/**
 * A ÚNICA assinatura que habilita a delegação na V2: o recebedor atual das
 * taxas aponta o agente como novo recebedor, na factory. A partir daí:
 *  - o escrow credita o agente, e `claim()` paga a quem chama — o agente;
 *  - a curva passa a ter o agente como `deployer`, e `sweepFees` aceita o
 *    deployer — o agente varre sozinho.
 * Reversível a qualquer momento: o agente (ou quem o opera) aponta de volta.
 */
export function delegationCallsV2({ token, agentAddress }) {
  return [{
    label: 'point the creator fee recipient at the agent',
    to: V2.factory,
    item: factoryItem('transferCreatorFeeRecipient'),
    args: [token, agentAddress],
    note: 'signed once by the wallet that currently receives this launch\'s creator fees (pons v2). ' +
      'From then on the fee escrow credits the agent wallet, and the agent can sweep and claim on its own. ' +
      'The agent can point it back at you whenever you want to undo it.',
  }];
}

/** Diagnóstico da delegação V2: o agente consegue sacar as rewards sozinho? */
export async function delegationStatusV2(rpc, { launch, agentAddress }) {
  const redirected = eqAddress(launch.creatorFeeRecipient, agentAddress);
  const curve = launch.graduated ? null : await curveState(rpc, launch.curve, { recipient: agentAddress }).catch(() => null);
  const pending = await pendingRewardsV2(rpc, { recipient: agentAddress, launch, curve });

  let reason;
  if (!redirected) {
    reason = `the fee escrow pays ${launch.creatorFeeRecipient}, not the agent — sign transferCreatorFeeRecipient once`;
  } else if (!launch.nativeQuote) {
    reason = `this launch is paired with ${launch.pairToken}, not ETH; the agent only handles ETH rewards`;
  }

  return {
    version: 'v2',
    phase: launch.phase,
    phaseName: launch.phaseName,
    feeRecipient: launch.creatorFeeRecipient,
    redirectedToAgent: redirected,
    agentIsCollector: redirected,                 // na V2 recebedor e coletor são a mesma coisa
    canCollectNow: redirected && launch.nativeQuote,
    canSweep: redirected && !launch.graduated && !launch.buybackEnabled,
    pending: { inEscrow: pending.inEscrow, onCurve: pending.onCurve },
    reason,
    setupNeeded: redirected ? [] : delegationCallsV2({ token: launch.token, agentAddress }),
    curve,
  };
}

export { factoryItem as v2FactoryItem, curveItem, escrowItem, CONTRACTS as V1_CONTRACTS };
