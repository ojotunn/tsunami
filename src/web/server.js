// Servidor do site. node:http puro, sem dependências.
//
// Custódia híbrida:
//  - a identidade é a carteira do usuário (login por assinatura, sem senha);
//  - as creator rewards chegam por delegação (setFeeRedirect), assinada na
//    carteira dele — o servidor nunca vê a chave privada do usuário;
//  - a carteira do agente, gerada aqui, guarda apenas o capital de operação.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { RpcClient } from '../core/rpc.js';
import { CHAIN, CONTRACTS, BURN_ADDRESS } from '../chain/config.js';
import { openDb, listTokens, getToken } from '../indexer/db.js';
import { createAgent, listAgents, getAgent, agentBalances, exportKeystore, syncFundedStatus } from '../wallet/agentWallet.js';
import { catalog, enableFunction, disableFunction, agentFunctions } from '../functions/index.js';
import { runAgent, recentDecisions, approveDecision, rejectDecision } from '../agent/runner.js';
import { delegationStatus } from '../functions/rewards.js';
import { parseRecipients } from '../functions/airdrop.js';
import { delegationCalls } from '../chain/locker.js';
import { encodeFunctionData } from '../core/abi.js';
import { explainRpcError } from '../chain/errors.js';
import { inspectToken } from '../chain/token.js';
import { formatUnits } from '../market/pricing.js';
import {
  migrateAuth, issueNonce, verifyLogin, sessionFromToken, logout, loginMessage,
  parseCookies, sessionCookie, clearCookie, assertOwnership, acceptTerms, hasAcceptedTerms,
} from './auth.js';
import { rateLimit, startCleanup, clientIp, LIMITS } from './ratelimit.js';
import { executeDecision, withdrawFromAgent } from '../agent/executor.js';
import { FEE } from '../agent/fee.js';
import { isAddress } from '../core/hex.js';
import { dataPersistence, persistenceWarning, assertCanCreateAgents } from '../wallet/persistence.js';
import { unlockAgent } from '../wallet/agentWallet.js';
import { warnIfUnsealed } from '../wallet/envelope.js';
import {
  migrateOperator, maintenance, setMaintenance, isAdmin, operatorStatus,
  recordExecution, BLOCKED_IN_MAINTENANCE,
} from './operator.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const db = openDb();
migrateAuth(db);
migrateOperator(db);
const rpc = new RpcClient();

// Cliente separado para leituras que alimentam a tela: sem retry e com timeout
// curto. Com o cliente normal, uma RPC fora do ar deixaria o painel pendurado
// por quase um minuto tentando de novo antes de mostrar qualquer coisa.
const rpcFast = new RpcClient({ maxRetries: 0, timeoutMs: 3500 });

// Cache curto da inspeção de token. O painel consulta o mesmo endereço várias
// vezes seguidas (abrir agente, preparar delegação, rodar), e a RPC pública
// responde 429 quando isso se acumula — o resultado só muda quando alguém lança
// um token novo, então repetir a pergunta a cada clique não compra nada.
// Resultado indeterminado NÃO entra no cache: seria fixar um "não sei".
const TOKEN_CACHE_MS = 60_000;
const tokenCache = new Map();
async function inspectTokenCached(address) {
  const key = String(address).toLowerCase();
  const hit = tokenCache.get(key);
  if (hit && Date.now() - hit.at < TOKEN_CACHE_MS) return hit.value;
  const value = await inspectToken(rpcFast, address);
  if (value.checked !== false) tokenCache.set(key, { at: Date.now(), value });
  return value;
}
const SECURE = process.env.PONS_SECURE_COOKIES === '1';
const DOMAIN = process.env.PONS_DOMAIN || 'Blizzard Agents';
// Só confie em X-Forwarded-* se houver de fato um proxy TLS na frente.
const TRUST_PROXY = process.env.PONS_TRUST_PROXY === '1';

// Execução real exige opt-in explícito por variável de ambiente. Sem ela, todo
// pedido de execução vira dry run: simula, estima gás e nao envia nada.
// A ideia é que ninguem ligue o envio de transacoes por acidente.
const LIVE_EXECUTION = process.env.PONS_ALLOW_LIVE_EXECUTION === '1';
// Valor sugerido de depósito enquanto a execução é nova. Não é imposto pelo
// contrato — é um aviso honesto na tela para ninguém colocar mais do que aceita
// perder num software que acabou de estrear.
startCleanup();

