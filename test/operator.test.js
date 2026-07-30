// Controles do operador: manutenção, status e registro de falhas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { openDb } from '../src/indexer/db.js';
import { migrateAuth } from '../src/web/auth.js';
import {
  migrateOperator, maintenance, setMaintenance, isAdmin, operatorStatus,
  recordExecution, BLOCKED_IN_MAINTENANCE,
} from '../src/web/operator.js';

const TMP = './data/test-operator.sqlite';
for (const s of ['', '-wal', '-shm']) rmSync(TMP + s, { force: true });

const fresh = () => { const db = openDb(TMP); migrateAuth(db); migrateOperator(db); return db; };

test('manutenção começa desligada e liga pelo operador', () => {
  const db = fresh();
  assert.equal(maintenance(db).on, false);
  const on = setMaintenance(db, true, { reason: 'checking the swap route', by: '0xabc' });
  assert.equal(on.on, true);
  assert.equal(on.source, 'operator');
  assert.equal(on.reason, 'checking the swap route');
  assert.equal(setMaintenance(db, false).on, false);
  db.close();
});

test('a variável de ambiente também liga a manutenção', () => {
  const db = fresh();
  process.env.PONS_MAINTENANCE = '1';
  process.env.PONS_MAINTENANCE_REASON = 'deploying';
  const m = maintenance(db);
  assert.equal(m.on, true);
  assert.equal(m.source, 'environment');
  assert.equal(m.reason, 'deploying');
  delete process.env.PONS_MAINTENANCE;
  delete process.env.PONS_MAINTENANCE_REASON;
  db.close();
});

test('só o endereço de operador é admin', () => {
  delete process.env.PONS_ADMIN_ADDRESS;
  assert.equal(isAdmin('0x' + 'ab'.repeat(20)), false, 'sem admin configurado ninguém é admin');
  process.env.PONS_ADMIN_ADDRESS = '0x' + 'ab'.repeat(20);
  assert.equal(isAdmin('0x' + 'AB'.repeat(20)), true, 'comparação não pode ser sensível a maiúsculas');
  assert.equal(isAdmin('0x' + 'cd'.repeat(20)), false);
  assert.equal(isAdmin(null), false);
  delete process.env.PONS_ADMIN_ADDRESS;
});

test('manutenção bloqueia criar e executar, nunca ler ou exportar', () => {
  const bloqueadas = [...BLOCKED_IN_MAINTENANCE];
  assert.ok(bloqueadas.includes('POST /api/agents'));
  assert.ok(bloqueadas.includes('POST /api/decisions/:id/execute'));
  assert.ok(bloqueadas.includes('POST /api/agents/:id/run'));

  // o que precisa continuar funcionando para ninguém ficar preso do lado de fora
  for (const livre of ['GET /api/agents', 'GET /api/agents/:id', 'GET /api/agents/:id/keystore']) {
    assert.ok(!bloqueadas.includes(livre), `${livre} não pode ser bloqueada`);
  }
});

test('status do operador conta o que importa', () => {
  const db = fresh();
  setMaintenance(db, false);
  const s = operatorStatus(db);
  for (const k of ['maintenance', 'liveExecution', 'keystoresSealed', 'network', 'users', 'agents', 'failed']) {
    assert.ok(k in s, `falta ${k} no status`);
  }
  assert.equal(typeof s.agents, 'number');
  db.close();
});

test('falha parcial guarda o erro e os passos já enviados', () => {
  const db = fresh();
  db.prepare(`INSERT INTO agents (id, label, address, keystore_path, created_at, status, policy)
              VALUES ('ag1','a','0x1','p',1,'funded','{}')`).run();
  const info = db.prepare(`INSERT INTO decisions (agent_id, ts, kind, payload, status)
                           VALUES ('ag1', 1, 'buyback_burn', '{}', 'approved')`).run();
  const id = Number(info.lastInsertRowid);

  recordExecution(db, id, {
    status: 'failed',
    error: 'simulation reverted: STF',
    steps: [{ label: 'wrap', hash: '0xaaa' }, { label: 'approve', hash: '0xbbb' }],
  });

  const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);
  assert.equal(row.status, 'failed');
  assert.match(row.error, /STF/);
  const passos = JSON.parse(row.steps_log);
  assert.equal(passos.length, 2, 'as transações já confirmadas precisam ficar registradas');
  assert.equal(passos[1].hash, '0xbbb');

  assert.equal(operatorStatus(db).failed, 1);
  assert.equal(operatorStatus(db).recentFailures[0].id, id);
  db.close();
});
