// Deteccao de armazenamento efemero.
//
// Estes testes existem por causa de uma falha real e cara: o site publicado
// subiu sem volume montado, aceitou cadastro, gerou uma carteira, mostrou o
// endereco de deposito — e no redeploy seguinte o agente tinha sumido. Nada
// deu erro. Se alguem tivesse depositado, o dinheiro estaria perdido junto com
// a chave privada, sem backup possivel.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dataPersistence, assertCanCreateAgents, persistenceWarning } from '../src/wallet/persistence.js';

const noLinux = process.platform === 'linux';

test('caminho relativo dentro do projeto nao e checado', () => {
  const p = dataPersistence({ PONS_DB: './data/pons.sqlite' });
  assert.equal(p.checked, false);
  assert.equal(p.persistent, null, 'sem checagem o veredito e null, nunca um palpite');
});

test('sem PONS_DB assume o caminho local e nao reclama', () => {
  const p = dataPersistence({});
  assert.equal(p.checked, false);
});

test('fora do Linux a pergunta nao se aplica', { skip: noLinux }, () => {
  const p = dataPersistence({ PONS_DB: '/data/pons.sqlite' });
  assert.equal(p.checked, false);
  assert.match(p.reason, /linux/);
});

// O caso que de fato aconteceu: caminho absoluto de container, no mesmo
// dispositivo que a raiz — ou seja, sem volume nenhum montado ali.
test('caminho de container sem volume e detectado como efemero', { skip: !noLinux }, () => {
  const p = dataPersistence({ PONS_DB: '/tmp/pons-teste/pons.sqlite' });
  assert.equal(p.checked, true);
  assert.equal(p.persistent, false);
  assert.match(p.reason, /not on a mounted volume/);
});

test('o aviso diz o proximo passo, nao so o problema', () => {
  const texto = persistenceWarning({ dir: '/data' });
  assert.match(texto, /DELETED on every redeploy/);
  assert.match(texto, /mount it at exactly this path/, 'precisa dizer como resolver');
  assert.match(texto, /withdrawing stay open/, 'precisa deixar claro o que continua funcionando');
});

test('criar agente e bloqueado quando o armazenamento e efemero', { skip: !noLinux }, () => {
  assert.throws(
    () => assertCanCreateAgents({ PONS_DB: '/tmp/pons-teste/pons.sqlite' }),
    /not on a persistent volume/,
  );
});

test('a trava pode ser desligada de proposito para instancia descartavel', () => {
  assert.doesNotThrow(() => assertCanCreateAgents({
    PONS_DB: '/tmp/pons-teste/pons.sqlite', PONS_ALLOW_EPHEMERAL_DATA: '1',
  }));
});

test('rodando local a criacao nunca e bloqueada', () => {
  assert.doesNotThrow(() => assertCanCreateAgents({ PONS_DB: './data/pons.sqlite' }));
});
