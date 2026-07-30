// Keystore Web3 Secret Storage V3 (o mesmo formato do geth/MetaMask).
// A chave privada do agente nunca é gravada em claro: scrypt + AES-128-CTR + MAC keccak256.
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, randomUUID, timingSafeEqual } from 'node:crypto';
import { keccak256 } from '../core/keccak.js';
import { hexToBytes, bytesToHex, concatBytes } from '../core/hex.js';
import { addressFromPrivateKey } from './account.js';

const KDF = { dklen: 32, n: 262144, r: 8, p: 1 };      // ~256 MB, padrão do geth
const MAXMEM = 1024 * 1024 * 1024;

const derive = (password, salt, params) =>
  scryptSync(Buffer.from(password, 'utf8'), salt, params.dklen, {
    N: params.n, r: params.r, p: params.p, maxmem: MAXMEM,
  });

export function encryptKeystore(privateKeyHex, password, opts = {}) {
  if (!password || password.length < 8) throw new Error('keystore password must be at least 8 characters');
  const params = { ...KDF, ...opts };
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const dk = derive(password, salt, params);

  const cipher = createCipheriv('aes-128-ctr', dk.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(hexToBytes(privateKeyHex))), cipher.final()]);
  const mac = keccak256(concatBytes(new Uint8Array(dk.subarray(16, 32)), new Uint8Array(ciphertext)));

  return {
    version: 3,
    id: randomUUID(),
    address: addressFromPrivateKey(privateKeyHex).slice(2).toLowerCase(),
    crypto: {
      cipher: 'aes-128-ctr',
      ciphertext: ciphertext.toString('hex'),
      cipherparams: { iv: iv.toString('hex') },
      kdf: 'scrypt',
      kdfparams: { dklen: params.dklen, n: params.n, r: params.r, p: params.p, salt: salt.toString('hex') },
      mac: bytesToHex(mac).slice(2),
    },
  };
}

export function decryptKeystore(keystore, password) {
  const c = keystore.crypto;
  if (keystore.version !== 3) throw new Error('only V3 keystores are supported');
  if (c.kdf !== 'scrypt') throw new Error(`unsupported kdf: ${c.kdf}`);

  const salt = Buffer.from(c.kdfparams.salt, 'hex');
  const dk = derive(password, salt, c.kdfparams);
  const ciphertext = Buffer.from(c.ciphertext, 'hex');

  const mac = Buffer.from(keccak256(concatBytes(new Uint8Array(dk.subarray(16, 32)), new Uint8Array(ciphertext))));
  const expected = Buffer.from(c.mac.replace(/^0x/, ''), 'hex');
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    throw new Error('wrong password or corrupted keystore (MAC mismatch)');
  }

  const decipher = createDecipheriv('aes-128-ctr', dk.subarray(0, 16), Buffer.from(c.cipherparams.iv, 'hex'));
  const pk = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return '0x' + pk.toString('hex');
}
