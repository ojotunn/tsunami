// secp256k1: assinatura, recuperação de chave pública (ecrecover) e verificação.
// Implementação própria sobre BigInt — sem dependências.
//
// Serve a dois propósitos:
//  1. login por assinatura de carteira (o servidor recupera o endereço de um
//     personal_sign e sabe quem é o usuário sem nunca ver a chave dele);
//  2. base para a assinatura de transações EIP-1559 na fase de execução.
//
// A correção é verificada na suíte de testes por dois caminhos independentes:
// as assinaturas produzidas aqui são validadas pelo verificador do node:crypto,
// e o par assinar→recuperar precisa devolver o mesmo endereço.
import { createHmac } from 'node:crypto';
import { keccak256 } from './keccak.js';
import { hexToBytes, bytesToHex, concatBytes, utf8ToBytes, toChecksumAddress } from './hex.js';

export const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const Gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const Gy = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
const G = { x: Gx, y: Gy };
const HALF_N = N >> 1n;

const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };

/** Inverso modular por Euclides estendido. */
function invMod(a, m) {
  let [old_r, r] = [mod(a, m), m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) throw new Error('no modular inverse');
  return mod(old_s, m);
}

// ------------------------------------------------ pontos em coordenadas jacobianas
// (evita uma inversão modular por operação; converte para afim só no fim)

const toJ = (p) => (p === null ? { x: 1n, y: 1n, z: 0n } : { x: p.x, y: p.y, z: 1n });

function toAffine(j) {
  if (j.z === 0n) return null;                       // ponto no infinito
  const zi = invMod(j.z, P);
  const zi2 = mod(zi * zi);
  return { x: mod(j.x * zi2), y: mod(j.y * zi2 * zi) };
}

function jDouble(j) {
  if (j.y === 0n || j.z === 0n) return { x: 1n, y: 1n, z: 0n };
  const a = mod(j.x * j.x);
  const b = mod(j.y * j.y);
  const c = mod(b * b);
  const d = mod(2n * (mod((j.x + b) * (j.x + b)) - a - c));
  const e = mod(3n * a);                              // curva com a = 0
  const f = mod(e * e);
  return {
    x: mod(f - 2n * d),
    y: mod(e * (d - mod(f - 2n * d)) - 8n * c),
    z: mod(2n * j.y * j.z),
  };
}

function jAdd(p, q) {
  if (p.z === 0n) return q;
  if (q.z === 0n) return p;
  const z1z1 = mod(p.z * p.z);
  const z2z2 = mod(q.z * q.z);
  const u1 = mod(p.x * z2z2);
  const u2 = mod(q.x * z1z1);
  const s1 = mod(p.y * q.z * z2z2);
  const s2 = mod(q.y * p.z * z1z1);
  const h = mod(u2 - u1);
  const r = mod(2n * (s2 - s1));
  if (h === 0n) return r === 0n ? jDouble(p) : { x: 1n, y: 1n, z: 0n };
  const i = mod(mod(2n * h) * mod(2n * h));
  const j = mod(h * i);
  const v = mod(u1 * i);
  const x3 = mod(r * r - j - 2n * v);
  return {
    x: x3,
    y: mod(r * (v - x3) - 2n * s1 * j),
    z: mod(mod((p.z + q.z) * (p.z + q.z)) - z1z1 - z2z2) * h % P,
  };
}

/** Multiplicação escalar por duplo-e-soma. */
export function multiply(point, scalar) {
  let k = mod(scalar, N);
  if (k === 0n) return null;
  let acc = { x: 1n, y: 1n, z: 0n };
  let add = toJ(point);
  while (k > 0n) {
    if (k & 1n) acc = jAdd(acc, add);
    add = jDouble(add);
    k >>= 1n;
  }
  return toAffine(acc);
}

const addPoints = (a, b) => (a === null ? b : b === null ? a : toAffine(jAdd(toJ(a), toJ(b))));

/** y² = x³ + 7 — raiz quadrada modular (p ≡ 3 mod 4). */
function decompress(x, yIsOdd) {
  const ySq = mod(x * x * x + 7n);
  const y = powMod(ySq, (P + 1n) / 4n, P);
  if (mod(y * y) !== ySq) throw new Error('x is not on the curve');
  return { x, y: (y & 1n) === (yIsOdd ? 1n : 0n) ? y : P - y };
}

function powMod(base, exp, m) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b, m);
    b = mod(b * b, m);
    e >>= 1n;
  }
  return result;
}

// ------------------------------------------------ chaves

export function getPublicKey(privateKey, compressed = false) {
  const d = BigInt(privateKey);
  if (d <= 0n || d >= N) throw new Error('private key out of range');
  const p = multiply(G, d);
  if (compressed) {
    return concatBytes(new Uint8Array([(p.y & 1n) === 1n ? 0x03 : 0x02]), be32(p.x));
  }
  return concatBytes(new Uint8Array([0x04]), be32(p.x), be32(p.y));
}

const be32 = (v) => hexToBytes('0x' + v.toString(16).padStart(64, '0'));

export const addressFromPublicKey = (pub) =>
  toChecksumAddress(bytesToHex(keccak256(pub.subarray(1)).subarray(12)));

// ------------------------------------------------ RFC 6979

