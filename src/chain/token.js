// Inspeção de um endereço de token, do ponto de vista da pons.
//
// Motivo de existir: o erro `TokenNotFound` do locker é verdadeiro mas mudo.
// Ele diz "não conheço esse token" e cala. As perguntas que sobram são as que
// resolvem — esse endereço existe nesta rede? é um ERC-20? foi lançado pela
// factory da pons? por quem? — e todas têm resposta on-chain barata.
import { CONTRACTS, FACTORY_ABI, TOKEN_ABI, abiItem } from './config.js';
import { isAddress, toChecksumAddress } from '../core/hex.js';
import { feeRecipient } from './locker.js';

const NULL = '0x0000000000000000000000000000000000000000';

/** Falha de transporte (rede, timeout, 429) — não é resposta do contrato. */
const isTransport = (err) =>
  !!err?.transport || err?.httpStatus !== undefined ||
  /rate limit|HTTP \d{3}|failed after|fetch failed|timeout|aborted/i.test(err?.message || '');

/** Marca o resultado como indeterminado, sem afirmar nada sobre o token. */
function unknown(out, reason) {
  out.checked = false;
  out.isPonsToken = null;
  out.verdict = 'Could not verify this token right now: ' + reason +
    '. This says nothing about the token — only that the check did not complete. Try again in a few seconds.';
  return out;
}

// Devolve true/false quando a rede respondeu, e null quando não deu para saber.
// A diferença importa: "não tem contrato aqui" e "não consegui perguntar" levam
// a conselhos opostos, e tratar os dois como false faz o site afirmar coisas
// falsas sobre o token da pessoa sempre que a RPC engasga.
const hasCode = async (rpc, address) => {
  try { return (await rpc.call('eth_getCode', [address, 'latest'])) !== '0x'; }
  catch { return null; }
};

/**
 * Devolve o que se sabe sobre o endereço, sempre com um `verdict` em texto.
 * Nunca lança: um endereço errado é entrada normal do usuário, não exceção.
 */
export async function inspectToken(rpc, address) {
  const out = {
    address, valid: false, hasCode: false, isPonsToken: false,
    deployer: null, erc20: null, verdict: null, checked: true,
  };

  if (!isAddress(String(address || ''))) {
    out.verdict = 'That is not a valid address. It must start with 0x and have 40 hex characters after it.';
    return out;
  }
  out.valid = true;
  out.address = toChecksumAddress(address);

  const code = await hasCode(rpc, out.address);
  if (code === null) return unknown(out, 'could not reach the network to check this address');
  out.hasCode = code;
  if (!out.hasCode) {
    out.verdict = 'Nothing is deployed at this address on this network. Two usual causes: the address ' +
      'belongs to another chain, or it is a wallet address rather than a token contract.';
    return out;
  }

  // ERC-20 básico. Falha aqui não é fatal: alguns contratos omitem name/symbol.
  try {
    const [name, symbol, decimals] = await Promise.all([
      rpc.read(out.address, abiItem(TOKEN_ABI, 'name'), []).catch(() => null),
      rpc.read(out.address, abiItem(TOKEN_ABI, 'symbol'), []).catch(() => null),
      rpc.read(out.address, abiItem(TOKEN_ABI, 'decimals'), []).catch(() => null),
    ]);
    if (name || symbol) out.erc20 = { name, symbol, decimals: decimals === null ? null : Number(decimals) };
  } catch { /* segue sem metadados */ }

  // Aqui a distinção é crítica. Se a leitura falhar por rede, dizer
  // "não foi lançado pela pons" é uma afirmação falsa sobre o token de alguém —
  // e foi exatamente o que apareceu na tela quando a RPC pública devolveu 429.
  let launched = null;
  try {
    launched = await rpc.read(CONTRACTS.factory, abiItem(FACTORY_ABI, 'getLaunchedToken'), [out.address]);
  } catch (err) {
    if (isTransport(err)) return unknown(out, err.message);
    launched = null;   // revert limpo: a factory realmente não conhece o token
  }

  out.isPonsToken = !!launched?.exists;
  if (out.isPonsToken) {
    out.deployer = launched.deployer;
    out.positionId = launched.positionId?.toString?.() ?? null;
    try {
      const current = await feeRecipient(rpc, out.address);
      out.feeRecipient = current && current !== NULL ? current : null;
    } catch { /* leitura opcional */ }
    out.verdict = null; // está tudo certo: sem veredito é sem problema
    return out;
  }

  out.verdict = out.erc20
    ? `${out.erc20.symbol || 'This token'} exists on this network, but it was not launched by the pons factory ` +
      `this tool is configured for (${CONTRACTS.factory}). Creator rewards only exist for tokens launched through pons.`
    : 'There is a contract at this address, but it was not launched by the pons factory this tool is ' +
      'configured for, and it does not look like a standard ERC-20.';
  return out;
}
