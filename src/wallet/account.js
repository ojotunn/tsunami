// Geração e derivação de contas EVM usando apenas node:crypto (sem dependências).
import { createECDH, randomBytes } from 'node:crypto';
import { keccak256 } from '../core/keccak.js';
import { bytesToHex, hexToBytes, toChecksumAddress } from '../core/hex.js';

// Ordem do grupo secp256k1
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Chave privada válida a partir do CSPRNG do SO. */
export function generatePrivateKey() {
  for (;;) {
    const buf = randomBytes(32);
    const k = BigInt('0x' + buf.toString('hex'));
    if (k > 0n && k < N) return bytesToHex(buf);
  }
}

/** Chave pública não comprimida (65 bytes, prefixo 0x04). */
export function publicKeyFromPrivate(privateKeyHex) {
  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.from(hexToBytes(privateKeyHex)));
  return new Uint8Array(ecdh.getPublicKey());
}

/** Endereço EVM com checksum EIP-55. */
export function addressFromPrivateKey(privateKeyHex) {
  const pub = publicKeyFromPrivate(privateKeyHex);
  const hash = keccak256(pub.subarray(1));           // descarta o prefixo 0x04
  return toChecksumAddress(bytesToHex(hash.subarray(12)));
}

export function createAccount() {
  const privateKey = generatePrivateKey();
  return { privateKey, address: addressFromPrivateKey(privateKey) };
}

export function accountFromPrivateKey(privateKeyHex) {
  const pk = privateKeyHex.startsWith('0x') ? privateKeyHex : '0x' + privateKeyHex;
  const k = BigInt(pk);
  if (k <= 0n || k >= N) throw new Error('private key is outside the valid secp256k1 range');
  return { privateKey: pk, address: addressFromPrivateKey(pk) };
}