function rfc6979k(hashBytes, privateKey) {
  const x = be32(BigInt(privateKey));
  const h1 = be32(mod(BigInt(bytesToHex(hashBytes)), N));   // bits2octets
  let V = new Uint8Array(32).fill(0x01);
  let K = new Uint8Array(32).fill(0x00);
  const hmac = (key, ...data) => new Uint8Array(
    data.reduce((h, d) => h.update(Buffer.from(d)), createHmac('sha256', Buffer.from(key))).digest(),
  );

  K = hmac(K, V, new Uint8Array([0x00]), x, h1);
  V = hmac(K, V);
  K = hmac(K, V, new Uint8Array([0x01]), x, h1);
  V = hmac(K, V);

  for (let i = 0; i < 1000; i++) {
    V = hmac(K, V);
    const k = BigInt(bytesToHex(V));
    if (k > 0n && k < N) return k;
    K = hmac(K, V, new Uint8Array([0x00]));
    V = hmac(K, V);
  }
  throw new Error('RFC6979 did not converge');
}

// ------------------------------------------------ assinar / recuperar

/**
 * Assina um hash de 32 bytes. Determinístico (RFC 6979) e com s baixo,
 * como exige o Ethereum.
 * @returns {{r: bigint, s: bigint, recovery: number}}
 */
export function sign(msgHash, privateKey) {
  const hash = typeof msgHash === 'string' ? hexToBytes(msgHash) : msgHash;
  if (hash.length !== 32) throw new Error('hash must be 32 bytes');
  const d = BigInt(privateKey);
  const z = mod(BigInt(bytesToHex(hash)), N);

  const k = rfc6979k(hash, privateKey);
  const R = multiply(G, k);
  const r = mod(R.x, N);
  if (r === 0n) throw new Error('invalid r; change the message');

  let s = mod(invMod(k, N) * (z + r * d), N);
  let recovery = Number((R.y & 1n) | (R.x >= N ? 2n : 0n));
  if (s > HALF_N) { s = N - s; recovery ^= 1; }        // normalização de s baixo
  return { r, s, recovery };
}

/** Recupera a chave pública não comprimida a partir da assinatura. */
export function recoverPublicKey(msgHash, { r, s, recovery }) {
  const hash = typeof msgHash === 'string' ? hexToBytes(msgHash) : msgHash;
  const z = mod(BigInt(bytesToHex(hash)), N);
  if (r <= 0n || r >= N || s <= 0n || s >= N) throw new Error('signature values out of range');
  if (recovery < 0 || recovery > 3) throw new Error('invalid recovery id');

  const x = r + (recovery >> 1 ? N : 0n);
  if (x >= P) throw new Error('x is outside the field');
  const R = decompress(x, (recovery & 1) === 1);

  const rInv = invMod(r, N);
  // Q = r⁻¹ (sR − zG)
  const sR = multiply(R, s);
  const zG = multiply(G, mod(-z, N));
  const sum = addPoints(sR, zG);
  if (sum === null) throw new Error('recovery failed');
  const Q = multiply(sum, rInv);
  if (Q === null) throw new Error('recovery failed');
  return concatBytes(new Uint8Array([0x04]), be32(Q.x), be32(Q.y));
}

export function verify(msgHash, { r, s }, publicKey) {
  try {
    const hash = typeof msgHash === 'string' ? hexToBytes(msgHash) : msgHash;
    const z = mod(BigInt(bytesToHex(hash)), N);
    if (r <= 0n || r >= N || s <= 0n || s >= N) return false;
    const pub = { x: BigInt(bytesToHex(publicKey.subarray(1, 33))), y: BigInt(bytesToHex(publicKey.subarray(33, 65))) };
    const sInv = invMod(s, N);
    const u1 = mod(z * sInv, N);
    const u2 = mod(r * sInv, N);
    const point = addPoints(multiply(G, u1), multiply(pub, u2));
    return point !== null && mod(point.x, N) === r;
  } catch { return false; }
}

// ------------------------------------------------ EIP-191 / personal_sign

/** Hash do padrão "\x19Ethereum Signed Message:\n<len><msg>". */
export function hashPersonalMessage(message) {
  const msg = typeof message === 'string' ? utf8ToBytes(message) : message;
  return keccak256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), msg));
}

/** Assinatura serializada de 65 bytes (r ‖ s ‖ v), como as carteiras devolvem. */
export function signatureToHex({ r, s, recovery }, chainId = null) {
  const v = chainId === null ? recovery + 27 : recovery + 35 + 2 * Number(chainId);
  return bytesToHex(concatBytes(be32(r), be32(s), new Uint8Array([v])));
}

export function signatureFromHex(hex) {
  const b = hexToBytes(hex);
  if (b.length !== 65) throw new Error('signature must be 65 bytes');
  const v = b[64];
  const recovery = v >= 35 ? (v - 35) % 2 : v >= 27 ? v - 27 : v;
  return {
    r: BigInt(bytesToHex(b.subarray(0, 32))),
    s: BigInt(bytesToHex(b.subarray(32, 64))),
    recovery,
  };
}

/** Endereço que assinou uma mensagem com personal_sign. */
export function recoverPersonalSignature(message, signatureHex) {
  const sig = signatureFromHex(signatureHex);
  const pub = recoverPublicKey(hashPersonalMessage(message), sig);
  return addressFromPublicKey(pub);
}

export function signPersonalMessage(message, privateKey) {
  return signatureToHex(sign(hashPersonalMessage(message), privateKey));
}
