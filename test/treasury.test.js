// Tesouraria: a taxa do site vira recompra e queima, sem clique.
//
// O que estes testes travam: a configuração só liga com agente E senha; o
// boot reescreve a política para o perfil de tesouraria e liga o buyback em
// "gastar tudo"; o laço respeita manutenção, a trava de execução real e o
// mínimo de saldo; só decisões de buyback aprovadas pela política são
// executadas, com a senha do ambiente; falha é registrada na decisão e não
// derruba o laço.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { openDb } from '../src/indexer/db.js';
import { createAgent, getAgent } from '../src/wallet/agentWallet.js';
import { agentFunctions } from '../src/functions/index.js';
import {
  resolveTreasuryConfig, prepareTreasuryAgent, treasuryTick, startTreasury, treasuryStatus, TREASURY_POLICY,
} from '../src/agent/treasury.js';
import { parseUnits } from '../src/market/pricing.js';
import { recordExecution as recordInDb, migrateOperator } from '../src/web/operator.js';

const TMP = './data/test-treasury.sqlite';
for (const s of ['', '-wal', '-shm']) rmSync(TMP + s, { force: true });
const TOKEN = '0xca6e7dba9ccc2342f30439115f0c9ed4f5dd7698';
const PASSWORD = 'senha-da-tesouraria-1';

function seed() {
  const db = openDb(TMP);
  migrateOperator(db);   // colunas error/steps_log da tabela de decisoes, como no servidor
  const agent = createAgent(db, { label: 'treasury', password: PASSWORD });
  db.prepare('UPDATE agents SET target_token = ? WHERE id = ?').run(TOKEN, agent.id);
  return { db, agent };
}

// Grava no banco como o servidor faz, e guarda uma copia para o teste olhar.
const executions = [];
const recordExecution = (db, id, r) => { executions.push({ id, ...r }); recordInDb(db, id, r); };

/** runAgent de mentira: devolve as decisões que o teste quiser. */
const fakeRun = (decisions) => async (db, rpc, agentId) => {
  // grava no banco como o runner real faria, para os ids existirem
  const ids = decisions.map((d) => {
    const r = db.prepare(`INSERT INTO decisions (agent_id, ts, token, kind, rationale, payload, risk, status)
      VALUES (?,?,?,?,?,?,?,?)`).run(agentId, Math.floor(Date.now() / 1000), TOKEN, d.kind, 'x',
      JSON.stringify({ kind: d.kind, token: TOKEN, notionalWei: d.notionalWei ?? '0', steps: [] }), '{}',
      d.violations?.length ? 'rejected' : d.needsApproval ? 'pending_approval' : 'approved');
    return Number(r.lastInsertRowid);
  });
  return {
    results: [{
      functionId: 'buyback_burn', notes: ['nota'],
      decisions: decisions.map((d, i) => ({
        id: ids[i],
        decision: { kind: d.kind, token: TOKEN, notionalWei: d.notionalWei ?? '0', steps: [] },
        verdict: { violations: d.violations ?? [], approved: !(d.violations?.length), needsApproval: !!d.needsApproval },
      })),
    }],
  };
};

const fakeBalances = (eth) => async () => ({ eth, weth: 0n, tokens: {} });

// ---------------------------------------------------------------- configuração

test('sem PONS_TREASURY_AGENT e sem senha, a tesouraria fica desligada em silêncio', () => {
  const c = resolveTreasuryConfig({});
  assert.equal(c.enabled, false);
  assert.equal(c.problem, null);
});

test('metade da configuração é erro dito, não silêncio', () => {
  assert.match(resolveTreasuryConfig({ PONS_TREASURY_AGENT: 'x' }).problem, /PASSWORD is not/);
  assert.match(resolveTreasuryConfig({ PONS_TREASURY_PASSWORD: 'x' }).problem, /AGENT is not/);
  assert.match(resolveTreasuryConfig({ PONS_TREASURY_AGENT: 'x', PONS_TREASURY_PASSWORD: 'y', PONS_TREASURY_MIN_ETH: 'abc' }).problem, /MIN_ETH/);
  assert.match(resolveTreasuryConfig({ PONS_TREASURY_AGENT: 'x', PONS_TREASURY_PASSWORD: 'y', PONS_TREASURY_INTERVAL_MIN: '0' }).problem, /INTERVAL_MIN/);
});

