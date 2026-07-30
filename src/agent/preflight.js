// Preflight: valida a rota de compra inteira contra os contratos reais, sem
// gastar nada e sem precisar de uma carteira com saldo.
//
// A pergunta que isto responde é a mais cara de descobrir na marra: "as
// transações que eu montaria agora seriam aceitas por esses contratos?".
// Erro de variante de struct, endereço de router errado ou restrição
// anti-sniping ainda ativa aparecem aqui, e não depois de queimar gás.
//
// Quando a RPC aceita state override no eth_call, damos saldo fictício ao
// endereço de origem e a simulação roda de verdade. Quando não aceita, o
// preflight diz claramente o que conseguiu e o que não conseguiu provar.
import { CHAIN, CONTRACTS, FACTORY_ABI, POOL_ABI, TOKEN_ABI, abiItem } from '../chain/config.js';
import { compileDecision } from './executor.js';
import { applyFee } from './fee.js';
import { protocolLimits, dexRouting } from './guards.js';
import { simulateSwap, tokenPriceInPair, formatUnits, parseUnits } from '../market/pricing.js';
import { lockerItem } from '../chain/locker.js';
import { encodeFunctionData } from '../core/abi.js';

const PROBE = '0x00000000000000000000000000000000000000A1';   // origem fictícia da simulação

async function hasCode(rpc, address) {
  const code = await rpc.call('eth_getCode', [address, 'latest']).catch(() => '0x');
  return code && code !== '0x';
}

/** eth_call com state override; devolve {supported:false} se a RPC não aceitar. */
async function callWithBalance(rpc, tx, from, balanceWei) {
  const overrides = { [from]: { balance: '0x' + BigInt(balanceWei).toString(16) } };
  try {
    const out = await rpc.call('eth_call', [tx, 'latest', overrides]);
    return { supported: true, ok: true, result: out };
  } catch (err) {
    const msg = String(err.message);
    // A RPC recusou o terceiro parâmetro — não é falha da transação.
    if (/too many arguments|invalid argument|unsupported|state override|3 arguments|params/i.test(msg)) {
      return { supported: false };
    }
    return { supported: true, ok: false, error: msg };
  }
}

/**
 * @param {string} token endereço do token da pons
 * @param {string} amountEth quanto de ETH a compra simularia
 */
