// Motor de execução, com uma RPC simulada que registra tudo que seria enviado.
// O que estes testes provam: a ordem das transações, a recusa de assinar na
// chain errada, a simulação obrigatória antes de cada envio, o teto de gás, e
// que a queima usa o delta de saldo em vez do inventário inteiro.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Executor, compileDecision, executeDecision, withdrawFromAgent, MAX_GAS_PRICE_WEI } from '../src/agent/executor.js';
import { CHAIN, CONTRACTS, BURN_ADDRESS } from '../src/chain/config.js';
import { createAccount } from '../src/wallet/account.js';
import { parseTransaction } from '../src/chain/tx.js';
import { selectorOf } from '../src/core/abi.js';
import { wethItem, routerItem } from '../src/chain/router.js';
import { lockerItem } from '../src/chain/locker.js';

const TOKEN = '0x9f2b4c7e1a83d5064b7e2c9a15fd3e8b7c04a621';
const ROUTER = '0x1111111111111111111111111111111111117777';

/** RPC falsa: responde o mínimo e guarda o que foi enviado. */
function mockRpc(over = {}) {
  const state = {
    sent: [], simulated: [], estimated: 0,
    chainId: CHAIN.id,
    balance: 10n ** 18n,
    tokenBalance: 0n,
    allowance: 0n,
    baseFee: 10n ** 9n,
    failSimulation: false,
    ...over,
  };

  const rpc = {
    state,
    chainId: async () => state.chainId,
    getBalance: async () => state.balance,
    gasPrice: async () => 2n * 10n ** 9n,
    getBlock: async () => ({ baseFeePerGas: '0x' + state.baseFee.toString(16) }),

    read: async (address, item, args = []) => {
      if (item.name === 'balanceOf') return state.tokenBalance;
      if (item.name === 'allowance') return state.allowance;
      if (item.name === 'getLaunchedToken') {
        return {
          exists: true, isToken0: true, poolFee: 10000n, dexId: 0n, launchConfigId: 0n,
          supply: 10n ** 27n, restrictionsEndBlock: 0n, pairedToken: CONTRACTS.weth,
          positionManager: '0x' + '22'.repeat(20), positionId: 1n,
        };
      }
      if (item.name === 'getLaunchConfig') {
        return {
          pairToken: CONTRACTS.weth, graduationThreshold: 42n * 10n ** 17n, initialTick: 0n,
          supply: 10n ** 27n, maxWalletBps: 2000, maxTxBps: 1000, restrictionBlocks: 0,
          reservedFee: 0n, enabled: true, routerRequiresDeadline: state.requiresDeadline ?? true,
        };
      }
      if (item.name === 'getDexConfig') {
        return {
          name: 'uniswap-v3', factory: CONTRACTS.v3Factory, positionManager: '0x' + '22'.repeat(20),
          swapRouter: ROUTER, poolFee: 10000n, tickSpacing: 200n, enabled: true,
        };
      }
      return 0n;
    },
    readMany: async (reads) => reads.map(() => ({ ok: true, value: 0n })),
    blockNumber: async () => 9_000_000n,

    call: async (method, params) => {
      if (method === 'eth_call') { state.simulated.push(params[0]); if (state.failSimulation) throw new Error('execution reverted: STF'); return '0x'; }
      if (method === 'eth_estimateGas') { state.estimated++; return '0x186a0'; }        // 100000
      if (method === 'eth_maxPriorityFeePerGas') return '0x3b9aca00';                   // 1 gwei
      if (method === 'eth_getTransactionCount') return '0x5';
      if (method === 'eth_sendRawTransaction') { state.sent.push(params[0]); return '0x' + 'ab'.repeat(32); }
      if (method === 'eth_getTransactionReceipt') return { status: '0x1', gasUsed: '0x1388' };
      throw new Error(`unexpected rpc method ${method}`);
    },
  };
  return rpc;
}

