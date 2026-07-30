// Codec ABI mínimo e sem dependências. Cobre os tipos usados pelos contratos
// da Pons e da Uniswap V3: address, bool, uintN, intN, bytesN, string, bytes,
// arrays dinâmicos e tuplas (incluindo tuplas com campos dinâmicos).
import { keccak256 } from './keccak.js';
import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8, concatBytes, toChecksumAddress } from './hex.js';

const WORD = 32;

/** Assinatura canônica de um componente ABI (resolve tuplas para (a,b,c)). */
export function canonicalType(c) {
  if (c.type.startsWith('tuple')) {
    const inner = '(' + (c.components || []).map(canonicalType).join(',') + ')';
    return inner + c.type.slice('tuple'.length); // preserva sufixo de array
  }
  return c.type;
}

export function signatureOf(item) {
  return `${item.name}(${(item.inputs || []).map(canonicalType).join(',')})`;
}

export const selectorOf = (item) => bytesToHex(keccak256(utf8ToBytes(signatureOf(item)))).slice(0, 10);
export const topicOf = (item) => bytesToHex(keccak256(utf8ToBytes(signatureOf(item))));

const arrayInfo = (type) => {
  const m = /^(.*)\[(\d*)\]$/.exec(type);
  return m ? { base: m[1], length: m[2] === '' ? null : Number(m[2]) } : null;
};

export function isDynamic(c) {
  const arr = arrayInfo(c.type);
  if (arr) {
    if (arr.length === null) return true;
    return isDynamic({ ...c, type: arr.base });
  }
  if (c.type === 'string' || c.type === 'bytes') return true;
  if (c.type === 'tuple') return (c.components || []).some(isDynamic);
  return false;
}

// ---------------------------------------------------------------- encode

const padLeft = (b) => { const o = new Uint8Array(WORD); o.set(b, WORD - b.length); return o; };
const padRight = (b) => {
  const len = Math.ceil(b.length / WORD) * WORD || WORD;
  const o = new Uint8Array(len); o.set(b); return o;
};

function bigToWord(v, signed) {
  let x = BigInt(v);
  if (x < 0n) {
    if (!signed) throw new Error('negative value in an unsigned type');
    x = (1n << 256n) + x;
  }
  const hex = x.toString(16).padStart(64, '0');
  if (hex.length > 64) throw new Error('value exceeds 256 bits');
  return hexToBytes('0x' + hex);
}

function encodeValue(c, v) {
  const arr = arrayInfo(c.type);
  if (arr) {
    const base = { ...c, type: arr.base };
    const items = Array.from(v);
    if (arr.length !== null && items.length !== arr.length) throw new Error('invalid fixed-array length');
    const body = encodeTuple(items.map(() => base), items);
    return arr.length === null ? concatBytes(bigToWord(items.length, false), body) : body;
  }
  if (c.type === 'tuple') {
    const comps = c.components || [];
    const values = Array.isArray(v) ? v : comps.map((k) => v[k.name]);
    return encodeTuple(comps, values);
  }
  if (c.type === 'address') return padLeft(hexToBytes(v));
  if (c.type === 'bool') return bigToWord(v ? 1 : 0, false);
  if (c.type === 'string') { const b = utf8ToBytes(v); return concatBytes(bigToWord(b.length, false), padRight(b)); }
  if (c.type === 'bytes') { const b = hexToBytes(v); return concatBytes(bigToWord(b.length, false), padRight(b)); }
  if (/^bytes\d+$/.test(c.type)) { const b = hexToBytes(v); const o = new Uint8Array(WORD); o.set(b); return o; }
  if (/^uint\d*$/.test(c.type)) return bigToWord(v, false);
  if (/^int\d*$/.test(c.type)) return bigToWord(v, true);
  throw new Error(`unsupported type: ${c.type}`);
}

export function encodeTuple(components, values) {
  const encoded = components.map((c, i) => encodeValue(c, values[i]));
  const headSize = components.reduce((n, c, i) => n + (isDynamic(c) ? WORD : encoded[i].length), 0);

  const heads = [];
  const tails = [];
  let tailOffset = headSize;
  components.forEach((c, i) => {
    if (isDynamic(c)) { heads.push(bigToWord(tailOffset, false)); tails.push(encoded[i]); tailOffset += encoded[i].length; }
    else heads.push(encoded[i]);
  });
  return concatBytes(...heads, ...tails);
}