// CSP restrita: o front é inline por design (arquivo único), então 'unsafe-inline'
// é necessário para style/script, mas nada externo pode ser carregado ou contactado.
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=()',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '),
  ...(SECURE ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
};

// Nome do site. Trocar a marca não deveria exigir editar HTML: quem hospeda
// isto não é necessariamente quem escreveu o código.
//
// Um aviso que vale ficar registrado aqui: um nome parecido demais com o da
// pons faz o usuário achar que está no site oficial deles. Como este site pede
// depósito de fundos, essa confusão custa caro para quem se confunde.
const BRAND = process.env.PONS_BRAND || 'Blizzard Agents';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * Marca do logotipo. Com hífen, a segunda parte fica destacada (`pons-mm`);
 * sem hífen, a palavra inteira ganha a cor de destaque, senão um nome de uma
 * palavra só sairia cinza e sem identidade nenhuma.
 */
const brandHtml = () => {
  const i = BRAND.indexOf('-');
  return i > 0
    ? `${escapeHtml(BRAND.slice(0, i))}<span>${escapeHtml(BRAND.slice(i))}</span>`
    : `<span>${escapeHtml(BRAND)}</span>`;
};

// Aviso de taxa nas páginas estáticas. String vazia quando não há taxa, para o
// texto de quem auto-hospeda não mencionar cobrança que não existe.
const FEE_TEXT = () =>
  `<strong>Service fee.</strong> The operator of this instance charges
   <strong>${FEE.bps / 100}%</strong> of the ETH each buy spends, and the same share of the
   creator rewards it collects for you. It is charged in ETH only — never taken from your
   tokens — and it is shown on screen, per action, before you approve anything.
   <strong>Withdrawing your funds is free</strong>, and airdrops are not charged.
   If you run this software yourself, there is no fee at all.`;

const feeNotice = () => (FEE.enabled ? `<li>${FEE_TEXT()}</li>` : '');
const feeNoticeBlock = () => (FEE.enabled ? `<div class="note" style="margin-bottom:16px">${FEE_TEXT()}</div>` : '');

// Contrato do token da propria instancia, quando o operador quiser anunciar um.
// Fica em variavel de ambiente e nao fixo no codigo: quem auto-hospeda nao deve
// sair divulgando o token de outra pessoa.
const SITE_TOKEN = (process.env.PONS_SITE_TOKEN || '').trim();
const SITE_TOKEN_SYMBOL = (process.env.PONS_SITE_TOKEN_SYMBOL || '').trim();

function tokenBadge() {
  if (!isAddress(SITE_TOKEN)) return '';
  const addr = escapeHtml(SITE_TOKEN);
  const nome = SITE_TOKEN_SYMBOL ? escapeHtml(SITE_TOKEN_SYMBOL) : 'Contract';
  const curto = `${addr.slice(0, 10)}…${addr.slice(-8)}`;
  return `
  <div class="token-badge">
    <span class="tb-name">${nome}</span>
    <code class="tb-addr" id="tbAddr" title="${addr}">${curto}</code>
    <button class="tb-btn" type="button" onclick="copyToken(this)" data-addr="${addr}">copy</button>
    <a class="tb-btn" href="${escapeHtml(CHAIN.explorer)}/address/${addr}" target="_blank" rel="noopener">explorer</a>
  </div>
  <script>
  function copyToken(btn) {
    // clipboard.writeText exige contexto seguro; em http:// local ele nao existe.
    const texto = btn.dataset.addr, antes = btn.textContent;
    const feito = () => { btn.textContent = 'copied'; setTimeout(() => { btn.textContent = antes; }, 1400); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(texto).then(feito, () => { btn.textContent = 'press ctrl+c'; });
    } else {
      const el = document.createElement('textarea');
      el.value = texto; el.style.position = 'fixed'; el.style.opacity = '0';
      document.body.appendChild(el); el.select();
      try { document.execCommand('copy'); feito(); } catch { btn.textContent = 'press ctrl+c'; }
      el.remove();
    }
  }
  </script>`;
}

/**
 * Imagens da marca, servidas de `src/web/assets`.
 *
 * Carregadas na memoria no arranque, e nao lidas do disco a cada pedido: sao
 * poucos arquivos, os maiores tem 140 kB, e assim o disco some do caminho
 * quente. Sem essa rota nao ha como exibir o logo — a CSP do site bloqueia
 * qualquer host externo, entao imagem hospedada fora simplesmente nao carrega.
 */
