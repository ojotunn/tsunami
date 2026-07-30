// Taxa de serviço do operador da instância.
//
// Três regras valem para todo este módulo:
//
//  1. a taxa é SEMPRE em ETH, nunca em token. Cobrar em token corromperia a
//     medição de swapDelta do executor (ele mede quanto o swap trouxe pela
//     diferença de saldo do token) e ainda acumularia inventário ilíquido de
//     terceiros na carteira do operador;
//
//  2. sem PONS_FEE_ADDRESS não existe taxa nenhuma. Quem auto-hospeda não paga
//     nada, e as decisões saem byte a byte iguais às de antes desta
//     funcionalidade — é isso que mantém a suíte antiga intacta;
//
//  3. arredondamento sempre para baixo, a favor do usuário. Divisão de BigInt
//     já faz isso por construção; não trocar por Number em lugar nenhum.
import { isAddress, eqAddress } from '../core/hex.js';
import { NULL_ADDRESS, BURN_ADDRESS } from '../chain/config.js';
import { formatUnits } from '../market/pricing.js';

export const MAX_FEE_BPS = 1000;      // teto duro de 10%, não configurável
export const DEFAULT_FEE_BPS = 500;   // 5%

/** Fatia em bps. Piso por construção: BigInt nunca arredonda para cima. */
export const feeOf = (amountWei, bps) => (BigInt(amountWei) * BigInt(bps)) / 10000n;

/**
 * Lê e valida a configuração da taxa.
 *
 * Recebe o env por parâmetro para poder ser testada sem mexer em process.env.
 * Config inválida NUNCA derruba o processo: devolve `problem` e desliga a taxa.
 * O motivo é o mesmo já escrito no topo de web/operator.js — processo caído
 * impede as pessoas de sacarem o próprio dinheiro, e um erro de digitação no
 * endereço de recebimento não pode ter esse efeito.
 */
export function resolveFeeConfig(env = process.env) {
  const off = (problem) => ({ enabled: false, address: null, bps: 0, problem });

  const address = String(env.PONS_FEE_ADDRESS ?? '').trim();
  const rawBps = String(env.PONS_FEE_BPS ?? DEFAULT_FEE_BPS).trim();

  if (!address) return off(null);   // não configurada é o padrão, não é erro

  if (!isAddress(address)) {
    return off(`PONS_FEE_ADDRESS is not a valid 0x address ("${address.slice(0, 12)}") — the service fee is OFF`);
  }
  if (eqAddress(address, NULL_ADDRESS) || eqAddress(address, BURN_ADDRESS)) {
    return off('PONS_FEE_ADDRESS points at the null or burn address — the service fee is OFF');
  }
  // Regex e não Number: 'ate 5e2' e ' 500 ' viram 500 no Number, e '-1' vira -1.
  if (!/^\d+$/.test(rawBps)) {
    return off(`PONS_FEE_BPS must be a whole number of basis points, got "${rawBps}" — the service fee is OFF`);
  }
  const bps = Number(rawBps);
  if (bps > MAX_FEE_BPS) {
    return off(`PONS_FEE_BPS is ${bps} (${bps / 100}%), above the ${MAX_FEE_BPS / 100}% ceiling this build allows — the service fee is OFF`);
  }
  if (bps === 0) return { enabled: false, address, bps: 0, problem: null };  // desligada de propósito

  return { enabled: true, address, bps, problem: null };
}

export const FEE = resolveFeeConfig();

/**
 * Base de cálculo por tipo de decisão. Kind ausente daqui = não cobra.
 *
 * Consequência deliberada: função nova nasce SEM taxa. A falha é na direção
 * segura — o operador percebe que não está recebendo; o usuário nunca é
 * cobrado por engano.
 *
 * `rewards_buyback_burn` está fora DE PROPÓSITO. Aquele ETH já pagou a taxa na
 * coleta, e rewards.js monta esse kind reaproveitando o plano do buyback_burn:
 * uma regra do tipo "toda compra paga" cobraria duas vezes sobre a mesma
 * reward (5% + 5% sobre o que sobrou = 9,75% efetivos). Pior, o plano do
 * rewards usa o saldo de ETH INTEIRO do agente como reserva a aplicar, então a
 * segunda cobrança cairia também sobre capital que o usuário depositou.
 */
