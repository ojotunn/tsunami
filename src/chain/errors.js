// Tradução de reverts para linguagem humana.
//
// Uma transação que "vai falhar" não diz nada a quem está olhando. O contrato
// sempre diz o motivo — num seletor de 4 bytes que ninguém decora. Este módulo
// pega esse seletor e devolve a frase que responde a pergunta real: o que eu
// preciso fazer para essa transação passar?
import { decodeTuple } from '../core/abi.js';
import { keccakHex, hexToBytes } from '../core/hex.js';

/** Erros customizados do PonsLaunchLocker (ABI verificada no Blockscout). */
export const LOCKER_ERRORS = [
  { name: 'AlreadyInitialized', inputs: [] },
  { name: 'InvalidProtocolFee', inputs: [] },
  { name: 'NoFeesToCollect', inputs: [] },
  { name: 'NotAuthorized', inputs: [] },
  { name: 'NotDeployer', inputs: [] },
  { name: 'NotFactory', inputs: [] },
  { name: 'OwnableInvalidOwner', inputs: [{ name: 'owner', type: 'address' }] },
  { name: 'OwnableUnauthorizedAccount', inputs: [{ name: 'account', type: 'address' }] },
  { name: 'PositionAlreadyLocked', inputs: [] },
  { name: 'PositionNotHeld', inputs: [] },
  { name: 'ReentrancyGuardReentrantCall', inputs: [] },
  { name: 'SafeERC20FailedOperation', inputs: [{ name: 'token', type: 'address' }] },
  { name: 'TokenNotFound', inputs: [] },
  { name: 'ZeroAddress', inputs: [] },
];

/** Seletor de 4 bytes de um erro, igual ao de função: keccak(nome(tipos))[0..4]. */
export function errorSelector(err) {
  return keccakHex(`${err.name}(${err.inputs.map((i) => i.type).join(',')})`).slice(0, 10);
}

const TABLE = new Map(LOCKER_ERRORS.map((e) => [errorSelector(e), e]));

const ERROR_STRING = '0x08c379a0'; // Error(string)
const PANIC = '0x4e487b71';        // Panic(uint256)

/**
 * Decodifica o payload de revert. Devolve `null` quando não há payload —
 * "não sei" é uma resposta melhor do que um palpite bonito.
 */
export function decodeRevert(data) {
  if (typeof data !== 'string' || !data.startsWith('0x') || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();
  const body = '0x' + data.slice(10);

  if (selector === ERROR_STRING) {
    try {
      const { values } = decodeTuple([{ name: 'reason', type: 'string' }], hexToBytes(body), 0);
      return { kind: 'revert', name: 'Error', reason: values[0] };
    } catch { return { kind: 'revert', name: 'Error' }; }
  }
  if (selector === PANIC) {
    try {
      const { values } = decodeTuple([{ name: 'code', type: 'uint256' }], hexToBytes(body), 0);
      return { kind: 'panic', name: 'Panic', code: values[0].toString() };
    } catch { return { kind: 'panic', name: 'Panic' }; }
  }

  const known = TABLE.get(selector);
  if (!known) return { kind: 'unknown', selector };
  let args = {};
  if (known.inputs.length) {
    try { args = decodeTuple(known.inputs, hexToBytes(body), 0).named; }
    catch { /* argumentos ilegíveis: o nome do erro já vale */ }
  }
  return { kind: 'custom', name: known.name, args };
}

/**
 * Frase para o usuário final. Cada uma responde "o que eu faço agora", não
 * apenas "o que deu errado" — a diferença entre um erro e uma instrução.
 */
export function explainRevert(decoded, ctx = {}) {
  if (!decoded) return null;
  const who = ctx.deployer ? ` The wallet that launched it is ${ctx.deployer}.` : '';

  switch (decoded.name) {
    case 'NotDeployer':
      return 'Only the wallet that launched this token can redirect its creator rewards. ' +
        'The wallet connected right now did not launch it.' + who;
    case 'NotAuthorized':
      return 'This wallet is not authorized by the locker for that call.' + who;
    case 'OwnableUnauthorizedAccount':
      return 'This call is restricted to the locker owner — the pons team, not token creators. ' +
        'You cannot authorize a collector yourself; the agent collects through the redirect instead.';
    case 'TokenNotFound':
      return 'The locker has no record of this token. Check the address, and make sure it was ' +
        'launched through pons on this network.';
    case 'NoFeesToCollect':
      return 'There are no creator rewards accumulated yet. Nothing to collect right now.';
    case 'ZeroAddress':
      return 'One of the addresses in the call is empty. Fill in the token address.';
    case 'PositionNotHeld':
      return 'The liquidity position for this token is not held by the locker, so it has no rewards to redirect.';
    case 'Error':
      return decoded.reason ? `The contract rejected the call: ${decoded.reason}` : 'The contract rejected the call.';
    case 'Panic':
      return `The contract hit an internal error (panic ${decoded.code}).`;
    default:
      return decoded.selector
        ? `The contract rejected the call with an error this tool does not recognize (${decoded.selector}).`
        : null;
  }
}

/** Atalho: do erro de RPC direto para a frase. */
export function explainRpcError(err, ctx = {}) {
  const decoded = decodeRevert(err?.rpcData);
  const human = explainRevert(decoded, ctx);
  return {
    decoded,
    human: human ?? (/revert/i.test(err?.message || '')
      ? 'The contract rejected the call, without saying why.'
      : `Could not simulate the call: ${err?.message || 'unknown error'}`),
  };
}