test('configuração completa: intervalo em ms e mínimo em wei', () => {
  const c = resolveTreasuryConfig({ PONS_TREASURY_AGENT: 'a1', PONS_TREASURY_PASSWORD: 'p', PONS_TREASURY_INTERVAL_MIN: '15', PONS_TREASURY_MIN_ETH: '0.01' });
  assert.equal(c.enabled, true);
  assert.equal(c.intervalMs, 15 * 60_000);
  assert.equal(c.minWei, parseUnits('0.01', 18));
});

// ---------------------------------------------------------------- preparo do agente

test('o boot reescreve a política e liga o buyback em "gastar tudo"', () => {
  const { db, agent } = seed();
  const c = resolveTreasuryConfig({ PONS_TREASURY_AGENT: agent.id, PONS_TREASURY_PASSWORD: PASSWORD, PONS_TREASURY_INTERVAL_MIN: '20' });
  const ready = prepareTreasuryAgent(db, c);
  assert.equal(ready.policy.mode, 'auto');
  assert.equal(ready.policy.maxNotionalPerTradeWei, TREASURY_POLICY.maxNotionalPerTradeWei);
  const fn = agentFunctions(db, agent.id).find((f) => f.function_id === 'buyback_burn');
  assert.ok(fn?.enabled);
  assert.equal(fn.params.useFullBalance, true);
  assert.equal(fn.params.minIntervalMinutes, 20);
});

test('agente inexistente ou sem token alvo é erro claro', () => {
  const { db, agent } = seed();
  assert.throws(() => prepareTreasuryAgent(db, { agentId: 'nao-existe', intervalMs: 60_000 }), /not found/);
  db.prepare('UPDATE agents SET target_token = NULL WHERE id = ?').run(agent.id);
  assert.throws(() => prepareTreasuryAgent(db, { agentId: agent.id, intervalMs: 60_000 }), /no target token/);
});

// ---------------------------------------------------------------- o laço

const configFor = (agent, over = {}) => ({
  enabled: true, agentId: agent.id, password: PASSWORD, intervalMs: 60_000, minWei: parseUnits('0.005', 18), ...over,
});

test('manutenção e trava de execução real param o laço antes de tocar na chain', async () => {
  const { db, agent } = seed();
  const rpc = {};
  const m = await treasuryTick({ db, rpc, config: configFor(agent), live: true, maintenanceOn: true, recordExecution });
  assert.match(m.skipped, /maintenance/);
  const l = await treasuryTick({ db, rpc, config: configFor(agent), live: false, recordExecution });
  assert.match(l.skipped, /LIVE_EXECUTION/);
});

test('abaixo do mínimo (descontada a reserva de gás) não propõe nada', async () => {
  const { db, agent } = seed();
  let ran = false;
  const out = await treasuryTick({
    db, rpc: {}, config: configFor(agent), live: true, recordExecution,
    deps: { agentBalances: fakeBalances(parseUnits('0.006', 18)), runAgent: async () => { ran = true; return { results: [] }; } },
  });
  // 0.006 − reserva padrão 0.002 = 0.004 < 0.005
  assert.match(out.skipped, /below the minimum/);
  assert.equal(ran, false);
});