export function encodeFunctionData(item, values = []) {
  return selectorOf(item) + Buffer.from(encodeTuple(item.inputs || [], values)).toString('hex');
}

// ---------------------------------------------------------------- decode

function readWord(data, off) {
  if (off + WORD > data.length) throw new Error('truncated ABI data');
  return data.subarray(off, off + WORD);
}
const wordToBig = (w) => BigInt(bytesToHex(w));
function wordToInt(w) {
  const u = wordToBig(w);
  return u >= 1n << 255n ? u - (1n << 256n) : u;
}

function decodeValue(c, data, off, base) {
  const arr = arrayInfo(c.type);
  if (arr) {
    const inner = { ...c, type: arr.base };
    if (arr.length === null) {
      const ptr = Number(wordToBig(readWord(data, off)));
      const n = Number(wordToBig(readWord(data, base + ptr)));
      const start = base + ptr + WORD;
      return { value: decodeTuple(new Array(n).fill(inner), data, start).values, size: WORD };
    }
    const comps = new Array(arr.length).fill(inner);
    if (isDynamic(inner)) {
      const ptr = Number(wordToBig(readWord(data, off)));
      return { value: decodeTuple(comps, data, base + ptr).values, size: WORD };
    }
    const r = decodeTuple(comps, data, off);
    return { value: r.values, size: r.size };
  }
  if (c.type === 'tuple') {
    const comps = c.components || [];
    if (isDynamic(c)) {
      const ptr = Number(wordToBig(readWord(data, off)));
      return { value: decodeTuple(comps, data, base + ptr).named, size: WORD };
    }
    const r = decodeTuple(comps, data, off);
    return { value: r.named, size: r.size };
  }
  if (c.type === 'string' || c.type === 'bytes') {
    const ptr = Number(wordToBig(readWord(data, off)));
    const len = Number(wordToBig(readWord(data, base + ptr)));
    const raw = data.subarray(base + ptr + WORD, base + ptr + WORD + len);
    return { value: c.type === 'string' ? bytesToUtf8(raw) : bytesToHex(raw), size: WORD };
  }
  const w = readWord(data, off);
  if (c.type === 'address') return { value: toChecksumAddress(bytesToHex(w.subarray(12))), size: WORD };
  if (c.type === 'bool') return { value: wordToBig(w) !== 0n, size: WORD };
  if (/^bytes(\d+)$/.test(c.type)) {
    const n = Number(/^bytes(\d+)$/.exec(c.type)[1]);
    return { value: bytesToHex(w.subarray(0, n)), size: WORD };
  }
  if (/^uint\d*$/.test(c.type)) return { value: wordToBig(w), size: WORD };
  if (/^int\d*$/.test(c.type)) return { value: wordToInt(w), size: WORD };
  throw new Error(`unsupported type: ${c.type}`);
}

export function decodeTuple(components, data, base = 0) {
  const values = [];
  const named = {};
  let off = base;
  components.forEach((c, i) => {
    const { value, size } = decodeValue(c, data, off, base);
    values.push(value);
    named[c.name || String(i)] = value;
    off += size;
  });
  return { values, named, size: off - base };
}

export function decodeFunctionResult(item, hexData) {
  const data = hexToBytes(hexData);
  const outs = item.outputs || [];
  const { values, named } = decodeTuple(outs, data, 0);
  return outs.length === 1 ? values[0] : { ...named, _values: values };
}

/** Decodifica um log a partir de um item de evento da ABI. */
export function decodeEventLog(item, log) {
  const inputs = item.inputs || [];
  const indexed = inputs.filter((i) => i.indexed);
  const body = inputs.filter((i) => !i.indexed);
  const out = {};

  indexed.forEach((c, i) => {
    const topic = log.topics[i + 1];
    if (topic === undefined) return;
    if (isDynamic(c)) { out[c.name] = topic; return; } // hash do valor
    out[c.name] = decodeValue(c, hexToBytes(topic), 0, 0).value;
  });

  const data = hexToBytes(log.data || '0x');
  if (body.length) {
    const { named } = decodeTuple(body, data, 0);
    Object.assign(out, named);
  }
  return out;
}
