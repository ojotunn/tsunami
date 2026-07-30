import { keccak256 } from './keccak.js';

export const bytesToHex = (b) => '0x' + Buffer.from(b).toString('hex');

export function hexToBytes(h) {
  let s = String(h).startsWith('0x') ? String(h).slice(2) : String(h);
  if (s.length % 2) s = '0' + s;
  return new Uint8Array(Buffer.from(s, 'hex'));
}

export const utf8ToBytes = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
export const bytesToUtf8 = (b) => Buffer.from(b).toString('utf8');

export const hexToBigInt = (h) => BigInt(h);
export const hexToNumber = (h) => Number(BigInt(h));
export const numberToHex = (n) => '0x' + BigInt(n).toString(16);

export function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}

/** keccak256 de uma string utf-8, em hex */
export const keccakHex = (s) => bytesToHex(keccak256(typeof s === 'string' ? utf8ToBytes(s) : s));

/** Endereço com checksum EIP-55 */
export function toChecksumAddress(address) {
  const lower = address.toLowerCase().replace(/^0x/, '');
  const hash = Buffer.from(keccak256(utf8ToBytes(lower))).toString('hex');
  let out = '0x';
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

export const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
export const eqAddress = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