const ASSETS = new Map();
for (const nome of ['brand-32.png', 'brand-64.png', 'brand-128.png', 'brand-180.png',
  'brand-256.png', 'brand-512.png']) {
  try { ASSETS.set(nome, readFileSync(join(HERE, 'assets', nome))); }
  catch { /* asset ausente nao derruba o site */ }
}

const pageCache = new Map();
const page = (name) => {
  if (!pageCache.has(name)) {
    const html = readFileSync(join(HERE, 'pages', name), 'utf8')
      .replaceAll('{{BRAND_HTML}}', brandHtml())
      .replaceAll('{{BRAND}}', escapeHtml(BRAND))
      .replaceAll('{{FEE_NOTICE}}', feeNotice())
      .replaceAll('{{FEE_NOTICE_BLOCK}}', feeNoticeBlock())
      .replaceAll('{{TOKEN_BADGE}}', tokenBadge());
    pageCache.set(name, Buffer.from(html, 'utf8'));
  }
  return pageCache.get(name);
};

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
};

const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 4e6) reject(new Error('request body too large')); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
});

const authErr = (msg, code = 401) => Object.assign(new Error(msg), { code });

/**
 * Mensagem legível para erros de bind. Sem isto, uma porta ocupada vira stack
 * trace do Node e a pessoa acha que o programa quebrou — quando na verdade o
 * site já está no ar na outra janela.
 */
export function describeListenError(err, { port, host }) {
  const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
  if (err.code === 'EADDRINUSE') {
    return `\n  Port ${port} is already in use.\n\n` +
      `  Most likely ${BRAND} is ALREADY RUNNING in another window.\n` +
      `  If so, the site is live right now — just open:\n\n` +
      `      http://${shown}:${port}\n\n` +
      `  Otherwise close the other window, or start this one on a\n` +
      `  different port:   PORT=${port + 1} node src/web/server.js\n`;
  }
  if (err.code === 'EACCES') {
    return `\n  No permission to listen on port ${port}. Ports below 1024 need admin rights.\n`;
  }
  return `\n  Could not start the server: ${err.message}\n`;
}

// -------------------------------------------------------------- rotas

const publicRoutes = {
  'GET /api/config': async () => ({
    // nativeCurrency e o RPC público vão junto porque a página usa exatamente
    // estes campos no wallet_addEthereumChain — a carteira do usuário não
    // conhece a Robinhood Chain por padrão, e pedir para ele digitar RPC e
    // chain id à mão é onde a maioria desiste.
    chain: {
      id: CHAIN.id,
      idHex: '0x' + CHAIN.id.toString(16),
      name: CHAIN.name,
      explorer: CHAIN.explorer,
      rpc: CHAIN.rpcUrls[CHAIN.rpcUrls.length - 1],
      nativeCurrency: CHAIN.nativeCurrency,
    },
    contracts: CONTRACTS,
    burnAddress: BURN_ADDRESS,
    functions: catalog(),
    domain: DOMAIN,
    brand: BRAND,
    liveExecution: LIVE_EXECUTION,
    maintenance: maintenance(db),
    // Taxa de serviço: null quando não há. O endereço é público de qualquer
    // forma assim que o primeiro pagamento sai; `problem` é que NÃO sai daqui,
    // porque é diagnóstico do operador, não informação do usuário.
    serviceFee: FEE.enabled ? { bps: FEE.bps, address: FEE.address } : null,
  }),

  'GET /api/health': async () => {
    try {
      const [id, head] = await Promise.all([rpcFast.chainId(), rpcFast.blockNumber()]);
      return { rpc: 'ok', chainId: id, head: head.toString(), expected: CHAIN.id };
    } catch (err) { return { rpc: 'erro', message: err.message }; }
  },

  'POST /api/auth/nonce': async (body) => issueNonce(db, body.address, { domain: DOMAIN, chainId: CHAIN.id }),

  'POST /api/auth/verify': async (body, _p, ctx) => {
    const session = verifyLogin(db, { ...body, domain: DOMAIN, chainId: CHAIN.id });
    ctx.setCookie = sessionCookie(session.token, SECURE);
    return { address: session.address, expiresAt: session.expiresAt };
  },

  'POST /api/auth/logout': async (_b, _p, ctx) => {
    logout(db, ctx.token);
    ctx.setCookie = clearCookie();
    return { ok: true };
  },

  'GET /api/auth/me': async (_b, _p, ctx) => ({
    address: ctx.session?.address ?? null,
    termsAccepted: ctx.session ? hasAcceptedTerms(db, ctx.session.address) : false,
  }),

  'GET /api/tokens': async () => listTokens(db, 100).map((t) => ({
    address: t.address, symbol: t.symbol, name: t.name, pool: t.pool,
    launchBlock: t.launch_block, isToken0: !!t.is_token0,
  })),

  'POST /api/airdrop/validate': async (body) => {
    const p = parseRecipients(body.csv ?? '', body.decimals ?? 18);
    return {
      count: p.recipients.length, total: p.total.toString(),
      totalFormatted: formatUnits(p.total, body.decimals ?? 18, 4),
      errors: p.errors,
      sample: p.recipients.slice(0, 5).map((r) => ({ address: r.address, amount: r.amount.toString() })),
    };
  },
};

