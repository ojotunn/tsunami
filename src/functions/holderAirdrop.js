// Distribuição para os holders reais do token.
//
// A lista de destinatários vem da chain, não de uma lista inventada: quem
// aparece aqui comprou o token e o segura. É a versão que faz sentido do desejo
// de "aumentar holders" — você recompensa quem já está lá, e o número que sobe
// corresponde a pessoas.
//
// O contador de holders vem do Blockscout porque enumerar Transfer desde o
// lançamento sairia caro em RPC para o mesmo resultado. Se o explorador estiver
// fora do ar, a função avisa e não distribui nada — melhor não distribuir do que
// distribuir para uma lista parcial.
import { CONTRACTS, BURN_ADDRESS, NULL_ADDRESS, TOKEN_ABI, abiItem } from '../chain/config.js';
import { CHAIN } from '../chain/config.js';
import { formatUnits, parseUnits } from '../market/pricing.js';
import { isAddress } from '../core/hex.js';

export const spec = {
  id: 'holder_airdrop',
  label: 'Reward the holders',
  description: 'Distributes tokens to the real holders of your token, read from chain.',
  needsCapital: false,
  needsDelegation: false,
  params: {
    amountTokens: { type: 'decimal', default: '0', label: 'Total to distribute (0 = whole balance)' },
    mode: { type: 'enum', options: ['equal', 'proportional'], default: 'proportional', label: 'How to split' },
    minHolderBalance: { type: 'decimal', default: '1000', label: 'Minimum balance to qualify' },
    maxHolders: { type: 'int', default: 200, label: 'Max holders per run (largest first)' },
    excludeAddresses: { type: 'text', default: '', label: 'Extra addresses to exclude, one per line' },
    batchSize: { type: 'int', default: 50, label: 'Transfers per batch' },
  },
};

/** Endereços de infraestrutura que nunca devem receber airdrop. */
export const protocolAddresses = (extra = []) => new Set([
  CONTRACTS.locker, CONTRACTS.factory, CONTRACTS.weth, CONTRACTS.v3Factory,
  BURN_ADDRESS, NULL_ADDRESS, ...extra,
].filter(Boolean).map((a) => a.toLowerCase()));

/**
 * Lê os holders do explorador. Devolve ordenado por saldo, maior primeiro.
 * @returns {Promise<{holders: Array<{address:string, balance:bigint}>, source:string}>}
 */
export async function fetchHolders(token, { explorer = CHAIN.explorer, pages = 4, fetchImpl = fetch } = {}) {
  const holders = [];
  let next = `${explorer}/api/v2/tokens/${token}/holders`;

  for (let page = 0; page < pages && next; page++) {
    const res = await fetchImpl(next, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`explorer returned HTTP ${res.status} for the holder list`);
    const body = await res.json();

    for (const item of body.items ?? []) {
      const address = item.address?.hash ?? item.address;
      if (!isAddress(address)) continue;
      holders.push({
        address,
        balance: BigInt(item.value ?? item.balance ?? 0),
        isContract: !!(item.address?.is_contract),
      });
    }

    const params = body.next_page_params;
    next = params
      ? `${explorer}/api/v2/tokens/${token}/holders?` + new URLSearchParams(params).toString()
      : null;
  }

  holders.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
  return { holders, source: explorer };
}

/** Aplica todos os filtros e devolve quem realmente recebe. */
export function eligibleHolders(holders, {
  minBalance, maxHolders, excluded, poolAddress, agentAddress, toolAddresses = [],
}) {
  const block = protocolAddresses([poolAddress, agentAddress, ...toolAddresses, ...excluded]);
  const removed = { contracts: 0, tooSmall: 0, excluded: 0 };

  const kept = holders.filter((h) => {
    if (block.has(h.address.toLowerCase())) { removed.excluded++; return false; }
    if (h.isContract) { removed.contracts++; return false; }
    if (h.balance < minBalance) { removed.tooSmall++; return false; }
    return true;
  });

  return { eligible: kept.slice(0, maxHolders), removed, truncated: Math.max(0, kept.length - maxHolders) };
}

