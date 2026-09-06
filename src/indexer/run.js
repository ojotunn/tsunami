// Indexador: backfill + acompanhamento em tempo real de TokenLaunched e Swap.
import { RpcClient } from '../core/rpc.js';
import { detectV2, curveState, curveSpotPrice } from '../chain/v2.js';
import { CONTRACTS, FACTORY_ABI, POOL_ABI, TOKEN_ABI, abiItem } from '../chain/config.js';
import { openDb, getMeta, setMeta, upsertToken, updateTokenState, insertSwap, insertSnapshot, listTokens, trackedPools, getToken, setTokenVersion } from './db.js';
import { swapSide, swapPairVolume, tokenPriceInPair, marketCapInPair } from '../market/pricing.js';

const TOKEN_LAUNCHED = abiItem(FACTORY_ABI, 'TokenLaunched', 'event');
const SWAP = abiItem(POOL_ABI, 'Swap', 'event');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CURSOR = 'cursor:launches';

/** Backfill de lançamentos em janelas, resiliente a limites de getLogs da RPC. */
export async function backfillLaunches({ rpc, db, fromBlock, toBlock, step = 2000n, onBatch }) {
  let from = fromBlock;
  let total = 0;
  while (from <= toBlock) {
    let to = from + step - 1n;
    if (to > toBlock) to = toBlock;
    let logs;
    try {
      logs = await rpc.getLogs({ address: CONTRACTS.factory, event: TOKEN_LAUNCHED, fromBlock: from, toBlock: to });
    } catch (err) {
      if (step > 50n) { step = step / 4n; continue; }        // janela grande demais para a RPC
      throw err;
    }
    for (const log of logs) {
      upsertToken(db, {
        address: log.args.token,
        deployer: log.args.deployer,
        pairToken: log.args.pairToken,
        pool: log.args.pool,
        dexId: log.args.dexId,
        launchConfigId: log.args.launchConfigId,
        positionId: log.args.positionId,
        restrictionsEndBlock: log.args.restrictionsEndBlock,
        initialBuyAmount: log.args.initialBuyAmount,
        launchBlock: log.blockNumber,
        launchTx: log.transactionHash,
      });
    }
    total += logs.length;
    setMeta(db, CURSOR, to.toString());
    onBatch?.({ from, to, found: logs.length, total });
    from = to + 1n;
  }
  return total;
}

/** Enriquece tokens com metadados on-chain (nome, símbolo, supply, ordenação). */
export async function syncTokenState(db, rpc, addresses) {
  const items = ['name', 'symbol', 'decimals', 'totalSupply'].map((n) => abiItem(TOKEN_ABI, n));
  const launched = abiItem(FACTORY_ABI, 'getLaunchedToken');

  for (const address of addresses) {
    const reads = items.map((item) => ({ address, item }));
    reads.push({ address: CONTRACTS.factory, item: launched, args: [address] });
    const res = await rpc.readMany(reads);
    const [name, symbol, decimals, supply, meta] = res;
    if (!meta.ok) continue;
    updateTokenState(db, address, {
      name: name.ok ? name.value : null,
      symbol: symbol.ok ? symbol.value : null,
      decimals: decimals.ok ? Number(decimals.value) : 18,
      totalSupply: supply.ok ? supply.value : 0n,
      isToken0: meta.value.isToken0,
      poolFee: meta.value.poolFee,
    });
  }
}

/** Indexa Swaps dos pools acompanhados numa faixa de blocos. */
export async function indexSwaps({ rpc, db, pools, fromBlock, toBlock }) {
  if (!pools.length) return 0;
  const tokenByPool = new Map(
    db.prepare("SELECT address, pool, is_token0 FROM tokens WHERE pool IS NOT NULL").all()
      .map((r) => [r.pool, r]),
  );
  let count = 0;
  for (let i = 0; i < pools.length; i += 100) {                 // limite prático de endereços por getLogs
    const chunk = pools.slice(i, i + 100);
    const logs = await rpc.getLogs({ address: chunk, event: SWAP, fromBlock, toBlock });
    for (const log of logs) {
      const t = tokenByPool.get(log.address.toLowerCase());
      const isToken0 = t ? !!t.is_token0 : true;
      const a = log.args;
      insertSwap(db, {
        txHash: log.transactionHash, logIndex: log.logIndex, pool: log.address, block: log.blockNumber,
        sender: a.sender, recipient: a.recipient, amount0: a.amount0, amount1: a.amount1,
        sqrtPriceX96: a.sqrtPriceX96, liquidity: a.liquidity, tick: a.tick,
        side: swapSide({ amount0: a.amount0, amount1: a.amount1, isToken0 }),
        pairVolume: swapPairVolume({ amount0: a.amount0, amount1: a.amount1, isToken0 }),
      });
      count++;
    }
  }
  return count;
}

