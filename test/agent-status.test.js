// Status do agente.
//
// O status nascia 'awaiting_funding' e, pelo site, nunca mudava — só o comando
// `wait` do CLI atualizava. Um agente que já tinha sido financiado e já tinha
// executado um buyback real continuava escrito no painel como "esperando
// depósito". Estes testes existem para isso não voltar em silêncio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { openDb } from '../src/indexer/db.js';
import { createAgent, getAgent, syncFundedStatus } from '../src/wallet/agentWallet.js';

const TMP = './data/test-agent-status.sqlite';
for (const s of ['', '-wal', '-shm']) rmSync(TMP + s, { force: true });

const novo = () => {
  const db = openDb(TMP);
  const criado = createAgent(db, { label: 'status', password: 'senha-de-teste-1' });
  return { db, agent: getAgent(db, criado.id) };
};

test('agente nasce esperando depósito', () => {
  const { db, agent } = novo();
  assert.equal(agent.status, 'awaiting_funding');
  db.close();
});

test('saldo abaixo do mínimo não promove', () => {
  const { db, agent } = novo();
  const abaixo = BigInt(agent.policy.minFundingWei) - 1n;
  assert.equal(syncFundedStatus(db, agent, abaixo), 'awaiting_funding');
  assert.equal(getAgent(db, agent.id).status, 'awaiting_funding');
  db.close();
});

test('saldo no mínimo promove para funded, e o banco registra', () => {
  const { db, agent } = novo();
  assert.equal(syncFundedStatus(db, agent, BigInt(agent.policy.minFundingWei)), 'funded');
  assert.equal(getAgent(db, agent.id).status, 'funded', 'a promoção precisa persistir, não só voltar no retorno');
  db.close();
});

// Depois de comprar, o saldo cai. Rebaixar o agente aí trocaria um rótulo
// errado por outro: ele foi financiado, e continua tendo sido.
test('só sobe, nunca desce', () => {
  const { db, agent } = novo();
  syncFundedStatus(db, agent, BigInt(agent.policy.minFundingWei));

  const financiado = getAgent(db, agent.id);
  assert.equal(syncFundedStatus(db, financiado, 0n), 'funded');
  assert.equal(getAgent(db, agent.id).status, 'funded');
  db.close();
});

test('status que não seja awaiting_funding não é tocado', () => {
  const { db, agent } = novo();
  db.prepare('UPDATE agents SET status = ? WHERE id = ?').run('paused', agent.id);
  const pausado = getAgent(db, agent.id);
  assert.equal(syncFundedStatus(db, pausado, 10n ** 18n), 'paused');
  db.close();
});