const privateRoutes = {
  'GET /api/operator/status': async (_b, _p, ctx) => {
    if (!isAdmin(ctx.session.address)) throw authErr('not an operator account', 403);
    return operatorStatus(db);
  },

  'POST /api/operator/maintenance': async (body, _p, ctx) => {
    if (!isAdmin(ctx.session.address)) throw authErr('not an operator account', 403);
    return setMaintenance(db, body.on === true, { reason: body.reason, by: ctx.session.address });
  },

  'GET /api/agents': async (_b, _p, ctx) =>
    listAgents(db).filter((a) => isOwner(a.id, ctx)).map((a) => ({
      ...a, functions: agentFunctions(db, a.id).filter((f) => f.enabled).map((f) => f.function_id),
    })),

  'POST /api/terms/accept': async (_b, _p, ctx) => {
    acceptTerms(db, ctx.session.address);
    return { ok: true, acceptedAt: Date.now() };
  },

  'POST /api/agents': async (body, _p, ctx) => {
    if (!hasAcceptedTerms(db, ctx.session.address)) {
      throw new Error('please read and accept the terms before creating an agent');
    }
    // Gerar uma carteira que sera apagada no proximo deploy é pior do que
    // recusar: o usuario deposita achando que esta tudo certo.
    assertCanCreateAgents();
    const agent = createAgent(db, { label: body.label, password: body.password, policy: body.policy ?? {} });
    db.prepare('UPDATE agents SET owner = ?, target_token = ?, custody = ? WHERE id = ?')
      .run(ctx.session.address, body.token ? String(body.token).toLowerCase() : null,
        body.custody || 'hybrid', agent.id);
    return { ...agent, owner: ctx.session.address };
  },

  /**
   * Troca o token alvo (e o nome) de um agente que já existe.
   *
   * Antes só dava para escolher o token na criação, o que empurrava quem errou
   * o endereço a criar outro agente — e criar agente é gerar carteira nova, com
   * chave nova, para depois ter que mover fundos. Trocar um campo de texto não
   * deveria custar isso.
   *
   * O endereço é inspecionado antes de gravar. Recusar aqui é melhor do que
   * gravar e deixar o erro aparecer só lá na frente, na hora de assinar.
   */
  'PATCH /api/agents/:id': async (body, { id }, ctx) => {
    assertOwnership(db, id, ctx.session.address);

    if (body.label !== undefined) {
      const label = String(body.label).trim().slice(0, 60);
      if (!label) throw new Error('the label cannot be empty');
      db.prepare('UPDATE agents SET label = ? WHERE id = ?').run(label, id);
    }

    let tokenInfo = null;
    if (body.token !== undefined) {
      const raw = String(body.token || '').trim();
      if (!raw) {
        db.prepare('UPDATE agents SET target_token = NULL WHERE id = ?').run(id);
      } else {
        tokenInfo = await inspectTokenCached(raw);
        if (!tokenInfo.valid) throw new Error(tokenInfo.verdict);
        // Um token fora da pons não é recusado por capricho: sem ele a factory
        // não tem lançamento, o locker não tem posição e as rewards não existem.
        // Metade das funções ficaria sem chão.
        // Indeterminado também não grava: gravar um token que não deu para
        // verificar seria transformar uma dúvida em configuração salva.
        if (tokenInfo.isPonsToken !== true && body.force !== true) {
          throw Object.assign(new Error(tokenInfo.verdict), { tokenInfo });
        }
        db.prepare('UPDATE agents SET target_token = ? WHERE id = ?').run(tokenInfo.address.toLowerCase(), id);
      }
    }

    return { ok: true, agent: getAgent(db, id), tokenInfo };
  },

  'GET /api/agents/:id': async (_b, { id }, ctx) => {
    assertOwnership(db, id, ctx.session.address);
    const agent = getAgent(db, id);
    let balances = null;
    try { balances = await agentBalances(rpcFast, agent.address); } catch { /* rede indisponível: a tela abre mesmo assim */ }
    // Falha de rede não vira veredito: sem saldo lido, o status fica como está.
    if (balances) agent.status = syncFundedStatus(db, agent, balances.eth);
    return {
      ...agent, keystore_path: undefined,
      balances: balances && {
        eth: balances.eth.toString(), ethFormatted: balances.ethFormatted, weth: balances.weth.toString(),
      },
      functions: agentFunctions(db, agent.id),
      decisions: recentDecisions(db, agent.id, 30),
    };
  },

  'POST /api/agents/:id/functions': async (body, { id }, ctx) => {
    assertOwnership(db, id, ctx.session.address);
    if (body.enabled === false) { disableFunction(db, id, body.functionId); return { ok: true }; }
    return { ok: true, params: enableFunction(db, id, body.functionId, body.params ?? {}) };
  },

  'POST /api/agents/:id/run': async (body, { id }, ctx) => {
    assertOwnership(db, id, ctx.session.address);
    return runAgent(db, rpc, id, { tokenAddress: body.token, persist: body.persist !== false });
  },

  /** Devolve as transações prontas para o usuário assinar na carteira dele. */
  'POST /api/agents/:id/delegation': async (body, { id }, ctx) => {
    assertOwnership(db, id, ctx.session.address);
    const agent = getAgent(db, id);
    const token = String(body.token || agent.target_token || '').toLowerCase();
    if (!token) throw new Error('provide the token address');

    let status = null;
    try { status = await delegationStatus(rpcFast, { token, agentAddress: agent.address }); }
    catch (e) { status = { error: e.message }; }

    // Inspeciona o endereço antes de julgar a transação. `TokenNotFound` é a
    // resposta certa do contrato para várias perguntas diferentes — endereço de
    // outra rede, endereço de carteira, token de outra plataforma — e só a
    // inspeção separa uma da outra.
    let info = null;
    try { info = await inspectTokenCached(token); }
    catch (e) { info = { address: token, error: e.message }; }

    let deployer = info?.deployer ?? null;
    if (!deployer) { try { deployer = getToken(db, token)?.deployer ?? null; } catch { /* não indexado */ } }

    // Simula cada transação com o endereço que está conectado ANTES de oferecer
    // o botão. A MetaMask já avisa "likely to fail", mas não diz por quê — e é o
    // porquê que resolve o problema. Aqui a resposta vem do próprio contrato.
    const from = ctx.session.address;
    const transactions = await Promise.all(
      delegationCalls({ token, agentAddress: agent.address }).map(async (c) => {
        const data = encodeFunctionData(c.item, c.args);
        const tx = {
          label: c.label, note: c.note, to: c.to, data,
          signature: `${c.item.name}(${c.item.inputs.map((i) => i.type).join(',')})`,
        };
        try {
          await rpcFast.call('eth_call', [{ to: c.to, from, data }, 'latest']);
          tx.simulation = { ok: true };
        } catch (err) {
          const { decoded, human } = explainRpcError(err, { deployer });
          // Falha de rede não é veredito sobre a transação. Marcar 429 como
          // "vai falhar" é mentir com confiança — o contrato nem foi consultado.
          const transport = !decoded && (err?.transport || err?.httpStatus !== undefined);
          tx.simulation = transport
            ? { ok: null, unknown: true, reason: human }
            : { ok: false, error: decoded?.name ?? null, reason: human };
        }
        return tx;
      }),
    );

    return { agentAddress: agent.address, token, tokenInfo: info, status, deployer, connected: from, transactions };
  },

  /**
   * Saque. O destino padrão é a carteira que fez login — devolver para o dono é
   * o caso normal, e digitar endereço à mão é onde se perde dinheiro.
   *
   * Não é bloqueado por PONS_ALLOW_LIVE_EXECUTION nem pela manutenção: ninguém
   * pode ficar preso do lado de fora do próprio dinheiro. Mesmo princípio da
   * exportação de keystore.
   */
  'POST /api/agents/:id/withdraw': async (body, { id }, ctx) => {
    assertOwnership(db, id, ctx.session.address);
    if (!body.password) throw new Error('the keystore password is required to sign the withdrawal');

    const agent = getAgent(db, id);
    const to = body.to || ctx.session.address;
    const asset = body.asset === 'token' ? 'token' : 'eth';
    const tokenAddress = asset === 'token' ? (body.token || agent.target_token) : null;

    const unlocked = unlockAgent(db, id, body.password);
    try {
      return await withdrawFromAgent({
        rpc, agent, privateKey: unlocked.privateKey, to, asset, tokenAddress,
        amountWei: body.amountWei ?? null,
        dryRun: body.live !== true,
      });
    } finally {
      unlocked.privateKey = null;
    }
  },

  'GET /api/agents/:id/keystore': async (_b, { id }, ctx) => {
    assertOwnership(db, id, ctx.session.address);
    return exportKeystore(db, id);
  },

  'POST /api/decisions/:id/approve': async (_b, { id }, ctx) => {
    const d = db.prepare('SELECT agent_id FROM decisions WHERE id = ?').get(Number(id));
    if (!d) throw authErr('decision not found', 404);
    assertOwnership(db, d.agent_id, ctx.session.address);
    approveDecision(db, Number(id));
    return { ok: true };
  },

  /**
   * Executa uma decisao aprovada. A senha do keystore vem no corpo, e usada
   * para desbloquear a chave apenas durante a execucao, e nao e persistida.
   */
  'POST /api/decisions/:id/execute': async (body, { id }, ctx) => {
    const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(Number(id));
    if (!row) throw authErr('decision not found', 404);
    assertOwnership(db, row.agent_id, ctx.session.address);

    if (row.status !== 'approved') {
      throw new Error(`decision is "${row.status}" — only approved decisions can be executed`);
    }
    if (!body.password) throw new Error('the keystore password is required to sign');

    const wantsLive = body.live === true;
    const dryRun = !(wantsLive && LIVE_EXECUTION);

    // Termos mudaram desde que esta conta aceitou: exige reaceite antes de
    // enviar qualquer coisa de verdade. Só no caminho ao vivo — simular
    // continua livre, e saque e export de keystore nunca são bloqueados.
    if (!dryRun && !hasAcceptedTerms(db, ctx.session.address)) {
      throw new Error('the terms of use changed — please read and accept them again before sending transactions');
    }

    let unlocked;
    try { unlocked = unlockAgent(db, row.agent_id, body.password); }
    catch (err) { throw new Error(`could not unlock the agent: ${err.message}`); }

    const steps = [];
    try {
      const decision = JSON.parse(row.payload);
      const result = await executeDecision({
        rpc, db, decision,
        agent: { address: unlocked.address, id: unlocked.id },
        privateKey: unlocked.privateKey,
        dryRun,
        reserveWei: BigInt(unlocked.policy.reserveGasWei ?? 0),
        onStep: (s) => steps.push({ ...s, gasUsed: s.gasUsed?.toString(), amount: s.amount?.toString(), maxCost: s.maxCost?.toString(), gasLimit: s.gasLimit?.toString() }),
      });

      if (!dryRun) {
        db.prepare("UPDATE decisions SET tx_hash = ? WHERE id = ?")
          .run(result.steps.find((x) => x.hash)?.hash ?? null, Number(id));
        recordExecution(db, Number(id), { status: 'executed', steps: result.steps.map(serializeStep) });
      }
      return { ...result, liveAllowed: LIVE_EXECUTION, steps: result.steps.map(serializeStep), trace: steps };
    } catch (err) {
      // Falha parcial é o caso que importa: pode haver transação já confirmada
      // antes do erro. Guardamos os passos para saber onde o dinheiro parou.
      if (!dryRun) recordExecution(db, Number(id), { status: 'failed', error: err.message, steps });
      throw new Error(`execution stopped: ${err.message}`);
    } finally {
      unlocked.privateKey = null;
    }
  },

  'POST /api/decisions/:id/reject': async (_b, { id }, ctx) => {
    const d = db.prepare('SELECT agent_id FROM decisions WHERE id = ?').get(Number(id));
    if (!d) throw authErr('decision not found', 404);
    assertOwnership(db, d.agent_id, ctx.session.address);
    rejectDecision(db, Number(id));
    return { ok: true };
  },
};