export async function preflight(rpc, token, amountEth = '0.005', { from = PROBE } = {}) {
  const report = { token, network: CHAIN.network, chainId: CHAIN.id, checks: [], route: null, warnings: [], notes: [] };
  const add = (name, ok, detail) => report.checks.push({ name, ok, detail });

  // 1. a RPC está na rede que pensamos
  const chainId = await rpc.chainId();
  add('rpc chain id', chainId === CHAIN.id, `${chainId} (expected ${CHAIN.id})`);
  if (chainId !== CHAIN.id) return report;

  // 2. os contratos existem mesmo nesta rede
  for (const [name, address] of Object.entries(CONTRACTS)) {
    if (typeof address !== 'string') continue;
    add(`${name} has code`, await hasCode(rpc, address), address);
  }
  add('token has code', await hasCode(rpc, token), token);

  // 3. o token foi lançado por esta factory
  const launched = await rpc
    .read(CONTRACTS.factory, abiItem(FACTORY_ABI, 'getLaunchedToken'), [token])
    .catch(() => null);
  add('launched by this factory', !!launched?.exists, launched?.exists ? `dexId ${launched.dexId}` : 'not found');
  if (!launched?.exists) return report;

  // 4. roteamento e limites
  const limits = await protocolLimits(rpc, token);
  const dex = await dexRouting(rpc, launched.dexId);
  add('dex enabled', true, `${dex.name} · router ${dex.swapRouter}`);
  add('router has code', await hasCode(rpc, dex.swapRouter), dex.swapRouter);
  add('router variant', true, limits.routerRequiresDeadline ? 'exactInputSingle WITH deadline' : 'exactInputSingle WITHOUT deadline');

  // A janela de restrição limita o TAMANHO da compra, não proíbe comprar.
  // Reportá-la como impedimento era erro: o teto é 5% do supply por carteira, e
  // as ordens do agente ficam ordens de grandeza abaixo disso.
  if (limits.restrictionsActive) {
    report.notes.push(
      `anti-sniping window active for ${limits.blocksUntilFree} more blocks: pool buys are capped at ` +
      `${limits.maxWalletTokens} per wallet (maxWallet) and ${limits.maxTxTokens} cumulative (maxTx). ` +
      'Buying is allowed below those ceilings.',
    );
  }
  add('anti-sniping window', true,
    limits.restrictionsActive ? `active (+${limits.blocksUntilFree} blocks, size-capped)` : 'lifted');
  if (limits.isLaunchBlock) {
    report.warnings.push('this is the launch block — pool buys revert until the next block');
  }

  // 5. quem pode disparar a coleta de rewards
  //
  // Esta é a pergunta que decide se a delegação sem chave funciona de verdade.
  // Se collectFees for chamável por qualquer um, o agente pode disparar a coleta
  // e o dinheiro vai para onde feeRedirects aponta — sem nunca tocar na chave do
  // criador. Se exigir o deployer, o redirect ainda leva o pagamento para o
  // agente, mas quem dispara tem que ser o criador.
  const redirect = await rpc.read(CONTRACTS.locker, lockerItem('feeRedirects'), [token]).catch(() => null);
  if (redirect) report.feeRecipient = redirect;

  const collectData = encodeFunctionData(lockerItem('collectFees'), [token]);
  const probe = await rpc
    .call('eth_call', [{ from, to: CONTRACTS.locker, data: collectData }, 'latest'])
    .then(() => ({ allowed: true }))
    .catch((e) => ({ allowed: false, reason: String(e.message) }));

  if (probe.allowed) {
    add('collectFees callable by a third party', true, 'yes — keyless delegation works end to end');
    report.delegation = 'permissionless';
  } else if (/NotAuthorized|NotDeployer|0x82b42900|0x36b1fa5d/i.test(probe.reason)) {
    add('collectFees callable by a third party', false, 'no — restricted to the deployer or an enabled collector');
    report.delegation = 'restricted';
    report.notes.push(
      'collectFees is access-controlled, and this probe used an address with no relationship to the token, ' +
      'so the refusal is expected. The locker accepts the owner, the token deployer, the fee recipient, ' +
      'or an enabled collector — so once setFeeRedirect points at the agent, the agent itself qualifies ' +
      'as the recipient and can trigger collection on its own.',
    );
  } else if (/NoFeesToCollect/i.test(probe.reason)) {
    add('collectFees callable by a third party', true, 'yes — reverted only because there is nothing to collect');
    report.delegation = 'permissionless';
  } else {
    add('collectFees callable by a third party', false, probe.reason?.slice(0, 120));
    report.delegation = 'unknown';
  }

  // 6. estado do pool e impacto esperado
  const pool = await rpc.read(token, abiItem(TOKEN_ABI, 'liquidityPool')).catch(() => null);
  const slot0 = pool ? await rpc.read(pool, abiItem(POOL_ABI, 'slot0')).catch(() => null) : null;
  const liquidity = pool ? await rpc.read(pool, abiItem(POOL_ABI, 'liquidity')).catch(() => 0n) : 0n;
  const decimals = await rpc.read(token, abiItem(TOKEN_ABI, 'decimals')).catch(() => 18n);

  const amountIn = parseUnits(amountEth, 18);
  let expected = null;
  if (slot0 && liquidity > 0n) {
    const price = tokenPriceInPair({
      sqrtPriceX96: slot0.sqrtPriceX96, isToken0: launched.isToken0,
      tokenDecimals: Number(decimals), pairDecimals: 18,
    });
    expected = simulateSwap({
      sqrtPriceX96: slot0.sqrtPriceX96, liquidity, amountIn,
      side: 'buy', isToken0: launched.isToken0, feePips: Number(launched.poolFee),
    });
    add('pool has liquidity', true, `L = ${liquidity}`);
    report.market = {
      pool,
      price: formatUnits(price, 18, 12),
      expectedOut: formatUnits(expected.amountOut, Number(decimals), 4),
      priceImpactPct: (expected.priceImpactBps / 100).toFixed(2),
    };
    if (expected.priceImpactBps > 150) {
      report.warnings.push(`a ${amountEth} ETH buy would move the price ${(expected.priceImpactBps / 100).toFixed(2)}% — the default policy caps this at 1.50%`);
    }
    // o resultado da compra ainda precisa caber no maxTx do protocolo
    if (limits.maxTxTokens > 0n && expected.amountOut > limits.maxTxTokens) {
      report.warnings.push(`the buy would receive more tokens than maxTx allows (${limits.maxTxTokens}) and would revert`);
    }
  } else {
    add('pool has liquidity', false, 'could not read slot0/liquidity');
  }

  // 7. montar as transações reais e conferir a codificação
  // A taxa de serviço entra aqui também: sem isso o relatório mostraria uma
  // rota mais curta do que a execução real, que é justamente o que o preflight
  // existe para evitar.
  const decision = applyFee({
    kind: 'buyback_burn', token,
    notionalWei: amountIn.toString(),
    steps: [
      { action: 'swap', side: 'buy', amountInWei: amountIn.toString(), minOutWei: expected ? (expected.amountOut * 99n / 100n).toString() : '0' },
      { action: 'transfer', to: '0x000000000000000000000000000000000000dEaD', amountRef: 'swap.out' },
    ],
  }, { agentAddress: from });
  const { calls } = await compileDecision({ rpc, decision, agentAddress: from, token });
  report.route = calls.map((c) => ({
    label: c.label, to: c.to,
    selector: c.data ? c.data.slice(0, 10) : '(resolved at run time)',
    value: c.value ? formatUnits(c.value, 18) + ' ETH' : '0',
  }));
  add('route compiles', calls.length >= 3, `${calls.length} transactions`);

  // 8. simulação real, se a RPC permitir dar saldo ao endereço de origem
  const funded = amountIn + 10n ** 17n;
  let overrideSupported = null;
  for (const call of calls) {
    if (!call.data) continue;                     // a queima depende do swap; sai de fora
    const res = await callWithBalance(rpc, {
      from, to: call.to, data: call.data,
      value: '0x' + BigInt(call.value ?? 0n).toString(16),
    }, from, funded);

    if (res.supported === false) { overrideSupported = false; break; }
    overrideSupported = true;
    add(`simulate: ${call.label}`, res.ok, res.ok ? 'call succeeded' : res.error?.slice(0, 160));
    if (!res.ok) break;                           // não adianta seguir depois de um revert
  }

  if (overrideSupported === false) {
    report.warnings.push(
      'this RPC does not accept state overrides on eth_call, so the buy could not be simulated end to end. ' +
      'An Alchemy endpoint (PONS_RPC_URL) supports it, or fund the agent and run "execute" as a dry run.',
    );
  }
  report.simulated = overrideSupported === true;
  return report;
}

