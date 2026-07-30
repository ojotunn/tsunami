// Gera um demo INTERATIVO do site: um backend falso roda inteiro no navegador,
// mas reaproveitando o código real de preço, impacto e política de risco — os
// arquivos são lidos do projeto e embutidos aqui, então os números respondem de
// verdade aos parâmetros que o usuário digitar.
import { readFileSync, writeFileSync } from 'node:fs';
import { catalog } from '../src/functions/index.js';
import { CHAIN, CONTRACTS, BURN_ADDRESS } from '../src/chain/config.js';

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src') + '/';
const PAGES = SRC + 'web/pages/';
const landing = readFileSync(PAGES + 'landing.html', 'utf8');
let app = readFileSync(PAGES + 'app.html', 'utf8');

// ---------------------------------------------------------------- código real reaproveitado

const stripExports = (s) => s.replace(/^export\s+/gm, '').replace(/^import .*$/gm, '');

// pricing.js inteiro (não tem imports)
const pricingSrc = stripExports(readFileSync(SRC + 'market/pricing.js', 'utf8'));

// policy.js até antes de recordDecision (que precisa de banco)
const policyFull = readFileSync(SRC + 'agent/policy.js', 'utf8');
const policySrc = stripExports(policyFull.slice(0, policyFull.indexOf('/** Registra a decisão')));

// ---------------------------------------------------------------- estado do token de demo

// Escolhe sqrtPriceX96 e liquidez para o token de exemplo valer ~3,4e-9 ETH
// e uma compra de 0,005 ETH bater ~60 bps de impacto.
const Q96 = 2n ** 96n;
const targetPrice = 3.4e-9;
const sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(targetPrice) * 2 ** 96));
const amountRef = 5n * 10n ** 15n;
const liquidity = (amountRef * Q96 * 10000n) / (30n * sqrtPriceX96 / 1n) * 1n;

const TOKEN = {
  address: '0x9f2b4c7e1a83d5064b7e2c9a15fd3e8b7c04a621',
  symbol: 'MYTOKEN',
  name: 'My Token',
  decimals: 18,
  isToken0: true,
  poolFee: 10000,
  sqrtPriceX96: sqrtPriceX96.toString(),
  liquidity: liquidity.toString(),
  totalSupply: (10n ** 27n).toString(),
  burned: (184n * 10n ** 23n).toString(),
  graduated: false,
  pairedPrincipal: '3114000000000000000',
  graduationThreshold: '4200000000000000000',
  pendingRewards: '13800000000000000',
  maxTxTokens: (10n ** 25n).toString(),
  maxWalletTokens: (2n * 10n ** 25n).toString(),
};

