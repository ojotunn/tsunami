// Validação da curva secp256k1 própria.
// A checagem forte é cruzada: assinaturas produzidas aqui são aceitas pelo
// verificador ECDSA do node:crypto, e assinaturas do node são aceitas aqui.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  multiply, getPublicKey, addressFromPublicKey, sign, verify, recoverPublicKey,
  hashPersonalMessage, signPersonalMessage, recoverPersonalSignature,
  signatureToHex, signatureFromHex, N,
} from '../src/core/secp256k1.js';
import { createAccount, accountFromPrivateKey } from '../src/wallet/account.js';
import { bytesToHex, hexToBytes } from '../src/core/hex.js';

const G = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
};

const nodeKeyPair = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateKey, publicKey,
    pk: '0x' + Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url').toString('hex'),
    pubRaw: new Uint8Array(spki.subarray(spki.length - 65)),
  };
};

const toIeee = ({ r, s }) => Buffer.concat([
  Buffer.from(hexToBytes('0x' + r.toString(16).padStart(64, '0'))),
  Buffer.from(hexToBytes('0x' + s.toString(16).padStart(64, '0'))),
]);

// ---------------------------------------------------------------- curva

test('múltiplos de G batem com os valores públicos da secp256k1', () => {
  assert.equal(multiply(G, 2n).x.toString(16), 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5');
  assert.equal(multiply(G, 3n).x.toString(16), 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9');
  assert.equal(multiply(G, 5n).x.toString(16), '2f8bde4d1a07209355b4a7250a5c5128e88b84bddc619ab7cba8d569b240efe4');
});

test('derivação de chave pública concorda com o node:crypto', () => {
  for (let i = 0; i < 5; i++) {
    const k = nodeKeyPair();
    assert.equal(bytesToHex(getPublicKey(k.pk)), bytesToHex(k.pubRaw));
  }
});

test('endereço derivado da curva própria bate com o do node ECDH', () => {
  const acc = accountFromPrivateKey('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
  assert.equal(addressFromPublicKey(getPublicKey(acc.privateKey)), acc.address);
  assert.equal(acc.address, '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
});

// ---------------------------------------------------------------- assinatura

test('node:crypto aceita as assinaturas produzidas aqui', () => {
  for (let i = 0; i < 10; i++) {
    const k = nodeKeyPair();
    const msg = Buffer.from(`mensagem ${i}`);
    const digest = crypto.createHash('sha256').update(msg).digest();
    const mine = sign(digest, k.pk);
    assert.ok(
      crypto.verify('sha256', msg, { key: k.publicKey, dsaEncoding: 'ieee-p1363' }, toIeee(mine)),
      `node rejeitou a assinatura ${i}`,
    );
  }
});

test('o verificador próprio aceita as assinaturas do node:crypto', () => {
  for (let i = 0; i < 10; i++) {
    const k = nodeKeyPair();
    const msg = Buffer.from(`outra mensagem ${i}`);
    const digest = crypto.createHash('sha256').update(msg).digest();
    const ieee = crypto.sign('sha256', msg, { key: k.privateKey, dsaEncoding: 'ieee-p1363' });
    const sig = {
      r: BigInt(bytesToHex(ieee.subarray(0, 32))),
      s: BigInt(bytesToHex(ieee.subarray(32, 64))),
    };
    assert.ok(verify(digest, sig, k.pubRaw), `verificador próprio rejeitou a assinatura ${i} do node`);
  }
});

test('assinatura adulterada é rejeitada pelos dois verificadores', () => {
  const k = nodeKeyPair();
  const msg = Buffer.from('mensagem íntegra');
  const digest = crypto.createHash('sha256').update(msg).digest();
  const good = sign(digest, k.pk);
  const bad = { ...good, s: good.s + 1n };
  assert.equal(verify(digest, bad, k.pubRaw), false);
  assert.equal(crypto.verify('sha256', msg, { key: k.publicKey, dsaEncoding: 'ieee-p1363' }, toIeee(bad)), false);
});

test('RFC 6979: assinar duas vezes dá exatamente o mesmo resultado', () => {
  const acc = createAccount();
  const digest = crypto.createHash('sha256').update('determinismo').digest();
  const a = sign(digest, acc.privateKey);
  const b = sign(digest, acc.privateKey);
  assert.equal(a.r, b.r);
  assert.equal(a.s, b.s);
  assert.equal(a.recovery, b.recovery);
});

test('s é sempre normalizado para a metade baixa da ordem', () => {
  for (let i = 0; i < 20; i++) {
    const acc = createAccount();
    const digest = crypto.createHash('sha256').update(`baixo ${i}`).digest();
    assert.ok(sign(digest, acc.privateKey).s <= N >> 1n, 's alto não normalizado');
  }
});

// ---------------------------------------------------------------- recuperação

test('ecrecover devolve a chave pública que assinou', () => {
  for (let i = 0; i < 10; i++) {
    const acc = createAccount();
    const digest = crypto.createHash('sha256').update(`recuperar ${i}`).digest();
    const sig = sign(digest, acc.privateKey);
    assert.equal(
      bytesToHex(recoverPublicKey(digest, sig)),
      bytesToHex(getPublicKey(acc.privateKey)),
    );
  }
});

test('personal_sign: assinar e recuperar o endereço', () => {
  const acc = createAccount();
  const msg = 'pons-mm quer verificar que esta carteira é sua.\nnonce: abc123';
  const sigHex = signPersonalMessage(msg, acc.privateKey);
  assert.equal((sigHex.length - 2) / 2, 65, 'assinatura precisa ter 65 bytes');
  assert.equal(recoverPersonalSignature(msg, sigHex), acc.address);
});

test('mudar um caractere da mensagem muda o endereço recuperado', () => {
  const acc = createAccount();
  const sigHex = signPersonalMessage('mensagem original', acc.privateKey);
  assert.notEqual(recoverPersonalSignature('mensagem originaI', sigHex), acc.address);
});

test('serialização da assinatura sobrevive ao round-trip', () => {
  const acc = createAccount();
  const digest = crypto.createHash('sha256').update('serializar').digest();
  const sig = sign(digest, acc.privateKey);
  const back = signatureFromHex(signatureToHex(sig));
  assert.equal(back.r, sig.r);
  assert.equal(back.s, sig.s);
  assert.equal(back.recovery, sig.recovery);
});

test('assinatura malformada é recusada com erro claro', () => {
  assert.throws(() => signatureFromHex('0x1234'), /must be 65 bytes/);
  assert.throws(() => recoverPublicKey(new Uint8Array(32), { r: 0n, s: 1n, recovery: 0 }), /out of range|outside the valid/);
  assert.throws(() => recoverPublicKey(new Uint8Array(32), { r: 1n, s: 1n, recovery: 9 }), /invalid recovery id/);
});

test('hashPersonalMessage segue o prefixo EIP-191', () => {
  // o prefixo entra no hash: mensagens de tamanhos diferentes não colidem
  assert.notEqual(bytesToHex(hashPersonalMessage('a')), bytesToHex(hashPersonalMessage('aa')));
  assert.equal(hashPersonalMessage('teste').length, 32);
});