const FEE_BASE = {
  buyback_burn: (d) => BigInt(d.notionalWei ?? 0),
  dca: (d) => BigInt(d.notionalWei ?? 0),
  dip_buy: (d) => BigInt(d.notionalWei ?? 0),
  collect_rewards: () => COLLECT_REF,   // só medível depois da transação
};

/** Sentinela: o valor da taxa só existe depois que a coleta acontecer. */
export const COLLECT_REF = 'collect.eth';

/**
 * Devolve a decisão com o passo de taxa anexado, ou a decisão intacta.
 *
 * O passo vai por ÚLTIMO e é `optional`. Os dois detalhes importam:
 *
 *  - por último porque o tx_hash gravado na tabela `decisions` é o primeiro
 *    hash encontrado; taxa na frente faria o link do explorer de todo buyback
 *    apontar para o pagamento da taxa em vez da compra;
 *
 *  - opcional porque uma falha aqui não pode marcar a decisão como 'failed'.
 *    O orçamento do DCA e o limite diário só somam decisões 'executed'; uma
 *    compra que aconteceu de verdade mas ficou 'failed' por causa da cobrança
 *    sairia da contagem, e o usuário passaria a gastar além do que configurou.
 *    Se a taxa falha, quem perde é o operador.
 */
export function applyFee(decision, { agentAddress, config = FEE, estimateWei = null } = {}) {
  if (!config.enabled) return decision;

  const base = FEE_BASE[decision.kind];
  if (!base) return decision;

  // Taxa apontando para a própria carteira do agente seria uma
  // auto-transferência que passa em tudo — simula, tem saldo, confirma — e só
  // queima 21000 de gás por operação, para sempre. Não dá para pegar isso no
  // boot, porque cada agente tem endereço próprio.
  if (agentAddress && eqAddress(config.address, agentAddress)) return decision;

  const common = { feeBps: config.bps, feeTo: config.address };
  const value = base(decision);

  if (value === COLLECT_REF) {
    // `== null` de propósito: pega null e undefined. Uma decisão sem estimativa
    // ainda cobra a taxa — ela só não tem o que mostrar antes da aprovação.
    const estimate = estimateWei == null ? null : feeOf(estimateWei, config.bps);
    return {
      ...decision,
      ...common,
      feeWei: '0',                       // desconhecido até a coleta acontecer
      feeEstimateWei: estimate === null ? null : estimate.toString(),
      steps: [...(decision.steps ?? []),
        { action: 'pay', to: config.address, valueRef: COLLECT_REF, bps: config.bps, optional: true }],
    };
  }

  const fee = feeOf(value, config.bps);
  if (fee <= 0n) return decision;        // 21000 de gás para mover 0 wei não faz sentido

  return {
    ...decision,
    ...common,
    feeWei: fee.toString(),
    steps: [...(decision.steps ?? []),
      { action: 'pay', to: config.address, valueWei: fee.toString(), optional: true }],
  };
}

/**
 * Frase de divulgação em en-US para as notes da decisão, ou null quando não há
 * taxa. A coleta de rewards tem texto próprio: ali o número é estimativa, e
 * chamar de valor cobrado geraria reclamação quando não batesse.
 */
export function feeNote(decision) {
  if (!decision.feeBps) return null;

  const charged = BigInt(decision.feeWei ?? 0);
  const tail = 'It is paid in ETH to the operator of this instance, never taken from your tokens, '
    + 'and withdrawing your funds is free.';

  if (charged > 0n) {
    return `service fee: ${formatUnits(charged, 18, 8)} ETH (${decision.feeBps / 100}% of the ETH this action spends). ${tail}`;
  }
  if (decision.feeEstimateWei) {
    return `service fee: about ${formatUnits(decision.feeEstimateWei, 18, 8)} ETH `
      + `(${decision.feeBps / 100}% of what this collects) — estimated, and charged on what the collection `
      + `actually returns. ${tail}`;
  }
  return `service fee: ${decision.feeBps / 100}% of what this collection returns. ${tail}`;
}
