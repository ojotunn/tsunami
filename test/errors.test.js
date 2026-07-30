// Decodificação de reverts.
//
// Existe porque a MetaMask diz "this transaction is likely to fail" e para por
// aí. O contrato sempre explica o motivo, num seletor de 4 bytes. Se este
// módulo errar o seletor, o usuário volta a receber um erro mudo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorSelector, decodeRevert, explainRevert, explainRpcError, LOCKER_ERRORS } from '../src/chain/errors.js';

const sel = (name, types = []) => errorSelector({ name, inputs: types.map((t) => ({ type: t })) });

test('seletores batem com os valores conhecidos', () => {
  // OwnableUnauthorizedAccount(address) é do OpenZeppelin e tem valor publicado.
  assert.equal(sel('OwnableUnauthorizedAccount', ['address']), '0x118cdaa7');
  // Os do locker foram derivados da ABI verificada; travados aqui para não
  // mudarem em silêncio se alguém editar a lista.
  assert.equal(sel('NotDeployer'), '0x8b906c97');
  assert.equal(sel('NotAuthorized'), '0xea8e4eb5');
});

test('nenhum seletor colide dentro da tabela do locker', () => {
  const seen = new Set(LOCKER_ERRORS.map((e) => errorSelector(e)));
  assert.equal(seen.size, LOCKER_ERRORS.length);
});

test('erro customizado sem argumentos é reconhecido pelo nome', () => {
  const d = decodeRevert(sel('NotDeployer'));
  assert.equal(d.kind, 'custom');
  assert.equal(d.name, 'NotDeployer');
});

test('erro customizado com endereço devolve o argumento decodificado', () => {
  const addr = '0x1111111111111111111111111111111111111111';
  const data = sel('OwnableUnauthorizedAccount', ['address']) + '0'.repeat(24) + addr.slice(2);
  const d = decodeRevert(data);
  assert.equal(d.name, 'OwnableUnauthorizedAccount');
  assert.equal(String(d.args.account).toLowerCase(), addr);
});

test('Error(string) devolve a razão em texto', () => {
  // abi.encodeWithSignature("Error(string)", "no fees") — offset, tamanho, dados
  const data = '0x08c379a0' +
    '0000000000000000000000000000000000000000000000000000000000000020' +
    '0000000000000000000000000000000000000000000000000000000000000007' +
    Buffer.from('no fees', 'utf8').toString('hex').padEnd(64, '0');
  const d = decodeRevert(data);
  assert.equal(d.name, 'Error');
  assert.equal(d.reason, 'no fees');
});

test('seletor desconhecido não vira palpite', () => {
  const d = decodeRevert('0xdeadbeef');
  assert.equal(d.kind, 'unknown');
  assert.equal(d.selector, '0xdeadbeef');
  assert.match(explainRevert(d), /does not recognize/);
});

test('payload ausente devolve null em vez de inventar', () => {
  assert.equal(decodeRevert(undefined), null);
  assert.equal(decodeRevert('0x'), null);
  assert.equal(explainRevert(null), null);
});

test('a explicação de NotDeployer diz quem pode assinar', () => {
  const d = decodeRevert(sel('NotDeployer'));
  const msg = explainRevert(d, { deployer: '0xAbC0000000000000000000000000000000000001' });
  assert.match(msg, /Only the wallet that launched this token/);
  assert.match(msg, /0xAbC0000000000000000000000000000000000001/);
});

test('erro de RPC sem payload não vira explicação falsa', () => {
  const { decoded, human } = explainRpcError(new Error('eth_call: execution reverted (3)'));
  assert.equal(decoded, null);
  assert.match(human, /without saying why/);
});

test('erro de rede é reportado como erro de rede, não como revert', () => {
  const { human } = explainRpcError(new Error('fetch failed'));
  assert.match(human, /Could not simulate/);
});