/** Casa a rota concreta contra os padrões bloqueados em manutenção. */
function isBlockedRoute(method, path) {
  for (const key of BLOCKED_IN_MAINTENANCE) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const pp = pattern.split('/');
    const ap = path.split('/');
    if (pp.length !== ap.length) continue;
    if (pp.every((seg, i) => seg.startsWith(':') || seg === ap[i])) return true;
  }
  return false;
}

const serializeStep = (s) => ({
  label: s.label,
  hash: s.hash ?? null,
  skipped: s.skipped ?? null,
  dryRun: s.dryRun ?? false,
  gasUsed: s.gasUsed?.toString() ?? null,
  gasLimit: s.gasLimit?.toString() ?? null,
  maxCost: s.maxCost?.toString() ?? null,
  // `failed` é o passo opcional que não foi (hoje, só a taxa de serviço).
  // `notSimulated`/`reason` a tela já tentava ler e nunca chegavam aqui — o
  // ramo estava morto desde que o ensaio passou a marcar passos dependentes.
  failed: s.failed ?? null,
  notSimulated: s.notSimulated ?? false,
  reason: s.reason ?? null,
});

const isOwner = (agentId, ctx) => {
  try { return assertOwnership(db, agentId, ctx.session.address); } catch { return false; }
};

function match(table, method, path) {
  for (const key of Object.keys(table)) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const pp = pattern.split('/');
    const ap = path.split('/');
    if (pp.length !== ap.length) continue;
    const params = {};
    if (pp.every((seg, i) => (seg.startsWith(':') ? (params[seg.slice(1)] = decodeURIComponent(ap[i]), true) : seg === ap[i]))) {
      return { handler: table[key], params };
    }
  }
  return null;
}

