#!/usr/bin/env node
// CLI do pons-mm. Uso: node src/cli.js <comando> [opções]
import { createInterface } from 'node:readline';
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RpcClient } from './core/rpc.js';
import { CHAIN, CONTRACTS, FACTORY_ABI, POOL_ABI, abiItem } from './chain/config.js';
import { openDb, listTokens, getToken, trackedPools } from './indexer/db.js';
import { backfillLaunches, syncTokenState, indexSwaps, snapshotToken, watch } from './indexer/run.js';
import { createAgent, listAgents, getAgent, agentBalances, waitForFunding, exportKeystore } from './wallet/agentWallet.js';
import { protocolLimits, dexRouting } from './agent/guards.js';
import { executeDecision } from './agent/executor.js';
import { preflight, formatReport } from './agent/preflight.js';
import { unlockAgent } from './wallet/agentWallet.js';
import { generateMasterKey, masterKey } from './wallet/envelope.js';
import { migrateOperator, setMaintenance, maintenance, operatorStatus } from './web/operator.js';
import { migrateAuth } from './web/auth.js';
import { formatUnits, parseUnits, simulateSwap, tokenPriceInPair, marketCapInPair } from './market/pricing.js';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (c) => { if (c.toString() !== '\r' && c.toString() !== '\n') process.stdout.write('*'); };
    process.stdout.write(question);
    rl.output.write = () => {};
    process.stdin.on('data', onData);
    rl.question('', (answer) => {
      process.stdin.off('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}
const password = async () => process.env.PONS_PASSWORD || askHidden('keystore password: ');

const rpc = () => new RpcClient();
const db = () => openDb();

const HELP = `
pons-mm — agent-assisted market making for pons tokens (Robinhood Chain ${CHAIN.id})

  doctor                             check RPC, chain id and the factory
  agent create [--label NAME]        create an agent with its own wallet
  agent list                         list agents
  agent balance <id>                 agent balances
  agent await-funding <id>           wait for the user's deposit
  agent export <id>                  export the V3 keystore (importable in MetaMask)

  index backfill [--blocks N]        index launches from the last N blocks (default 5000)
  index sync-state [--limit N]       fill in name/symbol/supply/ordering
  index swaps [--blocks N]           index swaps for tracked pools
  index watch                        continuous loop
  tokens [--limit N]                 list indexed tokens

  token <address>                    state, price, liquidity and protocol limits
  quote <address> --in 0.01 [--side buy|sell]   simulate an order and its price impact

  preflight <address> [--eth 0.005]  check the whole buy route against the live
                                     contracts without spending anything
  status                             operator view: agents, failures, switches
  pause [reason]                     stop new agents and executions
  resume                             lift the pause
  master-key                         generate a server master key for keystores
  backup <folder>                    copy the keystores somewhere safe
  decisions <agentId>                list recorded decisions
  execute <decisionId> [--live]      run an approved decision
                                     without --live it only simulates and
                                     estimates gas; nothing is sent
`;

async function main() {
  switch (`${cmd} ${args[1] ?? ''}`.trim()) {
    case 'doctor': {
      const r = rpc();
      const id = await r.chainId();
      const head = await r.blockNumber();
      const enabled = await r.read(CONTRACTS.factory, abiItem(FACTORY_ABI, 'launchEnabled'));
      const fee = await r.read(CONTRACTS.factory, abiItem(FACTORY_ABI, 'launchFee'));
      console.log(`chain id .......... ${id} ${id === CHAIN.id ? '✓' : '✗ expected ' + CHAIN.id}`);
      console.log(`current block ..... ${head}`);
      console.log(`factory ........... ${CONTRACTS.factory}`);
      console.log(`launchEnabled ..... ${enabled}`);
      console.log(`launchFee ......... ${formatUnits(fee, 18)} ETH`);
      break;
    }

    case 'agent create': {
      const d = db();
      const pw = await password();
      const a = createAgent(d, { label: flag('label', 'mm-agent'), password: pw });
      console.log(`\nagent created`);
      console.log(`  id .......... ${a.id}`);
      console.log(`  address ..... ${a.address}`);
      console.log(`  keystore .... ${a.keystorePath}`);
      console.log(`\n${a.depositInstructions}\n`);
      console.log(`Save this password: without it the keystore — and the funds — cannot be recovered.`);
      break;
    }

    case 'agent list':
      console.table(listAgents(db()));
      break;

    case 'agent balance': {
      const a = getAgent(db(), args[2]);
      if (!a) throw new Error('agent not found');
      const b = await agentBalances(rpc(), a.address);
      console.log(`${a.address}\n  ETH  ${b.ethFormatted}\n  WETH ${formatUnits(b.weth, 18)}`);
      break;
    }

    case 'agent await-funding': {
      const d = db();
      const res = await waitForFunding(d, rpc(), args[2], {
        onPoll: ({ balance, threshold }) =>
          process.stdout.write(`\rbalance ${formatUnits(balance, 18)} / ${formatUnits(threshold, 18)} ETH   `),
      });
      console.log(`\n${res.funded ? 'agent funded ✓' : 'timed out with no deposit'}`);
      break;
    }

    case 'agent export':
      console.log(JSON.stringify(exportKeystore(db(), args[2]), null, 2));
      break;

    case 'index backfill': {
      const d = db(); const r = rpc();
      const head = await r.blockNumber();
      const span = BigInt(flag('blocks', '5000'));
      const from = flag('from') ? BigInt(flag('from')) : (head > span ? head - span : CONTRACTS.factoryDeployBlock);
      console.log(`indexing launches from ${from} to ${head}…`);
      const total = await backfillLaunches({
        rpc: r, db: d, fromBlock: from, toBlock: head,
        onBatch: ({ to, total }) => process.stdout.write(`\rblock ${to} — ${total} launches   `),
      });
      console.log(`\n${total} launches indexed`);
      break;
    }

    case 'index sync-state': {
      const d = db();
      const rows = listTokens(d, Number(flag('limit', '50')));
      await syncTokenState(d, rpc(), rows.map((r) => r.address));
      console.log(`state synced for ${rows.length} tokens`);
      break;
    }

    case 'index swaps': {
      const d = db(); const r = rpc();
      const head = await r.blockNumber();
      const from = head - BigInt(flag('blocks', '2000'));
      const n = await indexSwaps({ rpc: r, db: d, pools: trackedPools(d), fromBlock: from, toBlock: head });
      console.log(`${n} swaps indexed across ${trackedPools(d).length} pools`);
      break;
    }

    case 'index watch':
      console.log('watching the chain… ctrl-c to stop');
      await watch({
        rpc: rpc(), db: db(),
        onEvent: (e) => console.log(e.error ? `error: ${e.error}` : `block ${e.block} — ${e.launches} launches, ${e.swaps} swaps`),
      });
      break;

    case 'tokens': {
      const rows = listTokens(db(), Number(flag('limit', '20')));
      console.table(rows.map((r) => ({
        symbol: r.symbol, address: r.address, pool: r.pool, block: r.launch_block, token0: !!r.is_token0,
      })));
      break;
    }

    case 'backup': {
      const dest = args[1];
      if (!dest) throw new Error('say where to copy: node src/cli.js backup C:\\backups\\pons');
      const src = process.env.PONS_KEYSTORE_DIR || './data/keystores';
      const stamp = new Date(Date.now()).toISOString().slice(0, 10);
      const target = join(dest, `pons-keystores-${stamp}`);
      mkdirSync(target, { recursive: true });
      cpSync(src, target, { recursive: true });
      const n = readdirSync(target).length;
      console.log(`\n${n} keystore file(s) copied to ${target}`);
      console.log('These files are useless without each user password (and PONS_MASTER_KEY,');
      console.log('if the server seals them). Still, keep the copy somewhere private.\n');
      break;
    }

    case 'status': {
      const d = db(); migrateAuth(d); migrateOperator(d);
      const st = operatorStatus(d);
      console.log('');
      console.log(`  network ............ ${st.network}`);
      console.log(`  maintenance ........ ${st.maintenance.on ? 'ON — ' + (st.maintenance.reason || 'no reason given') : 'off'}`);
      console.log(`  live execution ..... ${st.liveExecution ? 'ON' : 'off'}`);
      console.log(`  keystores sealed ... ${st.keystoresSealed ? 'yes' : 'NO — set PONS_MASTER_KEY'}`);
      // O CLI executa sem passar pelo servidor, então o aviso de configuração
      // da taxa precisa aparecer aqui também.
      console.log(`  service fee ........ ${st.serviceFee.problem
        ? 'MISCONFIGURED — ' + st.serviceFee.problem
        : st.serviceFee.enabled ? `${st.serviceFee.bps / 100}% to ${st.serviceFee.address}` : 'off'}`);
      console.log(`  users .............. ${st.users}`);
      console.log(`  agents ............. ${st.agents}`);
      console.log(`  decisions (24h) .... ${st.decisions24h}`);
      console.log(`  executed / failed .. ${st.executed} / ${st.failed}`);
      if (st.recentFailures.length) {
        console.log('\n  recent failures');
        st.recentFailures.forEach((f) => console.log(`    #${f.id} ${f.kind} — ${String(f.error).slice(0, 90)}`));
      }
      console.log('');
      break;
    }

    case 'resume': {
      const d = db(); migrateAuth(d); migrateOperator(d);
      setMaintenance(d, false);
      console.log('\n  running normally again\n');
      break;
    }

    case 'master-key': {
      console.log('\nPONS_MASTER_KEY=' + generateMasterKey());
      console.log('\nStore this OUTSIDE the server (password manager, fly secrets).');
      console.log('Without it, keystores sealed with it cannot be opened — and every');
      console.log('agent funded under it becomes unrecoverable.\n');
      break;
    }

    case 'decisions': {
      const rows = db().prepare('SELECT id, kind, status, ts, rationale, tx_hash FROM decisions WHERE agent_id = ? ORDER BY ts DESC LIMIT 30').all(args[1]);
      console.table(rows);
      break;
    }

    default: {
      if (cmd === 'pause') {
        const d = db(); migrateAuth(d); migrateOperator(d);
        const motivo = args.slice(1).filter((a) => !a.startsWith('--')).join(' ') || null;
        const m = setMaintenance(d, true, { reason: motivo });
        console.log(`\n  paused${m.reason ? ': ' + m.reason : ''}`);
        console.log('  Reading agents and exporting keystores still work.\n');
        break;
      }

      if (cmd === 'preflight' && args[1]) {
        const report = await preflight(rpc(), args[1], flag('eth', '0.005'));
        console.log(formatReport(report));
        if (report.checks.some((c) => !c.ok)) process.exitCode = 1;
        break;
      }

      if (cmd === 'execute' && args[1]) {
        const d = db();
        const row = d.prepare('SELECT * FROM decisions WHERE id = ?').get(Number(args[1]));
        if (!row) throw new Error('decision not found');
        if (row.status !== 'approved') throw new Error(`decision is "${row.status}" — approve it first`);

        const live = has('live');
        console.log(live ? '\n*** LIVE MODE: transactions WILL be sent ***\n' : '\nDry run: simulating only, nothing will be sent.\n');
        const pw = await password();
        const unlocked = unlockAgent(d, row.agent_id, pw);

        try {
          const out = await executeDecision({
            rpc: rpc(), db: d, decision: JSON.parse(row.payload),
            agent: { address: unlocked.address, id: unlocked.id },
            privateKey: unlocked.privateKey,
            dryRun: !live,
            reserveWei: BigInt(unlocked.policy.reserveGasWei ?? 0),
            onStep: (s) => console.log(`  [${s.phase}] ${s.label}${s.hash ? ' ' + s.hash : ''}`),
          });
          if (live) {
            d.prepare("UPDATE decisions SET status = 'executed', tx_hash = ? WHERE id = ?")
              .run(out.steps.find((x) => x.hash)?.hash ?? null, Number(args[1]));
          }
          console.log(`\n${live ? 'executed' : 'simulated'} ${out.steps.length} step(s)`);
        } finally {
          unlocked.privateKey = null;
        }
        break;
      }

      if (cmd === 'token' && args[1]) {
        const d = db(); const r = rpc();
        const t = getToken(d, args[1]);
        if (!t) throw new Error('token not indexed — run "index backfill" first');
        const snap = await snapshotToken(d, r, t.address);
        const limits = await protocolLimits(r, t.address);
        const dex = await dexRouting(r, BigInt(t.dex_id || '0'));
        console.log(`${t.symbol ?? '?'} — ${t.name ?? ''}`);
        console.log(`  address ......... ${t.address}`);
        console.log(`  pool ............ ${t.pool} (fee ${limits.poolFee / 10000}%)`);
        console.log(`  token0 .......... ${limits.isToken0}`);
        console.log(`  price ........... ${formatUnits(snap.pricePair, 18, 12)} ETH`);
        console.log(`  market cap ...... ${formatUnits(snap.mcapPair, 18, 6)} ETH`);
        console.log(`  liquidity (L) ... ${snap.liquidity}`);
        console.log(`  graduated ....... ${snap.graduated}`);
        console.log(`  restrictions .... ${limits.restrictionsActive
          ? `window active (+${limits.blocksUntilFree} blocks) — buys allowed, capped at ${limits.maxWalletTokens} per wallet`
          : 'lifted — no size cap'}`);
        console.log(`  maxTx / maxWallet ${limits.maxTxTokens} / ${limits.maxWalletTokens}`);
        console.log(`  router .......... ${dex.swapRouter}`);
        break;
      }
      if (cmd === 'quote' && args[1]) {
        const d = db(); const r = rpc();
        const t = getToken(d, args[1]);
        if (!t) throw new Error('token not indexed');
        const snap = await snapshotToken(d, r, t.address);
        const side = flag('side', 'buy');
        const amountIn = parseUnits(flag('in', '0.01'), side === 'buy' ? 18 : (t.decimals ?? 18));
        const sim = simulateSwap({
          sqrtPriceX96: snap.sqrtPriceX96, liquidity: snap.liquidity, amountIn, side,
          isToken0: !!t.is_token0, feePips: t.pool_fee || 10000,
        });
        console.log(`${side} ${flag('in', '0.01')} ${side === 'buy' ? 'ETH' : t.symbol}`);
        console.log(`  estimated out ... ${formatUnits(sim.amountOut, side === 'buy' ? (t.decimals ?? 18) : 18, 8)}`);
        console.log(`  impact .......... ${(sim.priceImpactBps / 100).toFixed(2)}%`);
        if (sim.crossedRangeRisk) console.log('  ⚠ high impact: the single-range simulation loses accuracy here');
        break;
      }
      console.log(HELP);
    }
  }
}

main().catch((err) => { console.error(`error: ${err.message}`); process.exit(1); });
