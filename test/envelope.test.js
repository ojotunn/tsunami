// Envelope de servidor sobre o keystore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, open, isSealed, generateMasterKey, warnIfUnsealed } from '../src/wallet/envelope.js';
import { encryptKeystore, decryptKeystore } from '../src/wallet/keystore.js';
import { createAccount } from '../src/wallet/account.js';

const KEY = generateMasterKey();
const OUTRA = generateMasterKey();

test('chave mestra gerada tem 32 bytes', () => {
  assert.equal(generateMasterKey().length, 64);
  assert.notEqual(generateMasterKey(), generateMasterKey());
});

test('sem chave mestra o keystore passa intacto', () => {
  const ks = { version: 3, address: 'abc' };
  assert.deepEqual(seal(ks, null), ks);
  assert.equal(isSealed(seal(ks, null)), false);
});

test('com chave mestra o conteúdo deixa de ser legível', () => {
  const ks = { version: 3, address: 'deadbeef', crypto: { ciphertext: 'segredo' } };
  const sealed = seal(ks, KEY);
  assert.ok(isSealed(sealed));
  assert.ok(!JSON.stringify(sealed).includes('segredo'), 'o texto original não pode aparecer');
  assert.ok(!JSON.stringify(sealed).includes('deadbeef'));
  assert.deepEqual(open(sealed, KEY), ks);
});

test('chave mestra errada não abre', () => {
  const sealed = seal({ version: 3, a: 1 }, KEY);
  assert.throws(() => open(sealed, OUTRA), /could not open the keystore envelope/);
});

test('envelope adulterado é rejeitado pelo GCM', () => {
  const sealed = seal({ version: 3, a: 1 }, KEY);
  const bytes = Buffer.from(sealed.data, 'base64');
  bytes[0] ^= 0xff;
  assert.throws(() => open({ ...sealed, data: bytes.toString('base64') }, KEY), /could not open/);
});

test('abrir sem a chave dá erro claro em vez de lixo', () => {
  const sealed = seal({ version: 3 }, KEY);
  assert.throws(() => open(sealed, null), /PONS_MASTER_KEY is not set/);
});

test('keystore antigo sem envelope continua abrindo', () => {
  const antigo = { version: 3, address: 'abc', crypto: {} };
  assert.deepEqual(open(antigo, KEY), antigo);
});

test('o ciclo completo funciona: cifrar, selar, abrir, decifrar', () => {
  const acc = createAccount();
  const ks = encryptKeystore(acc.privateKey, 'senha-do-usuario-1', { n: 1024 });
  const noDisco = seal(ks, KEY);
  assert.ok(!JSON.stringify(noDisco).includes(ks.crypto.ciphertext));
  assert.equal(decryptKeystore(open(noDisco, KEY), 'senha-do-usuario-1'), acc.privateKey);
});

test('a senha do usuário continua necessária mesmo com a chave mestra', () => {
  const acc = createAccount();
  const sealed = seal(encryptKeystore(acc.privateKey, 'senha-do-usuario-1', { n: 1024 }), KEY);
  assert.throws(() => decryptKeystore(open(sealed, KEY), 'senha-errada-99'), /MAC mismatch/);
});

test('avisa quando sobe sem chave mestra', () => {
  const antes = process.env.PONS_MASTER_KEY;
  delete process.env.PONS_MASTER_KEY;
  let aviso = null;
  assert.equal(warnIfUnsealed((m) => { aviso = m; }), false);
  assert.match(aviso, /PONS_MASTER_KEY is not set/);
  if (antes) process.env.PONS_MASTER_KEY = antes;
});
