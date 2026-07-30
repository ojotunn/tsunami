// Transações EIP-1559 (tipo 2): montagem, assinatura, serialização e parsing.
//
// Formato: 0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas,
//                       gasLimit, to, value, data, accessList])
// A assinatura cobre o hash keccak256 dessa mesma sequência, e o payload final
// acrescenta [yParity, r, s].
//
// O parseTransaction existe para o teste: assinar → serializar → decodificar →
// recuperar o remetente é a única forma de provar, sem rede, que a transação que
// sairia daqui é gastável pela conta certa.
import { keccak256 } from '../core/keccak.js';
import { rlpEncode, rlpDecode, rlpToBigInt, rlpToAddress } from '../core/rlp.js';
import { bytesToHex, hexToBytes, concatBytes } from '../core/hex.js';
import { sign, recoverPublicKey, addressFromPublicKey } from '../core/secp256k1.js';

export const TX_TYPE_EIP1559 = 0x02;

const field = (v) => (v === undefined || v === null ? new Uint8Array(0) : v);

/**
 * Campos de uma transação tipo 2, na ordem canônica.
 * `to` vazio significa criação de contrato — não usamos, mas o formato aceita.
 */
function txFields(tx) {
  return [
    tx.chainId,
    tx.nonce,
    tx.maxPriorityFeePerGas,
    tx.maxFeePerGas,
    tx.gasLimit,
    tx.to ? hexToBytes(tx.to) : new Uint8Array(0),
    tx.value ?? 0n,
    tx.data ? hexToBytes(tx.data) : new Uint8Array(0),
    tx.accessList ?? [],
  ];
}

/** Payload que é assinado: 0x02 || rlp(campos). */
export function unsignedPayload(tx) {
  return concatBytes(new Uint8Array([TX_TYPE_EIP1559]), rlpEncode(txFields(tx)));
}

export const signingHash = (tx) => keccak256(unsignedPayload(tx));

/**
 * Assina e devolve a transação pronta para eth_sendRawTransaction.
 * @returns {{raw: string, hash: string, from: string}}
 */
export function signTransaction(tx, privateKey) {
  required(tx);
  const hash = signingHash(tx);
  const { r, s, recovery } = sign(hash, privateKey);

  const signed = concatBytes(
    new Uint8Array([TX_TYPE_EIP1559]),
    rlpEncode([...txFields(tx), recovery, r, s]),
  );

  return {
    raw: bytesToHex(signed),
    hash: bytesToHex(keccak256(signed)),
    from: addressFromPublicKey(recoverPublicKey(hash, { r, s, recovery })),
  };
}

function required(tx) {
  for (const key of ['chainId', 'nonce', 'gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas']) {
    if (tx[key] === undefined || tx[key] === null) throw new Error(`transaction is missing ${key}`);
  }
  if (BigInt(tx.maxPriorityFeePerGas) > BigInt(tx.maxFeePerGas)) {
    throw new Error('maxPriorityFeePerGas cannot exceed maxFeePerGas');
  }
  if (tx.to && !/^0x[0-9a-fA-F]{40}$/.test(tx.to)) throw new Error('invalid "to" address');
}

/** Decodifica uma transação serializada e recupera quem a assinou. */
export function parseTransaction(rawHex) {
  const raw = hexToBytes(rawHex);
  if (raw[0] !== TX_TYPE_EIP1559) throw new Error(`unsupported transaction type 0x${raw[0].toString(16)}`);

  const items = rlpDecode(raw.subarray(1));
  if (!Array.isArray(items) || items.length !== 12) {
    throw new Error(`expected 12 fields in a signed type-2 transaction, got ${items.length}`);
  }

  const tx = {
    chainId: rlpToBigInt(items[0]),
    nonce: rlpToBigInt(items[1]),
    maxPriorityFeePerGas: rlpToBigInt(items[2]),
    maxFeePerGas: rlpToBigInt(items[3]),
    gasLimit: rlpToBigInt(items[4]),
    to: rlpToAddress(items[5]),
    value: rlpToBigInt(items[6]),
    data: bytesToHex(items[7]),
    accessList: items[8],
  };

  const recovery = Number(rlpToBigInt(items[9]));
  const r = rlpToBigInt(items[10]);
  const s = rlpToBigInt(items[11]);

  const hash = signingHash(tx);
  const from = addressFromPublicKey(recoverPublicKey(hash, { r, s, recovery }));

  return { ...tx, signature: { r, s, recovery }, from, hash: bytesToHex(keccak256(raw)) };
}

/** Custo máximo em wei que a transação pode consumir (gás + valor enviado). */
export const maxCost = (tx) =>
  BigInt(tx.gasLimit) * BigInt(tx.maxFeePerGas) + BigInt(tx.value ?? 0n);

export { field };
