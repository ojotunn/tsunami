// Locker da Pons — é aqui que vivem as creator rewards.
// A posição de LP fica travada no locker; as fees acumulam nela e o criador
// (ou um coletor autorizado) chama collectFees para liberar o split 70/30.
//
// Achado importante: `setFeeRedirect(token, newFeeWallet)` permite apontar o
// payout do criador para outro endereço, e `setFeeCollector(addr, true)` autoriza
// um terceiro a disparar a coleta. Juntos, eles tornam desnecessário entregar a
// chave privada do criador ao agente — é a base do modo "delegação sem chave".
import { CONTRACTS } from './config.js';

export const LOCKER_ABI = [
  {
    type: 'function', name: 'collectFees', stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }],
  },
  {
    type: 'function', name: 'setFeeRedirect', stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }, { name: 'newFeeWallet', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function', name: 'setFeeCollector', stateMutability: 'nonpayable',
    inputs: [{ name: 'collector', type: 'address' }, { name: 'enabled', type: 'bool' }],
    outputs: [],
  },
  {
    type: 'function', name: 'feeRedirects', stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: 'recipient', type: 'address' }],
  },
  {
    type: 'function', name: 'feeCollectors', stateMutability: 'view',
    inputs: [{ name: 'collector', type: 'address' }], outputs: [{ name: 'enabled', type: 'bool' }],
  },
  {
    type: 'function', name: 'feeRecipientTokenCount', stateMutability: 'view',
    inputs: [{ name: 'recipient_', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function', name: 'feeRecipientTokens', stateMutability: 'view',
    inputs: [{ name: 'recipient', type: 'address' }, { name: '', type: 'uint256' }],
    outputs: [{ name: 'tokens', type: 'address' }],
  },
  {
    type: 'function', name: 'deployerTokenCount', stateMutability: 'view',
    inputs: [{ name: 'deployer_', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function', name: 'deployerTokens', stateMutability: 'view',
    inputs: [{ name: 'deployer', type: 'address' }, { name: '', type: 'uint256' }],
    outputs: [{ name: 'tokens', type: 'address' }],
  },
  { type: 'function', name: 'protocolFeeShare', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  {
    type: 'function', name: 'tokenProtocolFeeShares', stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: 'share', type: 'uint256' }],
  },
  {
    type: 'event', name: 'FeesClaimed', anonymous: false, inputs: [
      { indexed: true, name: 'token', type: 'address' },
      { indexed: true, name: 'caller', type: 'address' },
      { indexed: false, name: 'token0', type: 'address' },
      { indexed: false, name: 'token1', type: 'address' },
      { indexed: false, name: 'recipientAmount0', type: 'uint256' },
      { indexed: false, name: 'recipientAmount1', type: 'uint256' },
      { indexed: false, name: 'protocolAmount0', type: 'uint256' },
      { indexed: false, name: 'protocolAmount1', type: 'uint256' },
    ],
  },
  {
    type: 'event', name: 'FeeRedirectUpdated', anonymous: false, inputs: [
      { indexed: true, name: 'token', type: 'address' },
      { indexed: true, name: 'newFeeWallet', type: 'address' },
    ],
  },
];

const item = (name, type = 'function') =>
  LOCKER_ABI.find((i) => i.name === name && i.type === type);

/** Para onde as creator rewards deste token estão indo hoje. */
export const feeRecipient = (rpc, token) =>
  rpc.read(CONTRACTS.locker, item('feeRedirects'), [token]);

/** O agente já está autorizado a disparar a coleta? */
export const isFeeCollector = (rpc, address) =>
  rpc.read(CONTRACTS.locker, item('feeCollectors'), [address]);

/** Todos os tokens cujo payout de criador aponta para este endereço. */
export async function tokensByFeeRecipient(rpc, recipient) {
  const n = await rpc.read(CONTRACTS.locker, item('feeRecipientTokenCount'), [recipient]);
  const reads = Array.from({ length: Number(n) }, (_, i) => ({
    address: CONTRACTS.locker, item: item('feeRecipientTokens'), args: [recipient, BigInt(i)],
  }));
  return (await rpc.readMany(reads)).filter((r) => r.ok).map((r) => r.value);
}

/** Todos os tokens lançados por um deployer. */
export async function tokensByDeployer(rpc, deployer) {
  const n = await rpc.read(CONTRACTS.locker, item('deployerTokenCount'), [deployer]);
  const reads = Array.from({ length: Number(n) }, (_, i) => ({
    address: CONTRACTS.locker, item: item('deployerTokens'), args: [deployer, BigInt(i)],
  }));
  return (await rpc.readMany(reads)).filter((r) => r.ok).map((r) => r.value);
}

/**
 * Simula collectFees sem enviar transação: retorna quanto sairia agora.
 * Usa eth_call com `from` = coletor, então também serve de teste de autorização.
 */
export async function previewCollect(rpc, token, from) {
  const { encodeFunctionData, decodeFunctionResult } = await import('../core/abi.js');
  const data = encodeFunctionData(item('collectFees'), [token]);
  try {
    const raw = await rpc.call('eth_call', [{ to: CONTRACTS.locker, from, data }, 'latest']);
    const out = decodeFunctionResult(item('collectFees'), raw);
    return { authorized: true, amount0: out.amount0, amount1: out.amount1 };
  } catch (err) {
    const msg = String(err.message);
    if (/NoFeesToCollect/i.test(msg)) return { authorized: true, amount0: 0n, amount1: 0n, empty: true };
    if (/NotAuthorized|NotDeployer/i.test(msg)) return { authorized: false, reason: msg };
    return { authorized: false, reason: msg };
  }
}

/**
 * Transações que o usuário assina para habilitar a delegação. É UMA só.
 *
 * Durante um tempo esta função devolvia duas, e a segunda era `setFeeCollector`
 * — que é `onlyOwner`, ou seja, só a equipe da pons pode chamar. Eu oferecia ao
 * usuário um botão que sempre reverteria, e ainda dizia que sem ele o agente
 * não coletaria sozinho. As duas coisas estavam erradas.
 *
 * O controle de acesso real do `collectFees`, na fonte verificada do locker:
 *
 *   address recipient = feeRedirects[token];
 *   if (recipient == address(0)) recipient = launched.deployer;
 *   if (msg.sender != owner() && msg.sender != launched.deployer
 *       && msg.sender != recipient && !feeCollectors[msg.sender]) revert NotAuthorized();
 *
 * Repare no terceiro termo: `msg.sender != recipient`. O destinatário do
 * redirect é, por construção, autorizado a disparar a coleta. Como o redirect
 * aponta para a carteira do agente, o agente vira recipient — e coleta sozinho.
 *
 * Uma assinatura do criador, e a coleta automática está habilitada. Não existe
 * segunda transação, e não existe motivo para pedir a chave privada de ninguém.
 */
export function delegationCalls({ token, agentAddress }) {
  return [
    {
      label: 'point the creator payout at the agent',
      to: CONTRACTS.locker,
      item: item('setFeeRedirect'),
      args: [token, agentAddress],
      note: 'signed once by the wallet that launched the token. From then on the rewards land in the ' +
        'agent wallet, and the agent can call collectFees on its own — the locker authorizes the ' +
        'redirect recipient. Point it back at yourself whenever you want to undo it.',
    },
  ];
}

/**
 * Quem pode chamar collectFees para este token, e por quê.
 * Derivado da condição citada acima — não de suposição.
 */
export async function collectAuthorization(rpc, { token, caller, deployer }) {
  const redirect = await feeRecipient(rpc, token).catch(() => null);
  const effective = redirect && redirect !== '0x0000000000000000000000000000000000000000'
    ? redirect
    : deployer;
  const is = (a, b) => a && b && String(a).toLowerCase() === String(b).toLowerCase();

  if (is(caller, effective)) {
    return { authorized: true, because: 'this wallet is the fee recipient for the token' };
  }
  if (is(caller, deployer)) {
    return { authorized: true, because: 'this wallet launched the token' };
  }
  const listed = await isFeeCollector(rpc, caller).catch(() => false);
  if (listed) return { authorized: true, because: 'this wallet is an enabled fee collector' };

  return {
    authorized: false,
    because: 'collectFees accepts the locker owner, the token deployer, the fee recipient, or an ' +
      'enabled collector. Point the redirect at this wallet to authorize it.',
  };
}

export { item as lockerItem };
