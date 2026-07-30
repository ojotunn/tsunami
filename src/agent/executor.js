// Motor de execução: transforma uma decisão aprovada em transações assinadas e
// enviadas, uma de cada vez, parando no primeiro problema.
//
// Regras que valem para toda transação daqui:
//  1. o chainId é conferido contra a rede antes de assinar — assinar para a
//     chain errada é o tipo de erro que só aparece depois de perder o dinheiro;
//  2. nada é enviado sem passar por eth_call primeiro; se a simulação reverte,
//     a transação não sai e o gás não é queimado;
//  3. o saldo precisa cobrir gás + valor, com a reserva da política preservada;
//  4. existe um teto absoluto de preço de gás, para um pico na rede não drenar
//     a carteira do agente numa única transação.
import { CHAIN, CONTRACTS, TOKEN_ABI, BURN_ADDRESS, abiItem } from '../chain/config.js';
import { LOCKER_ABI, lockerItem } from '../chain/locker.js';
import { routerItem, swapParams, wethItem } from '../chain/router.js';
import { encodeFunctionData } from '../core/abi.js';
import { signTransaction, maxCost } from '../chain/tx.js';
import { protocolLimits, dexRouting } from './guards.js';
import { formatUnits } from '../market/pricing.js';

const GAS_BUFFER_BPS = 2500;                    // +25% sobre a estimativa
const MAX_GAS_PRICE_WEI = 500n * 10n ** 9n;     // teto duro: 500 gwei
const RECEIPT_TIMEOUT_MS = 180_000;

export class Executor {
  constructor({ rpc, db, onStep = () => {} }) {
    this.rpc = rpc;
    this.db = db;
    this.onStep = onStep;
    this.nonce = null;
  }

  /** Confere que a RPC aponta para a rede que esperamos. Roda uma vez por execução. */
  async assertChain() {
    const id = await this.rpc.chainId();
    if (id !== CHAIN.id) {
      throw new Error(`RPC is on chain ${id}, expected ${CHAIN.id} — refusing to sign`);
    }
    return id;
  }