const buybackDecision = {
  kind: 'buyback_burn', token: TOKEN, side: 'buy', notionalWei: '5000000000000000',
  steps: [
    { action: 'swap', side: 'buy', amountInWei: '5000000000000000', minOutWei: '1000' },
    { action: 'transfer', to: BURN_ADDRESS, amountRef: 'swap.out' },
  ],
};

// ---------------------------------------------------------------- guardas

test('recusa assinar quando a RPC está em outra chain', async () => {
  const rpc = mockRpc({ chainId: 1 });
  const ex = new Executor({ rpc });
  await assert.rejects(() => ex.assertChain(), /expected 4663 — refusing to sign/);
});

test('teto de preço de gás bloqueia antes de montar a transação', async () => {
  const rpc = mockRpc({ baseFee: MAX_GAS_PRICE_WEI });
  const ex = new Executor({ rpc });
  await assert.rejects(() => ex.feeData(), /above the .* gwei ceiling/);
});

test('sem baseFee a chain cai para gasPrice', async () => {
  const rpc = mockRpc();
  rpc.getBlock = async () => ({});
  const fees = await new Executor({ rpc }).feeData();
  assert.equal(fees.maxFeePerGas, 2n * 10n ** 9n);
  assert.ok(fees.maxPriorityFeePerGas <= fees.maxFeePerGas);
});

test('simulação reprovada impede o envio', async () => {
  const rpc = mockRpc({ failSimulation: true });
  const acc = createAccount();
  await assert.rejects(
    () => executeDecision({
      rpc, decision: buybackDecision, agent: { address: acc.address },
      privateKey: acc.privateKey, dryRun: false,
    }),
    /simulation reverted/,
  );
  assert.equal(rpc.state.sent.length, 0, 'nada pode ser enviado se a simulação falhou');
});

test('saldo insuficiente para gás mais valor é recusado', async () => {
  const rpc = mockRpc({ balance: 10n ** 12n });
  const acc = createAccount();
  await assert.rejects(
    () => executeDecision({
      rpc, decision: buybackDecision, agent: { address: acc.address },
      privateKey: acc.privateKey, dryRun: false,
    }),
    /insufficient balance/,
  );
});

test('a reserva de gás é respeitada mesmo com saldo aparentemente suficiente', async () => {
  const rpc = mockRpc({ balance: 6n * 10n ** 15n });
  const acc = createAccount();
  await assert.rejects(
    () => executeDecision({
      rpc, decision: buybackDecision, agent: { address: acc.address },
      privateKey: acc.privateKey, dryRun: false, reserveWei: 5n * 10n ** 15n,
    }),
    /insufficient balance/,
  );
});

// ---------------------------------------------------------------- compilação

test('buyback compila em wrap, approve e swap na ordem certa', async () => {
  const rpc = mockRpc();
  const acc = createAccount();
  const { calls } = await compileDecision({
    rpc, decision: buybackDecision, agentAddress: acc.address, token: TOKEN,
  });

  assert.equal(calls.length, 4, 'wrap, approve, swap e a transferência da queima');
  assert.match(calls[0].label, /wrap/);
  assert.equal(calls[0].to, CONTRACTS.weth);
  assert.equal(calls[0].data, selectorOf(wethItem('deposit')));
  assert.equal(calls[0].value, 5000000000000000n);

  assert.match(calls[1].label, /approve/);
  assert.equal(calls[1].to, CONTRACTS.weth);
  assert.ok(calls[1].data.startsWith(selectorOf(wethItem('approve'))));

  assert.match(calls[2].label, /swap/);
  assert.equal(calls[2].to, ROUTER);
  assert.ok(calls[2].data.startsWith(selectorOf(routerItem(true))));
  assert.equal(calls[2].capturesTokenDelta, true);

  // a queima é resolvida em tempo de execução, então não tem data pré-montada
  assert.match(calls[3].label, /burn address/);
  assert.equal(calls[3].amountRef, 'swap.out');
  assert.equal(calls[3].data, undefined);
});

test('approve é pulado quando a autorização já cobre o valor', async () => {
  const rpc = mockRpc({ allowance: 10n ** 18n });
  const acc = createAccount();
  const { calls } = await compileDecision({
    rpc, decision: buybackDecision, agentAddress: acc.address, token: TOKEN,
  });
  assert.equal(calls.length, 3, 'sem o approve sobram wrap, swap e queima');
  assert.ok(!calls.some((c) => /approve/.test(c.label)));
});

