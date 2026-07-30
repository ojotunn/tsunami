// Restrições impostas pelo próprio protocolo Pons. Ignorá-las faz a transação
// reverter e queimar gás — o agente checa antes de montar qualquer ordem.
import { CONTRACTS, FACTORY_ABI, TOKEN_ABI, abiItem } from '../chain/config.js';

/**
 * Lê a LaunchConfig do token e devolve os limites vigentes:
 *  - maxTxTokens       teto ACUMULADO de compra na pool, por carteira
 *  - maxWalletTokens   teto de saldo por carteira
 *  - restrictions      valem enquanto block <= restrictionsEndBlock, e só para
 *                      compras vindas da pool — transferência comum passa livre
 */
export async function protocolLimits(rpc, token) {
  const launched = await rpc.read(CONTRACTS.factory, abiItem(FACTORY_ABI, 'getLaunchedToken'), [token]);
  if (!launched.exists) throw new Error('this token was not launched by this factory');

  const cfg = await rpc.read(CONTRACTS.factory, abiItem(FACTORY_ABI, 'getLaunchConfig'), [launched.launchConfigId]);
  const head = await rpc.blockNumber();

  // O bloco de lançamento vem do próprio token: durante a janela, compras no
  // bloco de lançamento revertem, e isso não dá para deduzir da LaunchConfig.
  const launchBlock = await rpc
    .read(token, abiItem(TOKEN_ABI, 'launchBlock'), [])
    .then((v) => BigInt(v))
    .catch(() => null);

  const supply = BigInt(launched.supply || cfg.supply);
  const endBlock = BigInt(launched.restrictionsEndBlock);
  // O contrato compara com `<=`, não `<`: no bloco final as restrições ainda valem.
  const active = head <= endBlock;
  return {
    launchBlock,
    isLaunchBlock: launchBlock !== null && head === launchBlock,
    isToken0: launched.isToken0,
    poolFee: Number(launched.poolFee),
    pairedToken: launched.pairedToken,
    positionManager: launched.positionManager,
    positionId: launched.positionId,
    supply,
    restrictionsActive: active,
    restrictionsEndBlock: endBlock,
    blocksUntilFree: active ? endBlock - head + 1n : 0n,
    maxTxTokens: (supply * BigInt(cfg.maxTxBps)) / 10000n,
    maxWalletTokens: (supply * BigInt(cfg.maxWalletBps)) / 10000n,
    routerRequiresDeadline: cfg.routerRequiresDeadline,
    graduationThreshold: BigInt(cfg.graduationThreshold),
  };
}

/** Endereços de router e position manager do DEX usado pelo lançamento. */
export async function dexRouting(rpc, dexId) {
  const cfg = await rpc.read(CONTRACTS.factory, abiItem(FACTORY_ABI, 'getDexConfig'), [dexId]);
  if (!cfg.enabled) throw new Error(`dex ${dexId} is disabled in the factory`);
  return {
    name: cfg.name,
    swapRouter: cfg.swapRouter,
    positionManager: cfg.positionManager,
    v3Factory: cfg.factory,
    poolFee: Number(cfg.poolFee),
    tickSpacing: Number(cfg.tickSpacing),
  };
}

/**
 * Verifica se uma ordem cabe dentro dos limites do protocolo.
 *
 * O que o token realmente faz, lido do `_update` do PonsLauncherToken:
 *
 *   if (from != 0 && to != 0 && block.number <= restrictionEndBlock) {
 *     if (!_isPairPool(from)) { ...segue livre... }        // transferência comum
 *     if (block.number == launchBlock) revert LaunchBlockBuyBlocked;
 *     if (balanceOf(to) + value > maxWalletLimit()) revert MaxWalletExceeded;
 *     if (_restrictedPoolBuys[to] + value > maxTxLimit()) revert MaxTxExceeded;
 *   }
 *
 * Três consequências que a versão anterior deste arquivo errava:
 *
 *  1. A janela de restrição NÃO proíbe comprar. Ela limita o TAMANHO da compra
 *     (5% do supply por carteira, 5,5% acumulado). Eu tratava a janela como
 *     bloqueio total, e com isso o agente recusava ordens de 0,003 ETH — quatro
 *     ordens de grandeza abaixo do teto real. O token estava liberado o tempo
 *     todo; quem bloqueava era eu.
 *  2. Fora da janela não existe limite nenhum. Aplicar maxTx/maxWallet depois
 *     do fim das restrições inventa uma trava que a chain não tem.
 *  3. maxTx é ACUMULADO por destinatário, não por transação. O contrato guarda
 *     isso num mapping privado, sem getter — então aqui usamos o saldo atual
 *     como aproximação. Para a carteira do agente, que só compra, o saldo é o
 *     acumulado; se tokens saírem dela, a estimativa fica otimista, e por isso
 *     o executor ainda simula a transação antes de enviar.
 */
export function checkOrderAgainstLimits({ tokenAmount, currentBalance }, limits) {
  const problems = [];
  if (!limits.restrictionsActive) return problems;   // janela encerrada: sem limites

  if (limits.isLaunchBlock) {
    problems.push('buys from the pool revert on the launch block itself — wait for the next block');
    return problems;
  }

  const amount = BigInt(tokenAmount);
  const balance = BigInt(currentBalance);

  if (limits.maxWalletTokens > 0n && balance + amount > limits.maxWalletTokens) {
    problems.push(
      `resulting balance would be ${balance + amount}, over the maxWallet of ${limits.maxWalletTokens} ` +
      `enforced for another ${limits.blocksUntilFree} blocks`,
    );
  }
  // Aproximação deliberada: o acumulado real é privado. Ver item 3 acima.
  if (limits.maxTxTokens > 0n && balance + amount > limits.maxTxTokens) {
    problems.push(
      `cumulative pool buys would reach ${balance + amount}, over the maxTx of ${limits.maxTxTokens} ` +
      `enforced for another ${limits.blocksUntilFree} blocks`,
    );
  }
  return problems;
}

/** Tamanho máximo de ordem que ainda respeita todos os tetos. */
export function largestAllowedOrder(limits, currentBalance) {
  // Sem janela de restrição não há teto: o contrato não impõe nenhum.
  if (limits.restrictionsActive === false) return limits.supply;
  const byTx = limits.maxTxTokens > 0n ? limits.maxTxTokens - BigInt(currentBalance) : limits.supply;
  const room = limits.maxWalletTokens > 0n ? limits.maxWalletTokens - BigInt(currentBalance) : limits.supply;
  const cap = byTx < room ? byTx : room;
  return cap > 0n ? cap : 0n;
}

export { CONTRACTS };