export function formatReport(r) {
  const line = (ok, name, detail) => `  ${ok ? '[ok]' : '[!!]'} ${name.padEnd(34)} ${detail ?? ''}`;
  const out = [
    ``,
    `preflight · ${r.token}`,
    `network ${r.network} (chain ${r.chainId})`,
    ``,
    ...r.checks.map((c) => line(c.ok, c.name, c.detail)),
  ];

  if (r.feeRecipient) {
    out.push('', '  creator rewards', `    payout goes to ... ${r.feeRecipient}`,
      `    delegation ...... ${r.delegation}`);
  }

  if (r.market) {
    out.push('', '  market', `    pool ............ ${r.market.pool}`,
      `    price ........... ${r.market.price} ETH`,
      `    expected out .... ${r.market.expectedOut} tokens`,
      `    price impact .... ${r.market.priceImpactPct}%`);
  }

  if (r.route) {
    out.push('', '  transactions that would be sent');
    r.route.forEach((t, i) => out.push(`    ${i + 1}. ${t.label}`, `       to ${t.to}  ${t.selector}  value ${t.value}`));
  }

  if (r.notes?.length) {
    out.push('', '  notes');
    r.notes.forEach((n) => out.push(`    - ${n}`));
  }

  if (r.warnings.length) {
    out.push('', '  warnings');
    r.warnings.forEach((w) => out.push(`    - ${w}`));
  }

  out.push('', r.simulated
    ? '  end-to-end simulation ran against the live contracts.'
    : '  encoding and routing verified; the swap itself was not simulated (see warnings).', '');
  return out.join('\n');
}