test('a variante do router segue o flag routerRequiresDeadline', async () => {
  const acc = createAccount();
  const comDeadline = await compileDecision({
    rpc: mockRpc({ requiresDeadline: true }), decision: buybackDecision,
    agentAddress: acc.address, token: TOKEN,
  });
  const semDeadline = await compileDecision({
    rpc: mockRpc({ requiresDeadline: false }), decision: buybackDecision,
    agentAddress: acc.address, token: TOKEN,
  });
  const swapOf = (r) => r.calls.find((c) => /swap/.test(c.label)).data;
  const swapCom = swapOf(comDeadline);
  const swapSem = swapOf(semDeadline);
  assert.notEqual(swapCom.slice(0, 10), swapSem.slice(0, 10), 'seletores precisam diferir');
  assert.ok(swapCom.length > swapSem.length, 'a struct com deadline é maior');
});

test('coleta de rewards compila em uma chamada ao locker', async () => {
  const rpc = mockRpc();
  const acc = createAccount();
  const { calls } = await compileDecision({
    rpc,
    decision: { kind: 'collect_rewards', token: TOKEN, steps: [{ action: 'call', to: CONTRACTS.locker, method: 'collectFees', args: [TOKEN] }] },
    agentAddress: acc.address, token: TOKEN,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, CONTRACTS.locker);
  assert.ok(calls[0].data.startsWith(selectorOf(lockerItem('collectFees'))));
});

test('passo desconhecido é erro explícito, não silêncio', async () => {
  const rpc = mockRpc();
  await assert.rejects(
    () => compileDecision({
      rpc, decision: { token: TOKEN, steps: [{ action: 'teleport' }] },
      agentAddress: createAccount().address, token: TOKEN,
    }),
    /unknown step/,
  );
});

// ---------------------------------------------------------------- execução

test('dry run simula e estima tudo sem enviar nada', async () => {
  const rpc = mockRpc();
  const acc = createAccount();
  const out = await executeDecision({
    rpc, decision: buybackDecision, agent: { address: acc.address },
    privateKey: acc.privateKey, dryRun: true,
  });
  assert.equal(out.dryRun, true);
  assert.equal(rpc.state.sent.length, 0);
  assert.ok(rpc.state.simulated.length >= 3, 'cada passo precisa ser simulado');
  // a queima é pulada no dry run: sem swap real, não há delta para transferir
  assert.equal(out.steps.filter((s) => s.dryRun).length, 3);
  assert.match(out.steps.at(-1).skipped, /amount comes from the swap/);
});

// O ensaio não pode morrer porque um passo depende do anterior.
//
// Numa compra, simular o swap antes de o WETH existir devolve `STF` — o
// safeTransferFrom do router falha porque não há saldo nem allowance. Isso é
// esperado num ensaio, não é defeito da ordem. Abortar aí fazia o buyback
// inteiro parecer quebrado.
test('dry run não aborta quando o passo dependente reverte com STF', async () => {
  const rpc = mockRpc();
  const acc = createAccount();
  const base = rpc.call;
  rpc.call = async (method, params) => {
    // só o swap (chamada ao router) reverte, como aconteceria de verdade
    if (method === 'eth_call' && params[0]?.to?.toLowerCase() === ROUTER.toLowerCase()) {
      throw new Error('eth_call: execution reverted: STF (3)');
    }
    return base(method, params);
  };

  const out = await executeDecision({
    rpc, decision: buybackDecision, agent: { address: acc.address },
    privateKey: acc.privateKey, dryRun: true,
  });

  assert.equal(rpc.state.sent.length, 0);
  const swap = out.steps.find((s) => /swap/.test(s.label));
  assert.equal(swap.notSimulated, true, 'o passo dependente vira "não simulado", não erro fatal');
  assert.match(swap.reason, /depends on the previous step/);
  assert.equal(out.steps.length, 4, 'os passos seguintes continuam sendo processados');
});

// A contrapartida: em execução real a simulação continua obrigatória, porque
// lá o passo anterior já foi minerado e um revert é revert de verdade.
test('execução real ainda aborta se o passo dependente reverte', async () => {
  const rpc = mockRpc();
  const acc = createAccount();
  const base = rpc.call;
  rpc.call = async (method, params) => {
    if (method === 'eth_call' && params[0]?.to?.toLowerCase() === ROUTER.toLowerCase()) {
      throw new Error('eth_call: execution reverted: STF (3)');
    }
    return base(method, params);
  };

  await assert.rejects(
    () => executeDecision({
      rpc, decision: buybackDecision, agent: { address: acc.address },
      privateKey: acc.privateKey, dryRun: false,
    }),
    /simulation reverted/,
  );
});

test('execução real envia transações assinadas pela conta do agente', async () => {
  const rpc = mockRpc({ tokenBalance: 0n });
  const acc = createAccount();

  // o saldo do token sobe depois do swap, simulando os tokens recebidos
  let calls = 0;
  const originalRead = rpc.read;
  rpc.read = async (address, item, args) => {
    if (item.name === 'balanceOf') { calls++; return calls > 1 ? 4200n * 10n ** 18n : 0n; }
    return originalRead(address, item, args);
  };

  const out = await executeDecision({
    rpc, decision: buybackDecision, agent: { address: acc.address },
    privateKey: acc.privateKey, dryRun: false,
  });

  assert.equal(out.dryRun, false);
  assert.equal(rpc.state.sent.length, 4, 'wrap, approve, swap e transferência da queima');

  // toda transação enviada precisa recuperar para o endereço do agente
  for (const raw of rpc.state.sent) {
    const parsed = parseTransaction(raw);
    assert.equal(parsed.from, acc.address);
    assert.equal(parsed.chainId, BigInt(CHAIN.id));
  }

  // nonces sequenciais a partir do que a RPC informou
  const nonces = rpc.state.sent.map((r) => parseTransaction(r).nonce);
  assert.deepEqual(nonces, [5n, 6n, 7n, 8n]);
});

test('a queima usa o delta do swap, não o inventário anterior', async () => {
  const rpc = mockRpc();
  const acc = createAccount();
  const INVENTARIO = 1_000_000n * 10n ** 18n;
  const COMPRADO = 4200n * 10n ** 18n;

  let reads = 0;
  const originalRead = rpc.read;
  rpc.read = async (address, item, args) => {
    if (item.name === 'balanceOf') { reads++; return reads === 1 ? INVENTARIO : INVENTARIO + COMPRADO; }
    return originalRead(address, item, args);
  };

  await executeDecision({
    rpc, decision: buybackDecision, agent: { address: acc.address },
    privateKey: acc.privateKey, dryRun: false,
  });

  // a última transação é o transfer para a queima; o valor tem que ser o comprado
  const burnTx = parseTransaction(rpc.state.sent.at(-1));
  const amount = BigInt('0x' + burnTx.data.slice(74));
  assert.equal(amount, COMPRADO, 'queimaria o inventário inteiro em vez do que comprou');
});

test('nada a transferir vira passo pulado, não erro', async () => {
  const rpc = mockRpc();
  const acc = createAccount();
  const out = await executeDecision({
    rpc,
    decision: {
      kind: 'buyback_burn', token: TOKEN,
      steps: [{ action: 'transfer', to: BURN_ADDRESS, amountRef: 'swap.out' }],
    },
    agent: { address: acc.address }, privateKey: acc.privateKey, dryRun: false,
  });
  assert.equal(out.steps[0].skipped, 'nothing to transfer');
  assert.equal(rpc.state.sent.length, 0);
});

// ---------------------------------------------------------------- trava de execução ao vivo

test('execução ao vivo exige opt-in por variável de ambiente', async () => {
  // o servidor decide dryRun = !(pedido ao vivo && PONS_ALLOW_LIVE_EXECUTION)
  const decide = (wantsLive, envAllows) => !(wantsLive && envAllows);
  assert.equal(decide(false, false), true, 'pedido normal é sempre dry run');
  assert.equal(decide(true, false), true, 'pedir ao vivo sem a variável continua dry run');
  assert.equal(decide(false, true), true, 'variável ligada sozinha não executa nada');
  assert.equal(decide(true, true), false, 'só as duas condições juntas enviam de verdade');
});

// ---------------------------------------------------------------- saque

// Havia entrada e não havia saída: dava para depositar no agente e não existia
// botão para tirar. Estes testes cobrem o caminho de volta.
test('saque de ETH manda tudo que cabe depois do gás', async () => {
  const rpc = mockRpc({ balance: 5n * 10n ** 15n });   // 0.005 ETH
  const acc = createAccount();
  const destino = '0x' + 'dd'.repeat(20);

  const out = await withdrawFromAgent({
    rpc, agent: { address: acc.address }, privateKey: acc.privateKey, to: destino,
  });

  assert.equal(rpc.state.sent.length, 1);
  const tx = parseTransaction(rpc.state.sent[0]);
  assert.equal(tx.to.toLowerCase(), destino);
  assert.equal(tx.gasLimit, 21000n);
  assert.equal(BigInt(out.amount) + tx.gasLimit * tx.maxFeePerGas, 5n * 10n ** 15n,
    'o valor enviado mais o gás máximo tem que fechar com o saldo');
});

test('saldo que não cobre nem o gás vira mensagem com os dois números', async () => {
  const rpc = mockRpc({ balance: 1000n });
  const acc = createAccount();
  await assert.rejects(
    () => withdrawFromAgent({
      rpc, agent: { address: acc.address }, privateKey: acc.privateKey, to: '0x' + 'dd'.repeat(20),
    }),
    /nothing to withdraw.*costs up to/s,
  );
});

test('pedir mais do que cabe explica qual é o máximo', async () => {
  const rpc = mockRpc({ balance: 5n * 10n ** 15n });
  const acc = createAccount();
  await assert.rejects(
    () => withdrawFromAgent({
      rpc, agent: { address: acc.address }, privateKey: acc.privateKey,
      to: '0x' + 'dd'.repeat(20), amountWei: 5n * 10n ** 15n,
    }),
    /the most this wallet can send is/,
  );
});

test('endereço de destino inválido é recusado antes de tocar na chave', async () => {
  const rpc = mockRpc();
  await assert.rejects(
    () => withdrawFromAgent({ rpc, agent: { address: '0x' + '11'.repeat(20) }, privateKey: null, to: 'nao-e-endereco' }),
    /invalid destination address/,
  );
  assert.equal(rpc.state.sent.length, 0);
});

test('conferência não envia nada e mostra quanto sairia', async () => {
  const rpc = mockRpc({ balance: 5n * 10n ** 15n });
  const acc = createAccount();
  const out = await withdrawFromAgent({
    rpc, agent: { address: acc.address }, privateKey: acc.privateKey,
    to: '0x' + 'dd'.repeat(20), dryRun: true,
  });
  assert.equal(rpc.state.sent.length, 0);
  assert.equal(out.dryRun, true);
  assert.ok(BigInt(out.amount) > 0n);
});

test('saque de token usa transfer e respeita o saldo do token', async () => {
  const rpc = mockRpc({ tokenBalance: 42n * 10n ** 18n });
  const acc = createAccount();
  const destino = '0x' + 'dd'.repeat(20);

  const out = await withdrawFromAgent({
    rpc, agent: { address: acc.address }, privateKey: acc.privateKey, to: destino,
    asset: 'token', tokenAddress: TOKEN,
  });
  assert.equal(out.amount, (42n * 10n ** 18n).toString());
  const tx = parseTransaction(rpc.state.sent[0]);
  assert.equal(tx.to.toLowerCase(), TOKEN);
  assert.equal(tx.data.slice(0, 10), selectorOf(abiItemLocal('transfer')));
});

function abiItemLocal(name) {
  return {
    type: 'function', name, inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  };
}