const PAGES = {
  '/': 'landing.html',
  '/index.html': 'landing.html',
  '/app': 'app.html',
  '/app/': 'app.html',
  '/terms': 'terms.html',
  '/terms/': 'terms.html',
};

// O demo saiu do site. A pagina e o gerador continuam no repositorio
// (src/web/pages/demo.html e scripts/build-demo.mjs), mas nao sao mais
// servidos: nem link na landing, nem rota. Para religar, basta descomentar o
// bloco abaixo e a rota correspondente em start(), e recolocar os dois links.
//
// let demoPage = null;
// try {
//   demoPage = Buffer.from(
//     readFileSync(join(HERE, 'pages', 'demo.html'), 'utf8')
//       .replaceAll('{{BRAND_HTML}}', brandHtml())
//       .replaceAll('{{BRAND}}', escapeHtml(BRAND))
//       .replaceAll('{{FEE_NOTICE}}', feeNotice())
//       .replaceAll('{{FEE_NOTICE_BLOCK}}', feeNoticeBlock())
//       .replaceAll('{{TOKEN_BADGE}}', tokenBadge()),
//     'utf8',
//   );
// } catch { /* opcional */ }

export function start({ port = Number(process.env.PORT || 8787), host = process.env.HOST || '127.0.0.1' } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }

    // /demo foi removido do site; quem chegar por link antigo vai para o app.
    if (url.pathname === '/demo' || url.pathname === '/demo/') {
      res.writeHead(302, { location: '/app' });
      return res.end();
    }

    // Imagens da marca. O nome carrega o tamanho, entao o conteudo nunca muda
    // para um mesmo caminho — daí o cache de um ano com `immutable`.
    if (url.pathname.startsWith('/assets/')) {
      const arquivo = url.pathname.slice('/assets/'.length);
      const bytes = ASSETS.get(arquivo);
      if (!bytes) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=31536000, immutable',
        'content-length': bytes.length,
      });
      return res.end(bytes);
    }

    // Favicon: o navegador pede /favicon.ico sozinho, sem passar pelo HTML.
    if (url.pathname === '/favicon.ico') {
      const bytes = ASSETS.get('brand-32.png');
      if (!bytes) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
      return res.end(bytes);
    }

    if (PAGES[url.pathname]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
      return res.end(page(PAGES[url.pathname]));
    }

    const token = parseCookies(req.headers.cookie).pons_session;
    const ctx = { token, session: sessionFromToken(db, token), setCookie: null };

    // rate limit antes de qualquer trabalho
    const routeKey = `${req.method} ${url.pathname}`;
    const limit = LIMITS[routeKey] ?? LIMITS.default;
    const rl = rateLimit(`${clientIp(req, TRUST_PROXY)}|${LIMITS[routeKey] ? routeKey : 'default'}`, limit);
    if (!rl.allowed) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(rl.retryAfter) });
      return res.end(JSON.stringify({ error: `too many requests, retry in ${rl.retryAfter}s` }));
    }

    try {
      const body = (req.method === 'POST' || req.method === 'PATCH') ? await readBody(req) : {};
      let route = match(publicRoutes, req.method, url.pathname);
      if (!route) {
        route = match(privateRoutes, req.method, url.pathname);
        if (route && !ctx.session) throw authErr('connect your wallet to continue');
      }
      if (!route) return send(res, 404, { error: 'route not found' });

      // Em manutenção bloqueamos só o que cria ou gasta. Ler o estado e
      // exportar o keystore continuam liberados de propósito: quem quiser
      // tirar o próprio dinheiro nunca pode ficar preso do lado de fora.
      const m = maintenance(db);
      if (m.on && isBlockedRoute(req.method, url.pathname) && !isAdmin(ctx.session?.address)) {
        throw Object.assign(
          new Error(m.reason
            ? `paused for maintenance: ${m.reason}`
            : 'paused for maintenance — reading and keystore export still work'),
          { code: 503 },
        );
      }

      const result = await route.handler(body, route.params, ctx);
      return send(res, 200, result, {
        ...SECURITY_HEADERS,
        ...(ctx.setCookie ? { 'set-cookie': ctx.setCookie } : {}),
      });
    } catch (err) {
      return send(res, err.code ?? 400, { error: err.message });
    }
  });

  server.on('error', (err) => {
    console.error(describeListenError(err, { port, host }));
    process.exit(1);
  });

  server.listen(port, host, () => {
    console.log(`${BRAND}  →  http://${host}:${port}`);
    console.log(`chain ${CHAIN.id} (${CHAIN.network}) · factory ${CONTRACTS.factory}`);
    // Dizer em voz alta ONDE os dados estão e QUANTOS agentes existem.
    // Quando alguém extrai uma versão nova numa pasta nova, os agentes ficam
    // na pasta antiga e o site abre vazio — parece perda, é só endereço errado.
    // Uma linha no arranque resolve a dúvida antes que ela vire susto.
    try {
      const n = db.prepare('SELECT COUNT(*) AS n FROM agents').get().n;
      console.log(`data ${resolve(process.env.PONS_DB || './data/pons.sqlite')} · ${n} agent(s) stored`);
    } catch { /* banco recém-criado */ }
    warnIfUnsealed();
    // O aviso mais importante do arranque: sem volume, tudo funciona e todo o
    // dinheiro dos usuarios evapora no proximo deploy, sem erro nenhum antes.
    const persist = dataPersistence();
    if (persist.checked && persist.persistent === false) {
      console.error(persistenceWarning(persist));
      if (process.env.PONS_ALLOW_EPHEMERAL_DATA === '1') {
        console.warn('NOTICE: PONS_ALLOW_EPHEMERAL_DATA=1 — creating agents stays enabled anyway.');
      }
    } else if (persist.checked) {
      console.log(`data volume ...... ${persist.dir} is on a persistent mount ✓`);
    }
    const m = maintenance(db);
    if (m.on) console.warn(`NOTICE: maintenance mode is ON (${m.source}) — creating agents and executing are paused.`);
    // Formato conferido de verdade: um endereço com erro de digitação passava em
    // silêncio e só aparecia como "not an operator account" na hora do aperto.
    if (!process.env.PONS_ADMIN_ADDRESS) {
      console.warn('NOTICE: PONS_ADMIN_ADDRESS is not set — you will not be able to pause the service from the app.');
    } else if (!isAddress(process.env.PONS_ADMIN_ADDRESS.trim())) {
      console.error(`ERROR: PONS_ADMIN_ADDRESS is not a valid 0x address ("${process.env.PONS_ADMIN_ADDRESS.trim().slice(0, 12)}") — nobody can pause the service.`);
    }
    if (LIVE_EXECUTION) console.warn('WARNING: live execution is ON — transactions can be sent for real.');
    // Erro e não aviso: se a taxa está mal configurada, o operador roda achando
    // que recebe e não recebe. Ainda assim não derruba o processo — ver fee.js.
    if (FEE.problem) console.error(`ERROR: ${FEE.problem}`);
    else if (FEE.enabled) console.log(`service fee: ${FEE.bps / 100}% of ETH spent and of rewards collected, paid to ${FEE.address}`);
    if (host !== '127.0.0.1' && !SECURE) {
      console.warn('WARNING: serving outside localhost without PONS_SECURE_COOKIES=1 or HTTPS.');
    }
  });

  // Encerramento gracioso: o SQLite precisa fechar limpo para não deixar WAL órfão.
  const shutdown = (signal) => {
    console.log(`\n${signal} received, shutting down`);
    server.close(() => {
      try { db.close(); } catch { /* já fechado */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

// Comparação de caminho precisa passar por pathToFileURL: no Windows o
// process.argv[1] vem como C:\...\server.js, que nunca bate com a URL
// file:///C:/... do import.meta. Sem isso o servidor carregava e saía calado.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