test('com saldo, executa só os buybacks aprovados, com a senha do ambiente', async () => {
  const { db, agent } = seed();
  executions.length = 0;
  const calls = [];
  const out = await treasuryTick({
    db, rpc: {}, config: configFor(agent), live: true, recordExecution,
    deps: {
      agentBalances: fakeBalances(parseUnits('0.05', 18)),
      runAgent: fakeRun([
        { kind: 'buyback_burn', notionalWei: parseUnits('0.04', 18).toString() },
        { kind: 'dca', notionalWei: '1' },                                   // outra função: ignorada
        { kind: 'buyback_burn', notionalWei: '1', violations: ['bloqueado'] }, // reprovado: ignorado
      ]),
      executeDecision: async (args) => {
        calls.push(args);
        assert.ok(args.privateKey, 'a chave precisa estar desbloqueada na execução');
        assert.equal(args.dryRun, false);
        return { steps: [{ label: 'buy', hash: '0x' + 'ab'.repeat(32) }] };
      },
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(out.executed.length, 1);
  assert.equal(out.executed[0].hash, '0x' + 'ab'.repeat(32));
  assert.equal(executions[0].status, 'executed');
  const row = db.prepare('SELECT tx_hash FROM decisions WHERE id = ?').get(out.executed[0].id);
  assert.equal(row.tx_hash, '0x' + 'ab'.repeat(32));
});

test('decisão pendente de aprovação é aprovada pela tesouraria antes de executar', async () => {
  const { db, agent } = seed();
  const out = await treasuryTick({
    db, rpc: {}, config: configFor(agent), live: true, recordExecution,
    deps: {
      agentBalances: fakeBalances(parseUnits('0.05', 18)),
      runAgent: fakeRun([{ kind: 'buyback_burn', notionalWei: '10', needsApproval: true }]),
      executeDecision: async () => ({ steps: [{ label: 'buy', hash: '0x01' }] }),
    },
  });
  assert.equal(out.executed.length, 1);
  const row = db.prepare('SELECT status FROM decisions WHERE id = ?').get(out.executed[0].id);
  assert.equal(row.status, 'executed');
});

test('senha errada não executa nada e diz por quê', async () => {
  const { db, agent } = seed();
  const out = await treasuryTick({
    db, rpc: {}, config: configFor(agent, { password: 'errada' }), live: true, recordExecution,
    deps: {
      agentBalances: fakeBalances(parseUnits('0.05', 18)),
      runAgent: fakeRun([{ kind: 'buyback_burn', notionalWei: '10' }]),
      executeDecision: async () => { throw new Error('não deveria chegar aqui'); },
    },
  });
  assert.match(out.error, /could not unlock/);
});

test('falha na execução é registrada na decisão e devolvida, sem lançar', async () => {
  const { db, agent } = seed();
  executions.length = 0;
  const out = await treasuryTick({
    db, rpc: {}, config: configFor(agent), live: true, recordExecution,
    deps: {
      agentBalances: fakeBalances(parseUnits('0.05', 18)),
      runAgent: fakeRun([{ kind: 'buyback_burn', notionalWei: '10' }]),
      executeDecision: async () => { throw new Error('simulation reverted: SlippageExceeded'); },
    },
  });
  assert.match(out.error, /SlippageExceeded/);
  assert.equal(executions[0].status, 'failed');
});

test('nada aprovado nesta volta devolve as notas e os bloqueios, para o operador ler', async () => {
  const { db, agent } = seed();
  const out = await treasuryTick({
    db, rpc: {}, config: configFor(agent), live: true, recordExecution,
    deps: {
      agentBalances: fakeBalances(parseUnits('0.05', 18)),
      runAgent: fakeRun([{ kind: 'buyback_burn', notionalWei: '10', violations: ['pool liquidity below the minimum'] }]),
    },
  });
  assert.match(out.skipped, /no buyback passed/);
  assert.deepEqual(out.blocked, ['pool liquidity below the minimum']);
});

// ---------------------------------------------------------------- start

test('startTreasury sem configuração devolve null e não agenda nada', () => {
  const { db } = seed();
  const h = startTreasury({ db, rpc: {}, live: true, isMaintenanceOn: () => false, recordExecution, log: () => {}, env: {} });
  assert.equal(h, null);
  assert.equal(treasuryStatus().enabled, false);
});

test('startTreasury com agente configurado prepara o agente e avisa se a taxa não aponta para ele', () => {
  const { db, agent } = seed();
  const logs = [];
  const h = startTreasury({
    db, rpc: {}, live: true, isMaintenanceOn: () => false, recordExecution, log: (m) => logs.push(m),
    env: { PONS_TREASURY_AGENT: agent.id, PONS_TREASURY_PASSWORD: PASSWORD, PONS_TREASURY_INTERVAL_MIN: '5' },
    firstDelayMs: 60_000,
  });
  assert.ok(h, 'deveria ligar');
  h.stop();
  const st = treasuryStatus();
  assert.equal(st.enabled, true);
  assert.equal(st.address, agent.address);
  assert.equal(st.token, TOKEN);
  assert.equal(st.feeAddressMatches, false);    // nos testes PONS_FEE_ADDRESS não é a tesouraria
  assert.ok(logs.some((m) => /TREASURY WARNING/.test(m)));
  assert.equal(getAgent(db, agent.id).policy.mode, 'auto');
});