const SPECS = catalog();
const CLOSE = '<' + '/script>';
const J = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
const safe = (html) => JSON.stringify(html).replace(/<\//g, '<\\/');

// ---------------------------------------------------------------- backend de demonstração

const backend = `
(function () {
  'use strict';

  // ===== código real do projeto, embutido =====
  ${pricingSrc}
  ${policySrc}

  const SPECS = ${J(SPECS)};
  const TOKEN = ${J(TOKEN)};
  const CONTRACTS = ${J(CONTRACTS)};
  const BURN = ${J(BURN_ADDRESS)};
  const CHAIN_ID = ${CHAIN.id};

  const S = { agents: [], fns: {}, decisions: [], nextId: 1, me: null };

  const rnd = (n) => Array.from({ length: n }, () =>
    '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const mkAddress = () => {
    const h = rnd(40);
    return '0x' + h.split('').map((c, i) => (parseInt(rnd(1), 16) > 7 ? c.toUpperCase() : c)).join('');
  };
  const now = () => Math.floor(Date.now() / 1000);

  // ===== normalização de parâmetros (espelha functions/index.js) =====
  function normalize(fnId, input) {
    const spec = SPECS.find((s) => s.id === fnId);
    const out = {};
    for (const [k, def] of Object.entries(spec.params)) {
      const raw = (input && input[k] !== undefined && input[k] !== '') ? input[k] : def.default;
      if (def.type === 'int') {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) throw new Error(spec.label + ' → ' + def.label + ': must be an integer >= 0');
        out[k] = n;
      } else if (def.type === 'decimal') {
        if (!/^\\d+(\\.\\d+)?$/.test(String(raw))) throw new Error(spec.label + ' → ' + def.label + ': must be a positive decimal');
        out[k] = String(raw);
      } else if (def.type === 'bool') {
        out[k] = raw === true || raw === 'true';
      } else if (def.type === 'enum') {
        out[k] = def.options.includes(raw) ? raw : def.default;
      } else {
        out[k] = raw ?? '';
      }
    }
    return out;
  }

  // ===== helpers de mercado usando a matemática real =====
  const price = () => tokenPriceInPair({
    sqrtPriceX96: BigInt(TOKEN.sqrtPriceX96), isToken0: TOKEN.isToken0,
    tokenDecimals: TOKEN.decimals, pairDecimals: 18,
  });

  const quote = (amountIn, side) => simulateSwap({
    sqrtPriceX96: BigInt(TOKEN.sqrtPriceX96), liquidity: BigInt(TOKEN.liquidity),
    amountIn, side, isToken0: TOKEN.isToken0, feePips: TOKEN.poolFee,
  });

  const circulating = () => ({
    total: BigInt(TOKEN.totalSupply),
    burned: BigInt(TOKEN.burned),
    circulating: BigInt(TOKEN.totalSupply) - BigInt(TOKEN.burned),
  });

  // ===== as cinco funções =====
  const withSlippage = (a, bps) => (BigInt(a) * BigInt(10000 - bps)) / 10000n;

  function planBuyback(agent, p) {
    const amountIn = parseUnits(p.amountEth, 18);
    const notes = [];
    if (agent.eth < amountIn) {
      return { notes: ['insufficient balance: has ' + formatUnits(agent.eth, 18) + ' ETH, needs ' + p.amountEth], decisions: [] };
    }
    const sim = quote(amountIn, 'buy');
    const s = circulating();
    notes.push('circulating supply today: ' + formatUnits(s.circulating, 18, 0) + ' of ' + formatUnits(s.total, 18, 0) +
      ' (burned: ' + formatUnits(s.burned, 18, 0) + ')');
    notes.push('totalSupply() does not change when you burn — the pons token has no burn()');
    return {
      notes,
      decisions: [{
        kind: 'buyback_burn', token: TOKEN.address, side: 'buy',
        notionalWei: amountIn.toString(), priceImpactBps: sim.priceImpactBps,
        expectedTokensOut: sim.amountOut.toString(),
        rationale: 'buyback of ' + p.amountEth + ' ETH followed by a burn',
        steps: [
          { action: 'swap', side: 'buy', amountInWei: amountIn.toString(), minOutWei: withSlippage(sim.amountOut, 100).toString() },
          { action: 'transfer', to: p.burnAddress || BURN, amountRef: 'swap.out' },
        ],
      }],
    };
  }

  function planRewards(agent, p) {
    const notes = [];
    const decisions = [];
    const pending = BigInt(TOKEN.pendingRewards);

    if (!agent.delegated) {
      notes.push('rewards for this token do not point at the agent yet — sign setFeeRedirect once to enable it');
      notes.push('current payout: ' + (S.me || '0x…'));
    }
    notes.push('pending rewards: ' + formatUnits(pending, 18) + ' ETH');
    notes.push('graduation: ' + formatUnits(BigInt(TOKEN.pairedPrincipal), 18) + ' / ' +
      formatUnits(BigInt(TOKEN.graduationThreshold), 18) + ' ETH' + (TOKEN.graduated ? ' — graduated ✓' : ''));

    if (agent.delegated && pending >= parseUnits(p.minCollectWei, 18)) {
      decisions.push({
        kind: 'collect_rewards', token: TOKEN.address, notionalWei: '0', priceImpactBps: 0,
        rationale: 'collect ' + formatUnits(pending, 18) + ' ETH of creator rewards',
        steps: [{ action: 'call', to: CONTRACTS.locker, method: 'collectFees', args: [TOKEN.address] }],
      });
    }

    if (p.mode === 'reserve_until_graduation' && !TOKEN.graduated) {
      notes.push('reserve mode: accumulating until graduation, no buying yet');
    } else if (p.mode !== 'collect_only') {
      const deployable = (agent.eth * BigInt(p.deployPercent)) / 100n;
      if (deployable > 0n) {
        const sim = quote(deployable, 'buy');
        decisions.push({
          kind: 'rewards_buyback_burn', token: TOKEN.address, side: 'buy',
          notionalWei: deployable.toString(), priceImpactBps: sim.priceImpactBps,
          expectedTokensOut: sim.amountOut.toString(),
          rationale: 'put ' + p.deployPercent + '% of rewards (' + formatUnits(deployable, 18) + ' ETH) into buy and burn',
          steps: [
            { action: 'swap', side: 'buy', amountInWei: deployable.toString() },
            { action: 'transfer', to: BURN, amountRef: 'swap.out' },
          ],
        });
      }
    }
    return { notes, decisions };
  }

  function planDca(agent, p) {
    const amountIn = parseUnits(p.amountEth, 18);
    const budget = parseUnits(p.totalBudgetEth, 18);
    const spent = S.decisions.filter((d) => d.agentId === agent.id && d.kind === 'dca' && d.status === 'executed')
      .reduce((s, d) => s + BigInt(d.notionalWei), 0n);
    if (spent + amountIn > budget) {
      return { notes: ['program budget exhausted: ' + formatUnits(spent, 18) + ' of ' + p.totalBudgetEth + ' ETH'], decisions: [] };
    }
    if (agent.eth < amountIn) {
      return { notes: ['insufficient balance: ' + formatUnits(agent.eth, 18) + ' ETH'], decisions: [] };
    }
    const sim = quote(amountIn, 'buy');

    const perDay = (24 * 60) / p.intervalMinutes;
    const feeYear = (amountIn * BigInt(Math.round(perDay * 365))) / 100n;
    const notes = [
      'estimated pool fees alone at this cadence: ~' + formatUnits(feeYear, 18, 4) + ' ETH per year',
      'budget remaining: ' + formatUnits(budget - spent - amountIn, 18) + ' ETH',
    ];
    const steps = [{ action: 'swap', side: 'buy', amountInWei: amountIn.toString() }];
    if (p.destination === 'burn') steps.push({ action: 'transfer', to: BURN, amountRef: 'swap.out' });
    return {
      notes,
      decisions: [{
        kind: 'dca', token: TOKEN.address, side: 'buy', notionalWei: amountIn.toString(),
        priceImpactBps: sim.priceImpactBps, expectedTokensOut: sim.amountOut.toString(),
        rationale: 'scheduled buy of ' + p.amountEth + ' ETH (every ' + p.intervalMinutes + ' min)',
        steps,
      }],
    };
  }

  function parseLadder(text) {
    return String(text).split(',').map((part) => {
      const bits = part.trim().split(':');
      const dropBps = Math.round(Number(bits[0]) * 100);
      if (!Number.isFinite(dropBps) || !bits[1]) throw new Error('invalid ladder step: "' + part.trim() + '"');
      return { dropBps: dropBps, amountEth: bits[1].trim() };
    }).sort((a, b) => a.dropBps - b.dropBps);
  }

  function planDip(agent, p) {
    let ladder;
    try { ladder = p.ladder ? parseLadder(p.ladder) : [{ dropBps: Math.round(Number(p.dropPercent) * 100), amountEth: String(p.amountEth) }]; }
    catch (e) { return { notes: [e.message], decisions: [] }; }

    // no demo a máxima da janela é 20% acima do preço atual
    const cur = price();
    const high = (cur * 12000n) / 10000n;
    const dropBps = Number(((high - cur) * 10000n) / high);
    const notes = ['now ' + formatUnits(cur, 18, 12) + ' ETH · highest in ' + p.windowHours + 'h: ' +
      formatUnits(high, 18, 12) + ' ETH · that is ' + (dropBps / 100).toFixed(2) + '% below the high'];

    const step = ladder.slice().reverse().find((s) => dropBps >= s.dropBps);
    if (!step) {
      notes.push('the drop has not reached ' + (ladder[0].dropBps / 100) + '% yet — no buy');
      return { notes, decisions: [] };
    }
    const amountIn = parseUnits(step.amountEth, 18);
    if (agent.eth < amountIn) {
      notes.push('the ' + (step.dropBps / 100) + '% drop was reached, but the agent only has ' + formatUnits(agent.eth, 18) + ' ETH');
      return { notes, decisions: [] };
    }
    const sim = quote(amountIn, 'buy');
    const steps = [{ action: 'swap', side: 'buy', amountInWei: amountIn.toString() }];
    if (p.destination === 'burn') steps.push({ action: 'transfer', to: BURN, amountRef: 'swap.out' });
    return {
      notes,
      decisions: [{
        kind: 'dip_buy', token: TOKEN.address, side: 'buy', notionalWei: amountIn.toString(),
        priceImpactBps: sim.priceImpactBps, expectedTokensOut: sim.amountOut.toString(),
        rationale: 'the price is ' + (dropBps / 100).toFixed(2) + '% below the ' + p.windowHours + 'h high, past the ' +
          (step.dropBps / 100) + '% you set — buying ' + step.amountEth + ' ETH',
        steps,
      }],
    };
  }

  function parseRecipients(csv, decimals) {
    const out = []; const errors = []; const seen = {};
    String(csv).split(/\\r?\\n/).forEach((line, i) => {
      const raw = line.trim();
      if (!raw || raw[0] === '#') return;
      const parts = raw.split(/[,;\\t]/).map((s) => (s || '').trim());
      const addr = parts[0]; const amount = parts[1]; const n = i + 1;
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr || '')) { errors.push('line ' + n + ': invalid address "' + addr + '"'); return; }
      if (seen[addr.toLowerCase()]) { errors.push('line ' + n + ': duplicate address ' + addr); return; }
      let value;
      try { value = parseUnits(amount, decimals); } catch (e) { errors.push('line ' + n + ': invalid amount "' + amount + '"'); return; }
      if (value <= 0n) { errors.push('line ' + n + ': amount must be greater than zero'); return; }
      seen[addr.toLowerCase()] = 1;
      out.push({ address: addr, amount: value });
    });
    return { recipients: out, errors, total: out.reduce((s, r) => s + r.amount, 0n) };
  }

  function planAirdrop(agent, p) {
    const parsed = parseRecipients(p.recipientsCsv, TOKEN.decimals);
    const notes = parsed.errors.slice();
    if (!parsed.recipients.length) {
      notes.push('no valid recipients — provide the address list');
      return { notes, decisions: [] };
    }
    const known = S.agents.map((a) => a.address.toLowerCase()).concat([String(S.me || '').toLowerCase()]);
    const self = parsed.recipients.filter((r) => known.indexOf(r.address.toLowerCase()) >= 0);
    if (self.length) {
      self.forEach((h) => notes.push('recipient ' + h.address + ' is a wallet owned by this tool'));
      notes.push('airdrop cancelled: the list points at wallets owned by this tool');
      return { notes, decisions: [] };
    }
    if (agent.token < parsed.total) {
      notes.push('agent balance (' + formatUnits(agent.token, 18, 4) + ') is below the airdrop total (' +
        formatUnits(parsed.total, 18, 4) + ')');
    }
    const over = parsed.recipients.filter((r) => r.amount > BigInt(TOKEN.maxWalletTokens));
    if (over.length) {
      notes.push(over.length + ' recipients exceed maxWallet (' + formatUnits(BigInt(TOKEN.maxWalletTokens), 18, 4) + ') — those transfers would revert');
    }
    const batches = [];
    for (let i = 0; i < parsed.recipients.length; i += p.batchSize) batches.push(parsed.recipients.slice(i, i + p.batchSize));
    notes.push(parsed.recipients.length + ' recipients, ' + formatUnits(parsed.total, 18, 4) + ' tokens, ' + batches.length + ' batch(es)');
    if (p.dryRun) { notes.push('simulate only: no transfer will be sent'); return { notes, decisions: [] }; }
    return {
      notes,
      decisions: batches.map((b, i) => ({
        kind: 'airdrop', token: TOKEN.address, notionalWei: '0', priceImpactBps: 0,
        rationale: 'airdrop batch ' + (i + 1) + '/' + batches.length + ' — ' + b.length + ' recipients',
        steps: b.map((r) => ({ action: 'transfer', to: r.address, amountWei: r.amount.toString() })),
      })),
    };
  }

  const PLANNERS = {
    buyback_burn: planBuyback, rewards_boost: planRewards,
    dca: planDca, dip_buy: planDip, airdrop: planAirdrop,
    holder_airdrop: () => ({ notes: ['reading the holder list needs the live explorer — try it on the local site'], decisions: [] }),
  };

  // ===== motor: guards + política, igual ao runner real =====
  function runAgent(agent) {
    const enabled = (S.fns[agent.id] || []).filter((f) => f.enabled);
    const results = [];
    const spentToday = S.decisions.filter((d) => d.agentId === agent.id && d.status === 'executed')
      .reduce((s, d) => s + BigInt(d.notionalWei || 0), 0n);

    for (const f of enabled) {
      const spec = SPECS.find((s) => s.id === f.function_id);
      let planned;
      try { planned = PLANNERS[f.function_id](agent, f.params); }
      catch (e) { results.push({ functionId: f.function_id, error: e.message }); continue; }

      const evaluated = planned.decisions.map((decision) => {
        const violations = [];
        // guards do protocolo
        if (decision.expectedTokensOut && BigInt(decision.expectedTokensOut) > BigInt(TOKEN.maxTxTokens)) {
          violations.push('order of ' + decision.expectedTokensOut + ' exceeds maxTx of ' + TOKEN.maxTxTokens);
        }
        // política de risco (código real)
        const verdict = evaluate(decision, {
          policy: agent.policy,
          ethBalanceWei: agent.eth,
          spentTodayWei: spentToday,
          poolLiquidityWei: BigInt(TOKEN.liquidity),
          tradesLastHour: 0,
          secondsSinceLastTrade: 999999,
        });
        verdict.violations = violations.concat(verdict.violations);
        verdict.approved = verdict.violations.length === 0;

        const id = S.nextId++;
        S.decisions.push({
          id, agentId: agent.id, kind: decision.kind, notionalWei: decision.notionalWei,
          ts: now(), status: verdict.violations.length ? 'rejected' : (verdict.needsApproval ? 'pending_approval' : 'approved'),
        });
        return { id, decision, verdict };
      });

      results.push({
        functionId: f.function_id, label: spec.label,
        notes: planned.notes || [], decisions: evaluated,
      });
    }

    const s = circulating();
    return {
      agent: { id: agent.id, address: agent.address, status: agent.status },
      token: TOKEN.address,
      state: {
        symbol: TOKEN.symbol,
        pricePair: price().toString(),
        mcapPair: marketCapInPair(price(), BigInt(TOKEN.totalSupply), 18).toString(),
        liquidity: TOKEN.liquidity,
        graduated: TOKEN.graduated,
        balances: { eth: agent.eth.toString(), weth: '0', token: agent.token.toString() },
        supply: { total: s.total.toString(), burned: s.burned.toString(), circulating: s.circulating.toString() },
        restrictionsActive: false,
      },
      results,
    };
  }

  // ===== roteador falso =====
  const ROUTES = [
    ['GET', /^\\/api\\/config$/, () => ({
      chain: { id: CHAIN_ID, name: 'Robinhood Chain', explorer: 'https://robinhoodchain.blockscout.com' },
      contracts: CONTRACTS, burnAddress: BURN, functions: SPECS, domain: 'pons-mm (demo)', liveExecution: false,
    })],
    ['GET', /^\\/api\\/health$/, () => ({ rpc: 'ok', chainId: CHAIN_ID, head: '9142887', expected: CHAIN_ID })],
    ['GET', /^\\/api\\/auth\\/me$/, () => ({ address: S.me })],

    ['POST', /^\\/api\\/auth\\/nonce$/, (m, body) => {
      const nonce = rnd(32);
      S.nonce = nonce;
      return {
        nonce,
        message: 'pons-mm (demo) wants to verify that you control this wallet.\\n\\n' +
          'Signing this message authorizes no transaction, moves no funds,\\n' +
          'and gives no access to your wallet.\\n\\n' +
          'Address: ' + body.address + '\\nNetwork: ' + CHAIN_ID + '\\nNonce: ' + nonce,
      };
    }],

    ['POST', /^\\/api\\/auth\\/verify$/, (m, body) => {
      if (!body.signature || body.nonce !== S.nonce) throw new Error('invalid signature');
      S.nonce = null;
      S.me = body.address;
      return { address: body.address, expiresAt: Date.now() + 7 * 864e5 };
    }],
    ['POST', /^\\/api\\/auth\\/logout$/, () => { S.me = null; return { ok: true }; }],

    ['GET', /^\\/api\\/agents$/, () => S.agents.map((a) => ({
      id: a.id, label: a.label, address: a.address, status: a.status, created_at: a.createdAt,
    }))],

    ['POST', /^\\/api\\/agents$/, (m, body) => {
      if (!body.password || body.password.length < 8) throw new Error('keystore password must be at least 8 characters');
      const agent = {
        id: 'ag-' + rnd(8), label: body.label || 'agent', address: mkAddress(),
        status: 'awaiting_funding', createdAt: now(), target_token: TOKEN.address,
        custody: body.custody || 'hybrid', delegated: false,
        eth: 0n, token: 0n, policy: validatePolicy(DEFAULT_POLICY),
      };
      S.agents.push(agent);
      S.fns[agent.id] = [];
      return {
        id: agent.id, label: agent.label, address: agent.address, chainId: CHAIN_ID,
        status: agent.status, owner: S.me,
        depositInstructions: 'Send Robinhood Chain ETH (chain ' + CHAIN_ID + ') to ' + agent.address + '.',
      };
    }],

    ['GET', /^\\/api\\/agents\\/([^/]+)$/, (m) => {
      const a = S.agents.find((x) => x.id === m[1]);
      if (!a) throw new Error('agent not found');
      return {
        id: a.id, label: a.label, address: a.address, status: a.status,
        target_token: a.target_token, custody: a.custody,
        balances: { eth: a.eth.toString(), ethFormatted: formatUnits(a.eth, 18), weth: '0' },
        functions: S.fns[a.id] || [],
        decisions: S.decisions.filter((d) => d.agentId === a.id).slice(-30).reverse(),
      };
    }],

    ['POST', /^\\/api\\/agents\\/([^/]+)\\/functions$/, (m, body) => {
      const list = S.fns[m[1]] || (S.fns[m[1]] = []);
      const i = list.findIndex((f) => f.function_id === body.functionId);
      if (body.enabled === false) { if (i >= 0) list[i].enabled = false; return { ok: true }; }
      const params = normalize(body.functionId, body.params);
      if (i >= 0) { list[i] = { function_id: body.functionId, enabled: true, params }; }
      else list.push({ function_id: body.functionId, enabled: true, params });
      return { ok: true, params };
    }],

    ['POST', /^\\/api\\/agents\\/([^/]+)\\/run$/, (m) => {
      const a = S.agents.find((x) => x.id === m[1]);
      if (!a) throw new Error('agent not found');
      return runAgent(a);
    }],

    ['POST', /^\\/api\\/agents\\/([^/]+)\\/withdraw$/, (m, body) => {
      const a = S.agents.find((x) => x.id === m[1]);
      if (!body.password) throw new Error('the keystore password is required to sign the withdrawal');
      const isEth = body.asset !== 'token';
      const amount = isEth ? (a.eth > 300000000000000n ? a.eth - 300000000000000n : 0n) : a.token;
      if (amount <= 0n) throw new Error('nothing to withdraw');
      if (body.live) { if (isEth) a.eth = 0n; else a.token = 0n; }
      return {
        dryRun: !body.live, asset: isEth ? 'eth' : 'token',
        to: body.to || S.me, amount: amount.toString(),
        gasCost: isEth ? '300000000000000' : undefined,
        hash: body.live ? '0x' + rnd(64) : undefined,
      };
    }],

    ['PATCH', /^\\/api\\/agents\\/([^/]+)$/, (m, body) => {
      const a = S.agents.find((x) => x.id === m[1]);
      if (body.label !== undefined) a.label = String(body.label).trim() || a.label;
      if (body.token !== undefined) a.target_token = body.token ? String(body.token).toLowerCase() : null;
      return { ok: true, agent: a, tokenInfo: body.token
        ? { address: body.token, valid: true, hasCode: true, isPonsToken: true,
            erc20: { name: TOKEN.name, symbol: TOKEN.symbol, decimals: 18 }, verdict: null }
        : null };
    }],

    ['POST', /^\\/api\\/agents\\/([^/]+)\\/delegation$/, (m) => {
      const a = S.agents.find((x) => x.id === m[1]);
      return {
        agentAddress: a.address, token: TOKEN.address,
        tokenInfo: { address: TOKEN.address, valid: true, hasCode: true, isPonsToken: true,
          erc20: { name: TOKEN.name, symbol: TOKEN.symbol, decimals: 18 }, verdict: null },
        status: { feeRecipient: a.delegated ? a.address : S.me, redirectedToAgent: a.delegated, canCollectNow: a.delegated },
        transactions: [
          {
            label: 'point the creator payout at the agent', to: CONTRACTS.locker,
            data: '0x2f1a' + rnd(60), signature: 'setFeeRedirect(address,address)',
            note: 'only the token deployer can call this; from then on rewards land in the agent wallet',
            simulation: { ok: true },
          },
          {
            label: 'authorize the agent to trigger collection', to: CONTRACTS.locker,
            data: '0x8b4c' + rnd(60), signature: 'setFeeCollector(address,bool)',
            note: 'restricted to the locker owner — if it fails, the agent can still collect through the pons interface',
            // A demo mostra o caso real: esta chamada é do dono do locker, não do
            // criador do token. Fingir que passa esconderia justamente a limitação.
            simulation: { ok: false, error: 'OwnableUnauthorizedAccount',
              reason: 'This call is restricted to the locker owner - the pons team, not token creators. You cannot authorize a collector yourself; the agent collects through the redirect instead.' },
          },
        ],
      };
    }],

    ['POST', /^\\/api\\/decisions\\/(\\d+)\\/execute$/, () => {
      throw new Error('execution is disabled in the demo — run the site locally to try it');
    }],

    ['POST', /^\\/api\\/decisions\\/(\\d+)\\/(approve|reject)$/, (m) => {
      const d = S.decisions.find((x) => x.id === Number(m[1]));
      if (d) d.status = m[2] === 'approve' ? 'approved' : 'rejected_by_user';
      return { ok: true };
    }],

    ['POST', /^\\/api\\/airdrop\\/validate$/, (m, body) => {
      const p = parseRecipients(body.csv || '', 18);
      return {
        count: p.recipients.length, total: p.total.toString(),
        totalFormatted: formatUnits(p.total, 18, 4), errors: p.errors,
        sample: p.recipients.slice(0, 5).map((r) => ({ address: r.address, amount: r.amount.toString() })),
      };
    }],
  ];

  window.fetch = async function (url, opts) {
    opts = opts || {};
    const path = String(url).replace(/^https?:\\/\\/[^/]+/, '');
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : {};
    await new Promise((r) => setTimeout(r, 90));
    for (const [m, re, fn] of ROUTES) {
      if (m !== method) continue;
      const match = re.exec(path);
      if (!match) continue;
      try {
        const out = fn(match, body);
        return new Response(JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? v.toString() : v)),
          { status: 200, headers: { 'content-type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response(JSON.stringify({ error: 'route not available in the demo: ' + method + ' ' + path }),
      { status: 404, headers: { 'content-type': 'application/json' } });
  };

  // ===== carteira falsa: o "conectar" e o "assinar" funcionam na demo =====
  S.me = null;
  window.ethereum = {
    isDemo: true,
    request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts') { S.me = mkAddress(); return [S.me]; }
      if (method === 'personal_sign') return '0x' + rnd(130);
      // A demo finge estar sempre na rede certa: a troca de rede é justamente
      // a parte que não dá para simular de forma honesta sem uma carteira real.
      if (method === 'eth_chainId') return '${'0x' + CHAIN.id.toString(16)}';
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
      if (method === 'eth_sendTransaction') {
        const a = S.agents.find((x) => x.id === (window.__lastAgentId || ''));
        S.agents.forEach((x) => { x.delegated = true; });
        return '0x' + rnd(64);
      }
      throw new Error('método não simulado: ' + method);
    },
  };

  // ===== ferramentas de demo: depositar e limpar =====
  window.__demo = {
    fund(agentId, eth) {
      const a = S.agents.find((x) => x.id === agentId);
      if (!a) return;
      a.eth += parseUnits(String(eth), 18);
      a.token += parseUnits('12840000', 18);
      a.status = 'funded';
    },
    state: S,
  };

  window.alert = (m) => {
    const d = document.createElement('div');
    d.textContent = m;
    d.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1a212a;' +
      'border:1px solid #2f3a47;color:#e8eef5;padding:12px 18px;border-radius:10px;font:13px system-ui;' +
      'z-index:9999;max-width:80%;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.5)';
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 3400);
  };
  // location.reload é somente-leitura no navegador — o "Sair" é tratado na barra de demo.
  window.__demoLogout = () => {
    S.me = null;
    S.agents.length = 0;
    S.decisions.length = 0;
    document.getElementById('gate').style.display = 'block';
    document.getElementById('app').style.display = 'none';
    document.getElementById('connectBtn').style.display = 'inline-block';
    document.getElementById('logoutBtn').style.display = 'none';
    document.getElementById('userChip').style.display = 'none';
  };
})();
`;

// barra de demo: depositar saldo no agente sem sair da tela
const demoBar = `
(function () {
  function build() {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;right:18px;bottom:18px;background:#141920;border:1px solid #2a3542;' +
      'border-radius:12px;padding:13px 15px;z-index:900;font:12px system-ui;color:#8b98a8;' +
      'box-shadow:0 10px 34px rgba(0,0,0,.55);max-width:250px';
    bar.innerHTML = '<div style="color:#e3b341;font-weight:600;margin-bottom:7px">demo mode</div>' +
      '<div style="margin-bottom:9px;line-height:1.45">The agent starts with no balance, just like the real thing. ' +
      'Fund it so the capital functions can run.</div>' +
      '<button id="__fund" style="background:#5aa2ff;color:#04101f;border:0;border-radius:7px;padding:7px 12px;' +
      'font:inherit;font-weight:600;cursor:pointer;width:100%">Deposit 0.05 ETH into the agent</button>';
    document.body.appendChild(bar);
    const out = document.getElementById('logoutBtn');
    if (out) out.onclick = () => window.__demoLogout();

    document.getElementById('__fund').onclick = () => {
      const sel = document.getElementById('agentSelect');
      if (!sel || !sel.value) return alert('create and select an agent first');
      window.__demo.fund(sel.value, 0.05);
      sel.dispatchEvent(new Event('change'));
      alert('0.05 ETH credited to the agent wallet (demo)');
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
`;

app = app.replace('</head>', '<script>' + backend + CLOSE + '\n<script>' + demoBar + CLOSE + '\n</head>');

const shell = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>pons-mm · site demo</title>
<style>
 *{box-sizing:border-box;margin:0;padding:0}
 body{background:#07090d;color:#e8eef5;height:100vh;display:flex;flex-direction:column;
      font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
 .bar{display:flex;align-items:center;gap:12px;padding:11px 18px;background:#10151c;
      border-bottom:1px solid #222b36;flex-wrap:wrap}
 .bar b{font-size:14px;letter-spacing:-.01em}
 .bar b i{color:#5aa2ff;font-style:normal}
 .tabs{display:flex;gap:5px;background:#0b0e13;border:1px solid #222b36;border-radius:9px;padding:4px}
 .tab{padding:6px 15px;border-radius:6px;font-size:13px;cursor:pointer;color:#8b98a8;
      border:0;background:transparent;font-family:inherit}
 .tab.on{background:#5aa2ff;color:#04101f;font-weight:600}
 .sp{flex:1}
 .hint{font-size:12px;color:#e3b341;background:#1a1408;border:1px solid #3d2f10;
       padding:5px 13px;border-radius:999px}
 iframe{flex:1;width:100%;border:0;background:#0b0e13}
</style></head>
<body>
 <div class="bar">
   <b>pons<i>-mm</i></b>
   <div class="tabs">
     <button class="tab" data-v="landing">Landing</button>
     <button class="tab on" data-v="app">App — create an agent and use it</button>
   </div>
   <div class="sp"></div>
   <span class="hint">interactive demo · simulated wallet and chain · no real transactions</span>
 </div>
 <iframe id="f"></iframe>
<script>
const PAGES = { landing: ${safe(landing)}, app: ${safe(app)} };
const f = document.getElementById('f');
document.querySelectorAll('.tab').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    f.srcdoc = PAGES[b.dataset.v];
  };
});
f.srcdoc = PAGES.app;
${CLOSE}
</body></html>`;

writeFileSync(join(ROOT, 'src', 'web', 'pages', 'demo.html'), shell);
console.log('demo:', (shell.length / 1024).toFixed(0) + ' kb');
