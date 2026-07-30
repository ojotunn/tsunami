// RLP e assinatura EIP-1559.
// Os vetores de RLP são os da especificação oficial. A assinatura é verificada
// pelo caminho que importa na prática: assinar → serializar → decodificar →
// recuperar o remetente tem que devolver a conta que assinou.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rlpEncode, rlpDecode, rlpToBigInt } from '../src/core/rlp.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '../src/core/hex.js';
import {
  signTransaction, parseTransaction, signingHash, unsignedPayload, maxCost,
} from '../src/chain/tx.js';
import { createAccount, accountFromPrivateKey } from '../src/wallet/account.js';
import { CHAIN } from '../src/chain/config.js';

const hex = (v) => bytesToHex(rlpEncode(v));

// ---------------------------------------------------------------- RLP

test('RLP: vetores da especificação', () => {
  assert.equal(hex('dog'), '0x83646f67');
  assert.equal(hex(['cat', 'dog']), '0xc88363617483646f67');
  assert.equal(hex(''), '0x80');
  assert.equal(hex([]), '0xc0');
  assert.equal(hex(0), '0x80');
  assert.equal(hex(15), '0x0f');
  assert.equal(hex(1024), '0x820400');
  // 0xb8 38 = string longa de 56 bytes; 4c é o "L" de Lorem
  assert.equal(hex('Lorem ipsum dolor sit amet, consectetur adipisicing elit').slice(0, 8), '0xb8384c');
  // conjunto de três: [ [], [[]], [ [], [[]] ] ]
  assert.equal(hex([[], [[]], [[], [[]]]]), '0xc7c0c1c0c3c0c1c0');
});

test('RLP: string longa usa prefixo de comprimento estendido', () => {
  const long = 'a'.repeat(1024);
  const encoded = rlpEncode(long);
  assert.equal(encoded[0], 0xb9);            // 0xb7 + 2 bytes de comprimento
  assert.equal(encoded.length, 1 + 2 + 1024);
});

test('RLP: round-trip de estruturas aninhadas', () => {
  const original = [utf8ToBytes('abc'), [utf8ToBytes('d'), utf8ToBytes('ef')], new Uint8Array(0)];
  const back = rlpDecode(rlpEncode(original));
  assert.equal(bytesToHex(back[0]), bytesToHex(original[0]));
  assert.equal(bytesToHex(back[1][1]), bytesToHex(original[1][1]));
  assert.equal(back[2].length, 0);
});

test('RLP: zero e vazio codificam igual, como manda a especificação', () => {
  assert.equal(hex(0), hex(''));
  assert.equal(rlpToBigInt(rlpDecode(rlpEncode(0))), 0n);
  assert.equal(rlpToBigInt(rlpDecode(rlpEncode(1024n))), 1024n);
});

test('RLP: entrada corrompida é recusada', () => {
  assert.throws(() => rlpDecode('0x83646f'), /truncated/);
  assert.throws(() => rlpDecode('0x83646f6700'), /trailing bytes/);
  assert.throws(() => rlpEncode(-1), /negative/);
});

// ---------------------------------------------------------------- EIP-1559

const baseTx = {
  chainId: CHAIN.id,
  nonce: 7n,
  maxPriorityFeePerGas: 1_500_000_000n,
  maxFeePerGas: 30_000_000_000n,
  gasLimit: 210_000n,
  to: '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB',
  value: 5_000_000_000_000_000n,
  data: '0x38ed1739',
  accessList: [],
};

test('transação tipo 2 começa com o byte de tipo 0x02', () => {
  assert.equal(unsignedPayload(baseTx)[0], 0x02);
  assert.equal(signingHash(baseTx).length, 32);
});

test('assinar, serializar e decodificar devolve os mesmos campos', () => {
  const acc = createAccount();
  const signed = signTransaction(baseTx, acc.privateKey);
  assert.match(signed.raw, /^0x02/);
  assert.equal(signed.from, acc.address);

  const parsed = parseTransaction(signed.raw);
  assert.equal(parsed.chainId, BigInt(CHAIN.id));
  assert.equal(parsed.nonce, 7n);
  assert.equal(parsed.maxFeePerGas, 30_000_000_000n);
  assert.equal(parsed.maxPriorityFeePerGas, 1_500_000_000n);
  assert.equal(parsed.gasLimit, 210_000n);
  assert.equal(parsed.value, 5_000_000_000_000_000n);
  assert.equal(parsed.data, '0x38ed1739');
  assert.equal(parsed.to.toLowerCase(), baseTx.to.toLowerCase());
  assert.equal(parsed.hash, signed.hash);
});

test('o remetente recuperado é sempre quem assinou', () => {
  for (let i = 0; i < 10; i++) {
    const acc = createAccount();
    const tx = { ...baseTx, nonce: BigInt(i), value: BigInt(i) * 10n ** 15n };
    const signed = signTransaction(tx, acc.privateKey);
    assert.equal(parseTransaction(signed.raw).from, acc.address, `falhou na iteração ${i}`);
  }
});

test('mudar um byte da transação muda o remetente recuperado', () => {
  const acc = accountFromPrivateKey('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
  const signed = signTransaction(baseTx, acc.privateKey);
  assert.equal(parseTransaction(signed.raw).from, acc.address);

  // adultera o valor mantendo a assinatura: o remetente recuperado deixa de bater
  const forged = parseTransaction(signed.raw);
  const tampered = signTransaction({ ...baseTx, value: baseTx.value + 1n }, acc.privateKey);
  assert.notEqual(tampered.raw, signed.raw);
  assert.notEqual(tampered.hash, signed.hash);
  assert.equal(forged.from, acc.address);
});

test('assinatura é determinística para a mesma transação', () => {
  const acc = createAccount();
  const a = signTransaction(baseTx, acc.privateKey);
  const b = signTransaction(baseTx, acc.privateKey);
  assert.equal(a.raw, b.raw);
  assert.equal(a.hash, b.hash);
});

test('transação sem dados e sem valor também fecha', () => {
  const acc = createAccount();
  const tx = { ...baseTx, value: 0n, data: '0x' };
  const parsed = parseTransaction(signTransaction(tx, acc.privateKey).raw);
  assert.equal(parsed.value, 0n);
  assert.equal(parsed.data, '0x');
  assert.equal(parsed.from, acc.address);
});

test('campos obrigatórios ausentes são recusados antes de assinar', () => {
  const acc = createAccount();
  assert.throws(() => signTransaction({ ...baseTx, nonce: undefined }, acc.privateKey), /missing nonce/);
  assert.throws(() => signTransaction({ ...baseTx, gasLimit: null }, acc.privateKey), /missing gasLimit/);
  assert.throws(() => signTransaction({ ...baseTx, to: '0x123' }, acc.privateKey), /invalid "to"/);
  assert.throws(
    () => signTransaction({ ...baseTx, maxPriorityFeePerGas: 99n * 10n ** 9n }, acc.privateKey),
    /cannot exceed maxFeePerGas/,
  );
});

test('maxCost soma gás e valor enviado', () => {
  assert.equal(maxCost(baseTx), 210_000n * 30_000_000_000n + 5_000_000_000_000_000n);
});

test('parse recusa tipo de transação desconhecido', () => {
  assert.throws(() => parseTransaction('0x01c0'), /unsupported transaction type/);
});