/** Divide o total entre os elegíveis. Proporcional respeita o saldo de cada um. */
export function splitAmounts(eligible, total, mode) {
  if (!eligible.length || total <= 0n) return [];
  if (mode === 'equal') {
    const per = total / BigInt(eligible.length);
    return per === 0n ? [] : eligible.map((h) => ({ address: h.address, amount: per }));
  }
  const sum = eligible.reduce((s, h) => s + h.balance, 0n);
  if (sum === 0n) return [];
  return eligible
    .map((h) => ({ address: h.address, amount: (total * h.balance) / sum }))
    .filter((p) => p.amount > 0n);
}

export async function plan(ctx, params) {
  const { rpc, db, agent, token, state } = ctx;
  const decimals = state.decimals ?? 18;
  const notes = [];

  const balance = await rpc.read(token, abiItem(TOKEN_ABI, 'balanceOf'), [agent.address]).catch(() => 0n);
  const requested = parseUnits(params.amountTokens, decimals);
  const total = requested > 0n ? requested : balance;

  if (total === 0n) {
    return { decisions: [], notes: ['the agent holds none of this token — nothing to distribute'] };
  }
  if (total > balance) {
    return {
      decisions: [],
      notes: [`the agent holds ${formatUnits(balance, decimals, 4)} but ${formatUnits(total, decimals, 4)} was requested`],
    };
  }

  let holders;
  try {
    holders = (await fetchHolders(token)).holders;
  } catch (err) {
    return { decisions: [], notes: [`could not read the holder list: ${err.message}`] };
  }
  notes.push(`${holders.length} holders read from the explorer`);

  const excluded = String(params.excludeAddresses || '')
    .split(/[\s,;]+/).filter((a) => isAddress(a));

  // Todas as carteiras que a ferramenta controla também ficam de fora.
  const toolAddresses = db
    ? db.prepare('SELECT address FROM agents').all().map((r) => r.address)
    : [];

  const { eligible, removed, truncated } = eligibleHolders(holders, {
    minBalance: parseUnits(params.minHolderBalance, decimals),
    maxHolders: params.maxHolders,
    excluded,
    poolAddress: state.pool,
    agentAddress: agent.address,
    toolAddresses,
  });

  notes.push(
    `excluded: ${removed.contracts} contracts, ${removed.tooSmall} below the minimum, ` +
    `${removed.excluded} protocol or tool wallets`,
  );
  if (truncated) notes.push(`${truncated} eligible holders left out by the per-run cap — they are not silently dropped, raise the cap or run again`);
  if (!eligible.length) return { decisions: [], notes: [...notes, 'no eligible holders with the current filters'] };

  const payouts = splitAmounts(eligible, total, params.mode);
  if (!payouts.length) {
    return { decisions: [], notes: [...notes, 'the amount is too small to split among this many holders'] };
  }

  notes.push(`${params.mode} split of ${formatUnits(total, decimals, 4)} tokens among ${payouts.length} holders`);
  notes.push(`largest share ${formatUnits(payouts[0].amount, decimals, 4)}, smallest ${formatUnits(payouts.at(-1).amount, decimals, 4)}`);

  const maxWallet = await rpc.read(token, abiItem(TOKEN_ABI, 'maxWalletAmount')).catch(() => 0n);
  if (maxWallet > 0n) {
    const over = payouts.filter((p) => p.amount > maxWallet);
    if (over.length) notes.push(`${over.length} payouts exceed maxWallet and would revert — lower the total or raise the holder count`);
  }

  // Sempre propoe — ver a mesma nota em airdrop.js sobre o parametro
  // "Simulate only" que existia aqui e so servia para nada acontecer.
  const batches = [];
  for (let i = 0; i < payouts.length; i += params.batchSize) batches.push(payouts.slice(i, i + params.batchSize));

  return {
    notes,
    decisions: batches.map((batch, i) => ({
      kind: 'holder_airdrop',
      token,
      notionalWei: '0',
      priceImpactBps: 0,
      rationale: `reward holders, batch ${i + 1}/${batches.length} — ${batch.length} wallets`,
      steps: batch.map((p) => ({ action: 'transfer', to: p.address, amountWei: p.amount.toString() })),
    })),
    preview: { holders: payouts.length, total: total.toString(), batches: batches.length },
  };
}
