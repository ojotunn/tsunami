// Airdrop: distribuição do token para uma lista de destinatários reais.
//
// A lista é obrigatória e vem de fora — o agente não gera destinatários. Essa é a
// diferença entre distribuir um token e fabricar holders: um airdrop para pessoas
// que existem aumenta a base de detentores; enviar para carteiras que você mesmo
// controla só move saldo entre bolsos seus, enquanto faz o contador de holders
// mentir para quem está avaliando o token. O módulo recusa listas que apontem
// para endereços derivados do próprio agente e grava o lote inteiro para auditoria.
import { isAddress } from '../core/hex.js';
import { TOKEN_ABI, abiItem } from '../chain/config.js';
import { formatUnits, parseUnits } from '../market/pricing.js';

export const spec = {
  id: 'airdrop',
  label: 'Airdrop',
  description: 'Distributes the token to a recipient list you provide.',
  needsCapital: false,
  needsDelegation: false,
  params: {
    recipientsCsv: { type: 'text', default: '', label: 'List: address,amount per line' },
    batchSize: { type: 'int', default: 50, label: 'Transfers per batch' },
    dryRun: { type: 'bool', default: true, label: 'Simulate only' },
  },
};

/** Faz o parse de "endereço,quantidade" por linha e valida tudo antes de qualquer envio. */
export function parseRecipients(csv, decimals = 18) {
  const out = [];
  const errors = [];
  const seen = new Set();

  String(csv).split(/\r?\n/).forEach((line, i) => {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) return;
    const [addr, amount] = raw.split(/[,;\t]/).map((s) => s?.trim());
    const n = i + 1;

    if (!isAddress(addr)) { errors.push(`line ${n}: invalid address "${addr}"`); return; }
    if (seen.has(addr.toLowerCase())) { errors.push(`line ${n}: duplicate address ${addr}`); return; }
    let value;
    try { value = parseUnits(amount, decimals); } catch { errors.push(`line ${n}: invalid amount "${amount}"`); return; }
    if (value <= 0n) { errors.push(`line ${n}: amount must be greater than zero`); return; }

    seen.add(addr.toLowerCase());
    out.push({ address: addr, amount: value });
  });

  return { recipients: out, errors, total: out.reduce((s, r) => s + r.amount, 0n) };
}

/** Recusa listas que só devolvem tokens para carteiras da própria ferramenta. */
export function checkSelfDealing(recipients, { db, agentAddress }) {
  const known = new Set(
    db.prepare('SELECT address FROM agents').all().map((r) => r.address.toLowerCase()),
  );
  known.add(agentAddress.toLowerCase());
  const hits = recipients.filter((r) => known.has(r.address.toLowerCase()));
  return hits.map((h) => `recipient ${h.address} is a wallet owned by this tool`);
}

export async function plan(ctx, params) {
  const { rpc, db, agent, token, state } = ctx;
  const decimals = state.decimals ?? 18;
  const { recipients, errors, total } = parseRecipients(params.recipientsCsv, decimals);
  const notes = [...errors];

  if (!recipients.length) {
    return { decisions: [], notes: [...notes, 'no valid recipients — provide the address list'] };
  }

  const selfDealing = checkSelfDealing(recipients, { db, agentAddress: agent.address });
  if (selfDealing.length) {
    return { decisions: [], notes: [...notes, ...selfDealing, 'airdrop cancelled: the list points at wallets owned by this tool'] };
  }

  const balance = await rpc.read(token, abiItem(TOKEN_ABI, 'balanceOf'), [agent.address]).catch(() => 0n);
  if (balance < total) {
    notes.push(`agent balance (${formatUnits(balance, decimals, 4)}) is below the airdrop total (${formatUnits(total, decimals, 4)})`);
  }

  // maxWallet do protocolo se aplica a cada destinatário
  const maxWallet = await rpc.read(token, abiItem(TOKEN_ABI, 'maxWalletAmount')).catch(() => 0n);
  if (maxWallet > 0n) {
    const over = recipients.filter((r) => r.amount > maxWallet);
    if (over.length) notes.push(`${over.length} recipients exceed maxWallet (${formatUnits(maxWallet, decimals, 4)}) — those transfers would revert`);
  }

  const batches = [];
  for (let i = 0; i < recipients.length; i += params.batchSize) {
    batches.push(recipients.slice(i, i + params.batchSize));
  }
  notes.push(`${recipients.length} recipients, ${formatUnits(total, decimals, 4)} tokens, ${batches.length} batch(es)`);
  if (params.dryRun) notes.push('simulate only: no transfer will be sent');

  return {
    decisions: params.dryRun ? [] : batches.map((batch, i) => ({
      kind: 'airdrop',
      token,
      notionalWei: '0',
      priceImpactBps: 0,
      rationale: `airdrop batch ${i + 1}/${batches.length} — ${batch.length} recipients`,
      steps: batch.map((r) => ({ action: 'transfer', to: r.address, amountWei: r.amount.toString() })),
    })),
    notes,
    preview: { recipients: recipients.length, total: total.toString(), batches: batches.length },
  };
}