/** Snapshot de preço/liquidez/graduação de um token. */
/**
 * Garante que UM token esteja no banco, lendo direto dos contratos.
 *
 * O backfill varre milhares de blocos procurando lançamentos. Isso é o certo
 * para descobrir tokens, e é lento demais para o caso em que já se sabe qual é
 * o token — que é justamente o caso de quem acabou de colar o próprio endereço.
 * Exigir a varredura inteira ali transforma "rodar o agente" num pré-requisito
 * de dez minutos, por nada: `getLaunchedToken` e `liquidityPool()` respondem a
 * mesma coisa em duas leituras.
 *
 * Devolve a linha do token, ou lança se o token não for da pons.
 */
export async function ensureTokenIndexed(db, rpc, address) {
  const existing = getToken(db, address);
  if (existing?.pool) return existing;

  const launched = await rpc
    .read(CONTRACTS.factory, abiItem(FACTORY_ABI, 'getLaunchedToken'), [address])
    .catch(() => null);
  if (!launched?.exists) {
    // A V1 não conhece o token: pode ser um lançamento V2 (bonding curve).
    const v2 = await detectV2(rpc, address).catch(() => null);
    if (!v2) throw new Error('this token was not launched by the pons factory this tool is configured for');
    return ensureV2TokenIndexed(db, rpc, address, v2, existing);
  }

  const reads = ['name', 'symbol', 'decimals', 'totalSupply', 'liquidityPool']
    .map((n) => ({ address, item: abiItem(TOKEN_ABI, n) }));
  const [name, symbol, decimals, supply, pool] = await rpc.readMany(reads);
  if (!pool.ok) throw new Error('could not read the token liquidity pool from chain');

  upsertToken(db, {
    address,
    deployer: launched.deployer,
    pairToken: launched.pairedToken,
    pool: pool.value,
    dexId: launched.dexId,
    launchConfigId: launched.launchConfigId,
    positionId: launched.positionId,
    restrictionsEndBlock: launched.restrictionsEndBlock,
    initialBuyAmount: launched.initialBuyAmount,
    launchBlock: existing?.launch_block ?? 0,
    launchTx: existing?.launch_tx ?? null,
  });
  updateTokenState(db, address, {
    name: name.ok ? name.value : null,
    symbol: symbol.ok ? symbol.value : null,
    decimals: decimals.ok ? Number(decimals.value) : 18,
    totalSupply: supply.ok ? supply.value : 0n,
    isToken0: launched.isToken0,
    poolFee: launched.poolFee,
  });
  return getToken(db, address);
}

/**
 * Token V2: não há pool nem posição — o "pool" gravado é a própria curva,
 * para o resto do código (que pergunta "tem pool?") continuar funcionando.
 * O par é ETH nativo (ou outro ativo, que o agente não opera).
 */
async function ensureV2TokenIndexed(db, rpc, address, v2, existing) {
  const reads = ['name', 'symbol', 'decimals', 'totalSupply']
    .map((n) => ({ address, item: abiItem(TOKEN_ABI, n) }));
  const [name, symbol, decimals, supply] = await rpc.readMany(reads);

  upsertToken(db, {
    address,
    deployer: v2.deployer,
    pairToken: v2.nativeQuote ? CONTRACTS.weth : v2.pairToken,
    pool: v2.curve,
    dexId: '', launchConfigId: '', positionId: '',
    restrictionsEndBlock: 0n, initialBuyAmount: 0n,
    launchBlock: existing?.launch_block ?? 0,
    launchTx: existing?.launch_tx ?? null,
  });
  updateTokenState(db, address, {
    name: name.ok ? name.value : null,
    symbol: symbol.ok ? symbol.value : null,
    decimals: decimals.ok ? Number(decimals.value) : 18,
    totalSupply: supply.ok ? supply.value : 0n,
    isToken0: false,
    poolFee: v2.poolFee,
  });
  setTokenVersion(db, address, { version: 'v2', curve: v2.curve, phase: v2.phase });
  return getToken(db, address);
}

