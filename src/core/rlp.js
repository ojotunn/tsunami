// RLP (Recursive Length Prefix) — a codificação que o Ethereum usa para
// serializar transações. Implementação própria, com decode incluído porque é o
// que permite testar a assinatura sem rede: assina, serializa, decodifica de
// volta e confere que o remetente recuperado é o esperado.
import { hexToBytes, bytesToHex, concatBytes } from './hex.js';

const isBytes = (v) => v instanceof Uint8Array;

/** Inteiro → bytes big-endian sem zeros à esquerda (0 vira vazio, por definição do RLP). */
export function toRlpBytes(value) {
  if (isBytes(value)) return value;
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return new Uint8Array(0);
  if (typeof value === 'boolean') return value ? new Uint8Array([1]) : new Uint8Array(0);
  if (typeof value === 'number' || typeof value === 'bigint') {
    const n = BigInt(value);
    if (n < 0n) throw new Error('RLP does not encode negative numbers');
    if (n === 0n) return new Uint8Array(0);
    let hex = n.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    return hexToBytes('0x' + hex);
  }
  if (typeof value === 'string') {
    if (value.startsWith('0x')) {
      const b = hexToBytes(value);
      // 0x00 num campo numérico é o mesmo que vazio; preserva bytes reais quando não for
      return b.length === 1 && b[0] === 0 ? new Uint8Array(0) : b;
    }
    return new TextEncoder().encode(value);
  }
  throw new Error(`RLP: unsupported value type ${typeof value}`);
}

function encodeLength(len, offset) {
  if (len < 56) return new Uint8Array([offset + len]);
  let hex = len.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const lenBytes = hexToBytes('0x' + hex);
  return concatBytes(new Uint8Array([offset + 55 + lenBytes.length]), lenBytes);
}

/** @param {any} input @returns {Uint8Array} */
export function rlpEncode(input) {
  if (Array.isArray(input)) {
    const body = concatBytes(...input.map(rlpEncode));
    return concatBytes(encodeLength(body.length, 0xc0), body);
  }
  const bytes = toRlpBytes(input);
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes;
  return concatBytes(encodeLength(bytes.length, 0x80), bytes);
}

function decodeAt(data, pos) {
  if (pos >= data.length) throw new Error('RLP: truncated input');
  const prefix = data[pos];

  if (prefix <= 0x7f) return { value: data.subarray(pos, pos + 1), next: pos + 1 };

  if (prefix <= 0xb7) {
    const len = prefix - 0x80;
    if (pos + 1 + len > data.length) throw new Error('RLP: truncated string');
    return { value: data.subarray(pos + 1, pos + 1 + len), next: pos + 1 + len };
  }

  if (prefix <= 0xbf) {
    const lenOfLen = prefix - 0xb7;
    const len = Number(BigInt(bytesToHex(data.subarray(pos + 1, pos + 1 + lenOfLen))));
    const start = pos + 1 + lenOfLen;
    if (start + len > data.length) throw new Error('RLP: truncated long string');
    return { value: data.subarray(start, start + len), next: start + len };
  }

  if (prefix <= 0xf7) {
    const len = prefix - 0xc0;
    return decodeList(data, pos + 1, pos + 1 + len);
  }

  const lenOfLen = prefix - 0xf7;
  const len = Number(BigInt(bytesToHex(data.subarray(pos + 1, pos + 1 + lenOfLen))));
  const start = pos + 1 + lenOfLen;
  return decodeList(data, start, start + len);
}

function decodeList(data, start, end) {
  if (end > data.length) throw new Error('RLP: truncated list');
  const items = [];
  let cursor = start;
  while (cursor < end) {
    const { value, next } = decodeAt(data, cursor);
    items.push(value);
    cursor = next;
  }
  return { value: items, next: end };
}

/** @returns {Uint8Array | Array} estrutura aninhada de buffers */
export function rlpDecode(input) {
  const data = isBytes(input) ? input : hexToBytes(input);
  if (!data.length) throw new Error('RLP: empty input');
  const { value, next } = decodeAt(data, 0);
  if (next !== data.length) throw new Error('RLP: trailing bytes after decoded value');
  return value;
}

/** Buffer RLP → BigInt (campos numéricos vêm sem zeros à esquerda). */
export const rlpToBigInt = (b) => (b.length === 0 ? 0n : BigInt(bytesToHex(b)));
export const rlpToAddress = (b) => (b.length === 0 ? null : bytesToHex(b));