  async feeData() {
    const block = await this.rpc.getBlock('latest');
    const baseFee = block?.baseFeePerGas ? BigInt(block.baseFeePerGas) : null;

    let priority = 10n ** 9n;                   // 1 gwei de partida
    try { priority = BigInt(await this.rpc.call('eth_maxPriorityFeePerGas', [])); }
    catch { /* nem toda RPC implementa; o padrão serve */ }

    // Sem EIP-1559 na chain, cai para gasPrice e iguala os dois campos.
    const maxFee = baseFee === null
      ? await this.rpc.gasPrice()
      : baseFee * 2n + priority;

    if (maxFee > MAX_GAS_PRICE_WEI) {
      throw new Error(`gas price of ${formatUnits(maxFee, 9)} gwei is above the ${formatUnits(MAX_GAS_PRICE_WEI, 9)} gwei ceiling`);
    }
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority > maxFee ? maxFee : priority };
  }

  async nextNonce(address) {
    if (this.nonce === null) {
      this.nonce = BigInt(await this.rpc.call('eth_getTransactionCount', [address, 'pending']));
    }
    return this.nonce++;
  }

  /** eth_call obrigatório. Devolve o retorno cru; lança com a razão do revert. */
  async simulate({ from, to, data, value = 0n }) {
    try {
      return await this.rpc.call('eth_call', [{
        from, to, data,
        value: '0x' + BigInt(value).toString(16),
      }, 'latest']);
    } catch (err) {
      throw new Error(`simulation reverted: ${err.message}`);
    }
  }

  async estimateGas({ from, to, data, value = 0n }) {
    const raw = await this.rpc.call('eth_estimateGas', [{
      from, to, data, value: '0x' + BigInt(value).toString(16),
    }]);
    const est = BigInt(raw);
    return est + (est * BigInt(GAS_BUFFER_BPS)) / 10000n;
  }

  /**
   * Simula, estima, assina e envia uma transação. Devolve o recibo.
   * @param {{label:string,to:string,data:string,value?:bigint}} call
   */
  async sendCall(call, { privateKey, from, reserveWei = 0n, dryRun, mayDependOnPrior = false }) {
    const { label, to, data, value = 0n, skipSimulation = false, fixedGasLimit } = call;

    // Um passo que depende do anterior não pode ser simulado antes dele existir.
    //
    // Numa compra são três transações em sequência: envolver ETH em WETH,
    // autorizar o router, e trocar. Num ensaio nada é enviado — então, na hora
    // de simular o swap, a carteira ainda não tem WETH nem allowance, e o
    // router responde `STF` (o safeTransferFrom dele falha). Isso não é um
    // problema da ordem: é a consequência óbvia de perguntar "isso funcionaria
    // agora?" sobre um passo que só faz sentido depois do anterior.
    //
    // Antes eu abortava o ensaio inteiro nesse ponto, o que fazia o buyback
    // parecer quebrado quando estava correto. Agora o passo dependente é
    // marcado como não-simulável no ensaio, com o motivo — e em execução real
    // nada disso se aplica: lá o passo anterior já foi minerado, e a simulação
    // continua obrigatória.
    //
    // A exceção a "nada sem eth_call antes" é uma transferência simples de ETH
    // para carteira comum: não há código no destino que possa reverter, então
    // não há o que simular. E simular faria mal — o eth_call ainda roda a
    // checagem de saldo do cliente, então uma carteira apertada devolveria
    // "simulation reverted: insufficient funds", que é mentira: nada reverteu,
    // faltou dinheiro. A checagem de saldo logo abaixo diz exatamente isso,
    // com os dois números na frente. Mesmo raciocínio que o saque já usa.
    this.onStep({ label, phase: 'simulating' });
    if (skipSimulation) {
      this.onStep({ label, phase: 'simulating', skipped: 'a plain ETH transfer to a wallet has no contract code to simulate' });
    } else if (dryRun && mayDependOnPrior) {
      const probe = await this.simulate({ from, to, data, value }).then(() => null, (e) => e);
      if (probe) {
        this.onStep({ label, phase: 'dry-run', notSimulated: true });
        return {
          dryRun: true, label, notSimulated: true,
          reason: 'depends on the previous step, which a dry run does not send — ' +
            'it will be simulated for real right before it is sent',
        };
      }
    } else {
      await this.simulate({ from, to, data, value });
    }

    // 21000 é o custo exato de uma transferência de ETH, definido pelo
    // protocolo — estimar seria uma ida à RPC para receber esse mesmo número.
    const gasLimit = fixedGasLimit ?? await this.estimateGas({ from, to, data, value });
    const fees = await this.feeData();
    const nonce = dryRun ? 0n : await this.nextNonce(from);

    const tx = {
      chainId: CHAIN.id, nonce, to, data, value: BigInt(value),
      gasLimit, accessList: [], ...fees,
    };

    const cost = maxCost(tx);
    const balance = await this.rpc.getBalance(from);
    if (balance < cost + reserveWei) {
      throw new Error(
        `insufficient balance for ${label}: needs ${formatUnits(cost + reserveWei, 18)} ETH ` +
        `(including reserve), has ${formatUnits(balance, 18)} ETH`,
      );
    }

    if (dryRun) {
      this.onStep({ label, phase: 'dry-run', gasLimit, maxCost: cost });
      return { dryRun: true, label, gasLimit, maxCost: cost };
    }

    const signed = signTransaction(tx, privateKey);
    if (signed.from.toLowerCase() !== from.toLowerCase()) {
      throw new Error('signed transaction does not recover to the agent address — aborting');
    }

    this.onStep({ label, phase: 'sending', hash: signed.hash });
    const hash = await this.rpc.call('eth_sendRawTransaction', [signed.raw]);
    const receipt = await this.waitReceipt(hash);

    if (receipt.status !== '0x1') throw new Error(`${label} reverted on chain (tx ${hash})`);
    this.onStep({ label, phase: 'confirmed', hash, gasUsed: BigInt(receipt.gasUsed) });
    return { hash, receipt, label, gasUsed: BigInt(receipt.gasUsed) };
  }

  async waitReceipt(hash, timeoutMs = RECEIPT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const receipt = await this.rpc.call('eth_getTransactionReceipt', [hash]).catch(() => null);
      if (receipt) return receipt;
      if (Date.now() > deadline) throw new Error(`timed out waiting for receipt of ${hash}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ------------------------------------------------------------ compilação

/**
 * Traduz os passos de uma decisão em chamadas concretas.
 * Comprar exige três transações: envolver ETH em WETH, autorizar o router e
 * fazer o swap. É mais transação do que a rota com msg.value, mas cada etapa é
 * verificável isoladamente — o que importa mais do que economizar gás aqui.
 */
export async function compileDecision({ rpc, decision, agentAddress, token }) {
  const limits = await protocolLimits(rpc, token);
  const dex = await dexRouting(rpc, await dexIdOf(rpc, token));
  const calls = [];

  for (const step of decision.steps ?? []) {
    if (step.action === 'swap' && step.side === 'buy') {
      const amountIn = BigInt(step.amountInWei);

      calls.push({
        label: `wrap ${formatUnits(amountIn, 18)} ETH into WETH`,
        to: CONTRACTS.weth,
        data: encodeFunctionData(wethItem('deposit'), []),
        value: amountIn,
      });

      const allowance = await rpc
        .read(CONTRACTS.weth, wethItem('allowance'), [agentAddress, dex.swapRouter])
        .catch(() => 0n);
      if (allowance < amountIn) {
        calls.push({
          label: 'approve the router to spend WETH',
          to: CONTRACTS.weth,
          data: encodeFunctionData(wethItem('approve'), [dex.swapRouter, amountIn]),
        });
      }

      calls.push({
        label: `swap ${formatUnits(amountIn, 18)} WETH for the token`,
        to: dex.swapRouter,
        data: encodeFunctionData(
          routerItem(limits.routerRequiresDeadline),
          swapParams({
            tokenIn: CONTRACTS.weth, tokenOut: token, fee: limits.poolFee,
            recipient: agentAddress, amountIn,
            amountOutMinimum: BigInt(step.minOutWei ?? 0n),
            requiresDeadline: limits.routerRequiresDeadline,
          }),
        ),
        capturesTokenDelta: true,
        dependsOnPrior: true,   // precisa do WETH e da allowance dos passos acima
      });
      continue;
    }

    if (step.action === 'transfer') {
      calls.push({
        label: step.to.toLowerCase() === BURN_ADDRESS.toLowerCase()
          ? 'send the bought tokens to the burn address'
          : `transfer tokens to ${step.to}`,
        to: token,
        // amountRef 'swap.out' é resolvido em tempo de execução pelo delta de saldo
        amountRef: step.amountRef,
        amountWei: step.amountWei ? BigInt(step.amountWei) : undefined,
        recipient: step.to,
        dependsOnPrior: true,   // move o que o swap trouxe
        buildData: (amount) => encodeFunctionData(abiItem(TOKEN_ABI, 'transfer'), [step.to, amount]),
      });
      continue;
    }

    if (step.action === 'call' && step.method === 'collectFees') {
      calls.push({
        label: 'collect creator rewards from the locker',
        to: CONTRACTS.locker,
        data: encodeFunctionData(lockerItem('collectFees'), step.args),
        // Quanto entrou só se sabe medindo: o locker não devolve o valor para
        // quem chama, e a taxa incide sobre o que de fato chegou.
        capturesEthDelta: true,
      });
      continue;
    }

    // Taxa de serviço do operador. Sempre a última chamada da decisão — ver a
    // justificativa da ordem em agent/fee.js.
    if (step.action === 'pay') {
      const fixed = step.valueWei !== undefined ? BigInt(step.valueWei) : null;

      // Carteira comum ou contrato? Muda duas coisas: carteira comum custa
      // exatamente 21000 e não tem o que simular; contrato pode ter receive()
      // que reverte e consumir muito mais gás.
      //
      // Falha de leitura não vira veredito: sem conseguir checar, tratamos como
      // contrato, que é o caminho conservador (simula e estima de verdade).
      const code = await rpc.call('eth_getCode', [step.to, 'latest']).catch(() => null);
      const isPlainWallet = code === '0x';

      calls.push({
        label: fixed !== null
          ? `service fee — ${formatUnits(fixed, 18, 8)} ETH to ${step.to}`
          : `service fee — ${(step.bps ?? 0) / 100}% of what the collection returns, to ${step.to}`,
        to: step.to,
        data: '0x',
        value: fixed ?? undefined,
        valueRef: step.valueRef,          // resolvido em execução, quando houver
        bps: step.bps,
        optional: step.optional !== false,
        skipSimulation: isPlainWallet,
        fixedGasLimit: isPlainWallet ? 21000n : undefined,
      });
      continue;
    }

    throw new Error(`unknown step: ${JSON.stringify(step)}`);
  }

  return { calls, limits, dex };
}

async function dexIdOf(rpc, token) {
  const { FACTORY_ABI } = await import('../chain/config.js');
  const launched = await rpc.read(CONTRACTS.factory, abiItem(FACTORY_ABI, 'getLaunchedToken'), [token]);
  return launched.dexId;
}

/**
 * Executa uma decisão inteira. Passos com valor derivado do swap (a queima)
 * têm a quantidade resolvida pelo delta de saldo do token, para nunca queimar
 * o inventário que o agente já tinha antes.
 */
export async function executeDecision({
  rpc, db, decision, agent, privateKey, dryRun = true, reserveWei = 0n, onStep = () => {},
}) {
  const executor = new Executor({ rpc, db, onStep });
  await executor.assertChain();

  const token = decision.token;
  const { calls } = await compileDecision({ rpc, decision, agentAddress: agent.address, token });
  const balanceOf = abiItem(TOKEN_ABI, 'balanceOf');

  const results = [];
  let tokenBefore = await rpc.read(token, balanceOf, [agent.address]).catch(() => 0n);
  let swapDelta = 0n;
  let collectedEth = 0n;

  for (const call of calls) {
    let data = call.data;
    let value = call.value ?? 0n;

    // Valor derivado da coleta: a taxa é uma fatia do que o locker devolveu, e
    // isso só existe depois da transação. Nome distinto de `amountRef` de
    // propósito — aquele resolve DADOS de um transfer de token, este resolve o
    // VALOR em ETH de uma transferência simples.
    if (call.valueRef === 'collect.eth') {
      value = (collectedEth * BigInt(call.bps ?? 0)) / 10000n;
      if (value <= 0n) {
        results.push({
          label: call.label,
          skipped: dryRun
            ? 'the fee is a share of what the collection actually returns, which a dry run does not send'
            : 'the collection returned nothing, so there is no fee',
        });
        continue;
      }
    }

    if (call.amountRef === 'swap.out' || call.amountWei !== undefined) {
      const amount = call.amountWei ?? swapDelta;
      if (amount <= 0n) {
        // No ensaio o swap não aconteceu, então não há delta para transferir.
        // Dizer "nada a transferir" aqui soaria como defeito; o certo é dizer
        // que a quantidade só existe depois da compra.
        results.push({
          label: call.label,
          skipped: dryRun
            ? 'amount comes from the swap, which a dry run does not send — it will be the tokens actually received'
            : 'nothing to transfer',
        });
        continue;
      }
      data = call.buildData(amount);
    }

    // Saldos antes, para os passos que medem o que entrou.
    let ethBefore = 0n;
    let wethBefore = 0n;
    if (call.capturesEthDelta && !dryRun) {
      ethBefore = await rpc.getBalance(agent.address).catch(() => 0n);
      wethBefore = await rpc.read(CONTRACTS.weth, wethItem('balanceOf'), [agent.address]).catch(() => 0n);
    }

    let out;
    try {
      out = await executor.sendCall(
        {
          label: call.label, to: call.to, data, value,
          skipSimulation: call.skipSimulation, fixedGasLimit: call.fixedGasLimit,
        },
        { privateKey, from: agent.address, reserveWei, dryRun, mayDependOnPrior: !!call.dependsOnPrior },
      );
    } catch (err) {
      // Passo opcional nunca derruba a decisão. Hoje só a taxa de serviço é
      // opcional, e o motivo é concreto: marcar a decisão como 'failed' tiraria
      // a compra — que aconteceu de verdade — da contagem de orçamento do DCA e
      // do limite diário, que só somam decisões 'executed'. O usuário passaria a
      // poder gastar além do que configurou por causa da nossa cobrança. Se a
      // taxa falha, quem perde é o operador.
      if (!call.optional) throw err;
      results.push({ label: call.label, failed: err.message });
      onStep({ label: call.label, phase: 'failed', reason: err.message });
      continue;
    }
    results.push(out);

    if (call.capturesTokenDelta && !dryRun) {
      const after = await rpc.read(token, balanceOf, [agent.address]).catch(() => tokenBefore);
      swapDelta = after - tokenBefore;
      tokenBefore = after;
      onStep({ label: 'tokens received', phase: 'measured', amount: swapDelta });
    }

    if (call.capturesEthDelta && !dryRun) {
      const ethAfter = await rpc.getBalance(agent.address).catch(() => ethBefore);
      const wethAfter = await rpc.read(CONTRACTS.weth, wethItem('balanceOf'), [agent.address]).catch(() => wethBefore);

      // Duas correções, as duas necessárias:
      //
      //  - somar o gás de volta: ele saiu do mesmo saldo de ETH, mas não é
      //    dinheiro que o agente deixou de receber. Sem isso a taxa sairia
      //    menor do que deveria;
      //  - contar WETH: o par do pool é WETH, então a reward pode chegar
      //    embrulhada. Nesse caso o saldo de ETH só CAI (o gás), e medir só ETH
      //    daria zero — o operador nunca receberia.
      //
      // Recibo sem effectiveGasPrice (nem toda RPC preenche) cai para zero:
      // subestima o coletado e subcobra. Errar a favor do usuário é a direção
      // honesta numa taxa de serviço.
      const gasPrice = out.receipt?.effectiveGasPrice ? BigInt(out.receipt.effectiveGasPrice) : 0n;
      const gasPaid = BigInt(out.gasUsed ?? 0n) * gasPrice;
      const delta = (ethAfter - ethBefore + gasPaid) + (wethAfter - wethBefore);

      collectedEth = delta > 0n ? delta : 0n;
      onStep({ label: 'rewards collected', phase: 'measured', amount: collectedEth });
    }
  }

  return { decision: decision.kind, dryRun, steps: results };
}

export { MAX_GAS_PRICE_WEI, GAS_BUFFER_BPS };

// ------------------------------------------------------------ saque

/**
 * Tira fundos da carteira do agente e manda para outro endereço.
 *
 * Isto existe porque a ferramenta tinha um caminho de entrada e nenhum de
 * saída: dava para depositar no agente e não havia botão para tirar. O usuário
 * perguntou como recuperar o dinheiro, e a resposta honesta era "exporte o
 * keystore e importe na MetaMask" — o que funciona, mas é obrigar alguém a
 * mexer com chave privada para pegar o próprio dinheiro de volta.
 *
 * Duas decisões deliberadas:
 *
 *  - O saque NÃO passa pela trava `PONS_ALLOW_LIVE_EXECUTION`. Essa trava existe
 *    para ninguém ligar negociação automática por acidente. Aplicá-la aqui
 *    significaria que, num servidor com ela desligada, o usuário não consegue
 *    tirar o próprio dinheiro. É o mesmo princípio que já vale na manutenção:
 *    ler agentes e exportar keystore nunca são bloqueados.
 *  - O saque também não passa pela política de risco (limite diário, reserva de
 *    gás, ritmo). Aquilo governa negociação com o capital; devolver o capital
 *    ao dono não é negociação.
 *
 * @param {string|null} amountWei  null = tudo que couber, descontado o gás
 */
export async function withdrawFromAgent({
  rpc, agent, privateKey, to, asset = 'eth', amountWei = null, tokenAddress = null, dryRun = false,
  onStep = () => {},
}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(to || ''))) throw new Error('invalid destination address');
  if (asset === 'token' && !tokenAddress) throw new Error('withdrawing a token requires the token address');

  const executor = new Executor({ rpc, db: null, onStep });
  await executor.assertChain();

  const fees = await executor.feeData();
  const balance = await rpc.getBalance(agent.address);

  if (asset === 'eth') {
    const gasLimit = 21000n;
    const gasCost = gasLimit * fees.maxFeePerGas;
    const requested = amountWei === null ? balance - gasCost : BigInt(amountWei);

    if (requested <= 0n) {
      throw new Error(
        `nothing to withdraw: the balance is ${formatUnits(balance, 18)} ETH and the transfer itself ` +
        `costs up to ${formatUnits(gasCost, 18)} ETH in gas`,
      );
    }
    if (requested + gasCost > balance) {
      throw new Error(
        `cannot withdraw ${formatUnits(requested, 18)} ETH: with up to ${formatUnits(gasCost, 18)} ETH ` +
        `of gas, the most this wallet can send is ${formatUnits(balance - gasCost, 18)} ETH`,
      );
    }

    const tx = {
      chainId: CHAIN.id, nonce: dryRun ? 0n : await executor.nextNonce(agent.address),
      to, data: '0x', value: requested, gasLimit, accessList: [], ...fees,
    };
    if (dryRun) return { dryRun: true, asset: 'eth', to, amount: requested.toString(), gasCost: gasCost.toString() };

    const signed = signTransaction(tx, privateKey);
    if (signed.from.toLowerCase() !== agent.address.toLowerCase()) {
      throw new Error('signed transaction does not recover to the agent address — aborting');
    }
    onStep({ label: 'withdraw ETH', phase: 'sending', hash: signed.hash });
    const hash = await rpc.call('eth_sendRawTransaction', [signed.raw]);
    const receipt = await executor.waitReceipt(hash);
    if (receipt.status !== '0x1') throw new Error(`withdrawal reverted on chain (tx ${hash})`);
    return { asset: 'eth', to, amount: requested.toString(), hash, receipt };
  }

  // token ERC-20
  const balanceOf = abiItem(TOKEN_ABI, 'balanceOf');
  const held = await rpc.read(tokenAddress, balanceOf, [agent.address]);
  const requested = amountWei === null ? held : BigInt(amountWei);
  if (requested <= 0n) throw new Error('the agent holds none of this token');
  if (requested > held) {
    throw new Error(`cannot withdraw ${requested}: the agent holds ${held}`);
  }

  const data = encodeFunctionData(abiItem(TOKEN_ABI, 'transfer'), [to, requested]);
  const call = { label: 'withdraw tokens', to: tokenAddress, data, value: 0n };
  const out = await executor.sendCall(call, { privateKey, from: agent.address, dryRun });
  return { asset: 'token', token: tokenAddress, to, amount: requested.toString(), ...out };
}