/**
 * Foto do mercado de um token V2. Antes da graduação o preço sai das reservas
 * da curva; `liquidity` recebe a reserva de cotação em wei, que é o que a
 * política de risco compara com o mínimo de profundidade. Depois da
 * graduação o preço vive numa pool V4 que este projeto ainda não lê — a foto
 * fica sem preço, e as funções de compra dizem isso em vez de chutar.
 */
async function snapshotV2(db, rpc, t) {
  const launch = await detectV2(rpc, t.address);
  if (!launch) throw new Error('the v2 factory no longer knows this token');
  if (launch.phase !== (t.phase ?? 0)) setTokenVersion(db, t.address, { version: 'v2', curve: launch.curve, phase: launch.phase });

  const base = {
    token: t.address,
    block: Number(await rpc.blockNumber()),
    ts: Math.floor(Date.now() / 1000),
    version: 'v2',
    launch,
    graduated: launch.graduated,
  };

  if (launch.graduated) {
    const snap = { ...base, venue: 'v4', curve: null, sqrtPriceX96: 0n, liquidity: 0n, pricePair: 0n, mcapPair: 0n, tick: 0n };
    insertSnapshot(db, snap);
    return snap;
  }

  const curve = await curveState(rpc, launch.curve);
  const price = curveSpotPrice(curve);
  const snap = {
    ...base,
    venue: 'curve',
    curve,
    sqrtPriceX96: 0n,
    liquidity: curve.quoteReserve,
    pricePair: price,
    mcapPair: marketCapInPair(price, BigInt(t.total_supply || '0'), t.decimals ?? 18),
    tick: 0n,
  };
  insertSnapshot(db, snap);
  return snap;
}

export async function snapshotToken(db, rpc, address) {
  const t = getToken(db, address);
  if (!t?.pool) throw new Error('token has no indexed pool');
  if (t.version === 'v2') return snapshotV2(db, rpc, t);
  const [slot0, liq, grad] = await rpc.readMany([
    { address: t.pool, item: abiItem(POOL_ABI, 'slot0') },
    { address: t.pool, item: abiItem(POOL_ABI, 'liquidity') },
    { address: CONTRACTS.factory, item: abiItem(FACTORY_ABI, 'graduationStatus'), args: [t.address] },
  ]);
  if (!slot0.ok) throw new Error(`slot0 failed: ${slot0.error}`);

  const sqrtPriceX96 = slot0.value.sqrtPriceX96;
  const price = tokenPriceInPair({
    sqrtPriceX96, isToken0: !!t.is_token0,
    tokenDecimals: t.decimals ?? 18, pairDecimals: 18,
  });
  const snap = {
    token: t.address,
    block: Number(await rpc.blockNumber()),
    ts: Math.floor(Date.now() / 1000),
    sqrtPriceX96,
    liquidity: liq.ok ? liq.value : 0n,
    pricePair: price,
    mcapPair: marketCapInPair(price, BigInt(t.total_supply || '0'), t.decimals ?? 18),
    graduated: grad.ok ? grad.value.graduated : false,
    tick: slot0.value.tick,
  };
  insertSnapshot(db, snap);
  return snap;
}

/** Loop contínuo: novos lançamentos + swaps dos pools acompanhados. */
export async function watch({ rpc, db, intervalMs = 4000, confirmations = 2n, onEvent = () => {} }) {
  let cursor = BigInt(getMeta(db, CURSOR) ?? (await rpc.blockNumber()) - 100n);
  for (;;) {
    try {
      const head = (await rpc.blockNumber()) - confirmations;
      if (head > cursor) {
        const to = head > cursor + 500n ? cursor + 500n : head;
        const found = await backfillLaunches({ rpc, db, fromBlock: cursor + 1n, toBlock: to, step: 500n });
        const swaps = await indexSwaps({ rpc, db, pools: trackedPools(db), fromBlock: cursor + 1n, toBlock: to });
        cursor = to;
        setMeta(db, CURSOR, cursor.toString());
        onEvent({ block: cursor, launches: found, swaps });
      }
    } catch (err) {
      onEvent({ error: err.message });
    }
    await sleep(intervalMs);
  }
}

export { openDb, listTokens, getToken, trackedPools, RpcClient };
