// Inspeção de endereço de token.
//
// O locker responde `TokenNotFound` para causas muito diferentes: endereço de
// outra rede, endereço de carteira, token de outra plataforma. Estes testes
// travam a separação entre elas — é ela que transforma um erro num próximo passo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectToken } from '../src/chain/token.js';
import { CONTRACTS } from '../src/chain/config.js';

const TOKEN = '0x1111111111111111111111111111111111111111';

/** RPC de mentira: só o que a inspeção usa, controlado por caso. */
const fakeRpc = ({ code = '0x60', erc20 = { name: 'Test', symbol: 'TST', decimals: 18n }, launched = null } = {}) => ({
  call: async (method) => (method === 'eth_getCode' ? code : '0x'),
  read: async (address, item) => {
    if (address.toLowerCase() === CONTRACTS.factory.toLowerCase()) {
      if (!launched) throw new Error('execution reverted');
      return launched;
    }
    if (address.toLowerCase() === CONTRACTS.locker.toLowerCase()) {
      return '0x0000000000000000000000000000000000000000';
    }
    if (!erc20) throw new Error('not erc20');
    return erc20[item.name];
  },
});

test('endereço malformado é recusado antes de qualquer chamada de rede', async () => {
  const r = await inspectToken({ call: () => { throw new Error('never'); } }, 'nao-e-endereco');
  assert.equal(r.valid, false);
  assert.match(r.verdict, /not a valid address/);
});

test('endereço sem contrato aponta rede errada ou carteira', async () => {
  const r = await inspectToken(fakeRpc({ code: '0x' }), TOKEN);
  assert.equal(r.valid, true);
  assert.equal(r.hasCode, false);
  assert.match(r.verdict, /Nothing is deployed/);
  assert.match(r.verdict, /wallet address/);
});

test('token da pons passa sem veredito e devolve o deployer', async () => {
  const deployer = '0xAbc0000000000000000000000000000000000001';
  const r = await inspectToken(fakeRpc({
    launched: { exists: true, deployer, positionId: 42n, dexId: 0n },
  }), TOKEN);
  assert.equal(r.isPonsToken, true);
  assert.equal(r.deployer, deployer);
  assert.equal(r.positionId, '42');
  assert.equal(r.verdict, null, 'token válido não deve ter veredito de erro');
});

test('ERC-20 de outra plataforma é identificado como tal, com o símbolo', async () => {
  const r = await inspectToken(fakeRpc({ launched: null }), TOKEN);
  assert.equal(r.isPonsToken, false);
  assert.equal(r.erc20.symbol, 'TST');
  assert.match(r.verdict, /not launched by the pons factory/);
  assert.match(r.verdict, new RegExp(CONTRACTS.factory));
});

test('contrato que não é ERC-20 recebe veredito próprio', async () => {
  const r = await inspectToken(fakeRpc({ erc20: null, launched: null }), TOKEN);
  assert.equal(r.erc20, null);
  assert.match(r.verdict, /does not look like a standard ERC-20/);
});

// A regressão mais séria desta tela: a RPC pública devolveu 429, a leitura da
// factory falhou, e o site afirmou "launched through pons: no" sobre um token
// que É da pons. Erro de rede não pode virar veredito sobre o token de alguém.
test('falha de rede vira "não sei", nunca "não é da pons"', async () => {
  const err = Object.assign(new Error('the public RPC is rate limiting this machine (HTTP 429)'),
    { transport: true, httpStatus: 429 });
  const rpc = {
    call: async () => '0x60',
    read: async (address) => {
      if (address.toLowerCase() === CONTRACTS.factory.toLowerCase()) throw err;
      return 'x';
    },
  };
  const r = await inspectToken(rpc, TOKEN);
  assert.equal(r.checked, false);
  assert.equal(r.isPonsToken, null, 'nunca afirmar false quando a checagem não completou');
  assert.match(r.verdict, /Could not verify/);
  assert.match(r.verdict, /says nothing about the token/);
});

test('eth_getCode indisponível também não vira "nada implantado"', async () => {
  const rpc = {
    call: async () => { throw Object.assign(new Error('fetch failed'), { transport: true }); },
    read: async () => { throw new Error('não deveria chegar aqui'); },
  };
  const r = await inspectToken(rpc, TOKEN);
  assert.equal(r.checked, false);
  assert.ok(!/Nothing is deployed/.test(r.verdict));
});

// O contraste: revert limpo da factory É resposta, e deve continuar valendo.
test('revert limpo da factory continua significando "não é da pons"', async () => {
  const rpc = {
    call: async () => '0x60',
    read: async (address, item) => {
      if (address.toLowerCase() === CONTRACTS.factory.toLowerCase()) throw new Error('execution reverted');
      return item.name === 'decimals' ? 18n : 'T';
    },
  };
  const r = await inspectToken(rpc, TOKEN);
  assert.equal(r.checked, true);
  assert.equal(r.isPonsToken, false);
  assert.match(r.verdict, /not launched by the pons factory/);
});

test('o endereço volta em checksum, não como foi digitado', async () => {
  const r = await inspectToken(fakeRpc({ launched: null }), TOKEN.toUpperCase().replace('0X', '0x'));
  assert.equal(r.address, '0x1111111111111111111111111111111111111111');
});
