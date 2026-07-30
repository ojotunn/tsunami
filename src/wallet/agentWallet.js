// Ciclo de vida da carteira do agente.
// Ao criar um agente geramos uma conta EVM nova e dedicada na Robinhood Chain.
// O usuário deposita fundos nesse endereço; o agente só opera com o que recebeu.
import { writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAccount } from './account.js';
import { encryptKeystore, decryptKeystore } from './keystore.js';
import { seal, open as openEnvelope } from './envelope.js';
import { CHAIN, CONTRACTS, TOKEN_ABI, abiItem } from '../chain/config.js';
import { formatUnits } from '../market/pricing.js';
import { DEFAULT_POLICY, validatePolicy } from '../agent/policy.js';

const KEYSTORE_DIR = process.env.PONS_KEYSTORE_DIR || './data/keystores';

/**
 * Cria um agente: conta nova + keystore criptografado + política de risco.
 * A chave privada é descartada da memória do processo assim que é cifrada.
 */
export function createAgent(db, { label, password, policy = {} } = {}) {
  if (!password) throw new Error('set a password for the agent keystore');
  const merged = validatePolicy({ ...DEFAULT_POLICY, ...policy });

  const account = createAccount();
  const keystore = encryptKeystore(account.privateKey, password);
  account.privateKey = null;

  mkdirSync(KEYSTORE_DIR, { recursive: true });
  const id = randomUUID();
  const path = join(KEYSTORE_DIR, `${id}.json`);
  writeFileSync(path, JSON.stringify(seal(keystore), null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);

  db.prepare(`INSERT INTO agents (id, label, address, keystore_path, created_at, status, policy)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, label ?? 'agent', account.address, path, Math.floor(Date.now() / 1000), 'awaiting_funding',
      JSON.stringify(merged));

  return {
    id,
    label: label ?? 'agent',
    address: account.address,
    chainId: CHAIN.id,
    keystorePath: path,
    status: 'awaiting_funding',
    policy: merged,
    depositInstructions:
      `Send Robinhood Chain ETH (chain ${CHAIN.id}) to ${account.address}. ` +
      `That is the only balance this agent can move.`,
  };
}

export const getAgent = (db, id) => {
  const row = db.prepare('SELECT * FROM agents WHERE id = ? OR address = ?').get(id, id);
  return row ? { ...row, policy: JSON.parse(row.policy) } : null;
};

export const listAgents = (db) =>
  db.prepare('SELECT id, label, address, status, created_at FROM agents ORDER BY created_at DESC').all();

/** Desbloqueia a chave só pelo tempo da operação. Nunca persista o retorno. */
export function unlockAgent(db, id, password) {
  const agent = getAgent(db, id);
  if (!agent) throw new Error('agent not found');
  const keystore = openEnvelope(JSON.parse(readFileSync(agent.keystore_path, 'utf8')));
  const privateKey = decryptKeystore(keystore, password);
  return { ...agent, privateKey };
}

/** Saldo nativo + saldo de tokens específicos. */
export async function agentBalances(rpc, address, tokens = []) {
  const native = await rpc.getBalance(address);
  const balanceOf = abiItem(TOKEN_ABI, 'balanceOf');
  const reads = [
    { address: CONTRACTS.weth, item: balanceOf, args: [address] },
    ...tokens.map((t) => ({ address: t, item: balanceOf, args: [address] })),
  ];
  const res = await rpc.readMany(reads);
  return {
    address,
    eth: native,
    ethFormatted: formatUnits(native, 18),
    weth: res[0].ok ? res[0].value : 0n,
    tokens: Object.fromEntries(tokens.map((t, i) => [t, res[i + 1].ok ? res[i + 1].value : 0n])),
  };
}

/** Bloqueia até o agente receber o depósito mínimo (ou expirar). */
export async function waitForFunding(db, rpc, id, { minWei, timeoutMs = 15 * 60_000, pollMs = 6000, onPoll } = {}) {
  const agent = getAgent(db, id);
  if (!agent) throw new Error('agent not found');
  const threshold = BigInt(minWei ?? agent.policy.minFundingWei ?? 10n ** 15n);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const balance = await rpc.getBalance(agent.address);
    onPoll?.({ balance, threshold });
    if (balance >= threshold) {
      db.prepare('UPDATE agents SET status = ? WHERE id = ?').run('funded', agent.id);
      return { funded: true, balance };
    }
    if (Date.now() > deadline) return { funded: false, balance };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export function setAgentStatus(db, id, status) {
  db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, id);
}

/**
 * Promove o status a partir do saldo observado.
 *
 * O status nascia 'awaiting_funding' e, pelo site, nunca mudava: só o comando
 * `wait` do CLI atualizava. O resultado aparecia no painel — um agente que já
 * tinha sido financiado e já tinha executado um buyback real continuava escrito
 * como "esperando depósito". Como o saldo já é lido a cada rodada do agente, a
 * correção sai de graça aqui, sem uma leitura extra na RPC.
 *
 * Só sobe, nunca desce: voltar para 'awaiting_funding' porque o saldo caiu
 * depois de uma compra seria trocar um rótulo errado por outro.
 */
export function syncFundedStatus(db, agent, ethBalanceWei) {
  if (agent.status !== 'awaiting_funding') return agent.status;
  const threshold = BigInt(agent.policy?.minFundingWei ?? 10n ** 15n);
  if (BigInt(ethBalanceWei) < threshold) return agent.status;
  setAgentStatus(db, agent.id, 'funded');
  return 'funded';
}

/** Exporta o keystore para o usuário importar no MetaMask e recuperar os fundos. */
export function exportKeystore(db, id) {
  const agent = getAgent(db, id);
  if (!agent || !existsSync(agent.keystore_path)) throw new Error('keystore not found');
  // O export devolve o keystore V3 puro: é o que o MetaMask entende, e o
  // envelope do servidor não faz sentido fora do servidor.
  return { address: agent.address, keystore: openEnvelope(JSON.parse(readFileSync(agent.keystore_path, 'utf8'))) };
}
