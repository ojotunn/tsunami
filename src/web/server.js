// Servidor do site. node:http puro, sem dependências.
//
// Custódia híbrida:
//  - a identidade é a carteira do usuário (login por assinatura, sem senha);
//  - as creator rewards chegam por delegação (setFeeRedirect), assinada na
//    carteira dele — o servidor nunca vê a chave privada do usuário;
//  - a carteira do agente, gerada aqui, guarda apenas o capital de operação.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { RpcClient } from '../core/rpc.js';
import { CHAIN, CONTRACTS, BURN_ADDRESS, TOKEN_ABI, abiItem } from '../chain/config.js';
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
import { delegationCallsV2 } from '../chain/v2.js';
import { formatUnits, parseUnits } from '../market/pricing.js';
import { validatePolicy } from '../agent/policy.js';
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
import { startTreasury, treasuryStatus } from '../agent/treasury.js';
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
const BRAND = process.env.PONS_BRAND || 'Blizzard AI';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * Marca do logotipo. A última palavra ganha a cor de destaque ("Blizzard AI"
 * vira Blizzard + AI em ciano); com hífen, a parte depois dele (`pons-mm`).
 * Um nome de uma palavra só fica inteiro em destaque, senão sairia cinza e
 * sem identidade nenhuma.
 */
const brandHtml = () => {
  const h = BRAND.indexOf('-');
  if (h > 0) return `${escapeHtml(BRAND.slice(0, h))}<span>${escapeHtml(BRAND.slice(h))}</span>`;
  const s = BRAND.lastIndexOf(' ');
  return s > 0
    ? `${escapeHtml(BRAND.slice(0, s))}&nbsp;<span>${escapeHtml(BRAND.slice(s + 1))}</span>`
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
   If you run this software yourself, there is no fee at all.${treasuryStatus().enabled
    ? ` <strong>Where it goes:</strong> 100% of the fee lands in a public treasury wallet
   (<code>${escapeHtml(treasuryStatus().address)}</code>) that buys back and burns
   ${escapeHtml(SITE_TOKEN_SYMBOL)}. Nothing is kept by the operator.` : ''}`;

const feeNotice = () => (FEE.enabled ? `<li>${FEE_TEXT()}</li>` : '');
const feeNoticeBlock = () => (FEE.enabled ? `<div class="note" style="margin-bottom:16px">${FEE_TEXT()}</div>` : '');

// Contrato do token da casa. O padrao e o BLIZZARD AI (pons v2, conferido na
// chain em 06/09/2026: nome, simbolo, factory v2 e curva). PONS_SITE_TOKEN
// sobrescreve, e PONS_SITE_TOKEN=none tira o badge, para quem hospedar outra
// instancia nao sair divulgando o token de outra pessoa.
const SITE_TOKEN = (() => {
  const cru = (process.env.PONS_SITE_TOKEN ?? '0xe1d526E442469E4A9881FfD0afbA79a3ee88D250').trim();
  return cru.toLowerCase() === 'none' ? '' : cru;
})();
const SITE_TOKEN_SYMBOL = (process.env.PONS_SITE_TOKEN_SYMBOL || 'BLIZZARD AI').trim();

/**
 * Perfil no X. O padrao e o perfil do Blizzard AI; PONS_SITE_X sobrescreve
 * (e PONS_SITE_X=none tira o link) para quem hospedar outra instancia.
 *
 * So aceita URL do proprio x.com/twitter.com — um link de rodape que aponta
 * para qualquer lugar e um vetor bom demais para deixar aberto por descuido.
 */
const SITE_X = (() => {
  const cru = (process.env.PONS_SITE_X ?? 'https://x.com/BlizzardAIPons').trim();
  if (!cru || cru.toLowerCase() === 'none') return null;
  try {
    const u = new URL(cru);
    if (u.protocol !== 'https:') return null;
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(u.hostname)) return null;
    return { url: u.href, handle: u.pathname.replace(/^\/+|\/+$/g, '') };
  } catch { return null; }
})();

/** Logo do X desenhado inline: a CSP bloqueia imagem de fora, e um SVG de 200
 *  bytes nao merece virar mais um arquivo para servir. */
const socialLink = (sep = ' ·') => (SITE_X ? `
  <a href="${escapeHtml(SITE_X.url)}" target="_blank" rel="noopener me"
     style="display:inline-flex;align-items:center;gap:6px"
     aria-label="${escapeHtml(SITE_X.handle)} on X">
    <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"
      ><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
    <span class="hd">@${escapeHtml(SITE_X.handle)}</span></a>${sep}` : '');

/**
 * Secao da landing "para onde vai a taxa". So existe quando a tesouraria esta
 * ligada; sem ela, o site nao promete recompra nenhuma. Os numeros vem de
 * /api/burn na hora, lidos da chain e da tabela de decisoes, para a promessa
 * ser verificavel na propria pagina e nao so no explorer.
 */
function feeFlow() {
  const st = treasuryStatus();
  if (!st.enabled || !FEE.enabled) return '';
  const addr = escapeHtml(st.address);
  const sym = escapeHtml(SITE_TOKEN_SYMBOL);
  return `
<section id="burn" class="alt"><div class="wrap">
  <div class="lbl">Where the fee goes</div>
  <h2>100% of the service fee buys back and burns ${sym}</h2>
  <p class="sub">Every fee paid on this site lands in a public treasury wallet. An agent — the same
     software you use — spends it buying ${sym} and sends the tokens to the burn address. The
     operator keeps nothing.</p>
  <div class="burnstats" id="burnStats">
    <div><small>Waiting in treasury</small><b data-k="ethWaiting">…</b><span>ETH</span></div>
    <div><small>Buybacks executed</small><b data-k="buybacks">…</b><span>by the treasury</span></div>
    <div><small>ETH spent on buybacks</small><b data-k="ethSpent">…</b><span>ETH</span></div>
    <div><small>Burned so far</small><b data-k="burnedPct">…</b><span>of total supply</span></div>
  </div>
  <p class="note">Treasury wallet <code class="mono">${addr}</code>
     · <a href="${escapeHtml(CHAIN.explorer)}/address/${addr}" target="_blank" rel="noopener">view on the explorer</a>
     <span id="lastBurn"></span></p>
  <script>
  fetch('/api/burn').then((r) => r.json()).then((b) => {
    if (!b || !b.enabled) return;
    const set = (k, v) => { const el = document.querySelector('#burnStats [data-k="' + k + '"]'); if (el) el.textContent = v; };
    set('ethWaiting', b.ethWaiting ?? '—');
    set('buybacks', String(b.buybacks ?? 0));
    set('ethSpent', b.ethSpent ?? '—');
    set('burnedPct', b.burnedPct != null ? b.burnedPct + '%' : '—');
    if (b.lastTx) {
      const a = document.createElement('a'); a.href = b.explorer + '/tx/' + b.lastTx; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = 'last burn'; const s = document.getElementById('lastBurn'); s.append(' · '); s.append(a);
    }
  }).catch(() => {});
  </script>
</div></section>`;
}

// Numeros da tesouraria, com cache de um minuto: a pagina inicial e publica e
// nao pode virar uma leitura de chain por visita.
let burnCache = { at: 0, body: null };
async function burnStats() {
  const st = treasuryStatus();
  if (!st.enabled) return { enabled: false };
  if (burnCache.body && Date.now() - burnCache.at < 60_000) return burnCache.body;

  const agent = getAgent(db, st.agentId);
  const token = st.token;
  const balanceOf = abiItem(TOKEN_ABI, 'balanceOf');
  const [eth, burned, supply, decimals] = await Promise.all([
    rpcFast.getBalance(st.address).catch(() => null),
    rpcFast.read(token, balanceOf, [BURN_ADDRESS]).catch(() => null),
    rpcFast.read(token, abiItem(TOKEN_ABI, 'totalSupply')).catch(() => null),
    rpcFast.read(token, abiItem(TOKEN_ABI, 'decimals')).then(Number).catch(() => 18),
  ]);
  const rows = agent
    ? db.prepare("SELECT tx_hash, ts, payload FROM decisions WHERE agent_id = ? AND kind = 'buyback_burn' AND status = 'executed' ORDER BY ts DESC").all(agent.id)
    : [];
  let spent = 0n;
  for (const r of rows) { try { spent += BigInt(JSON.parse(r.payload).notionalWei ?? 0); } catch { /* linha antiga */ } }
  const pct = burned !== null && supply && supply > 0n ? Number((burned * 10000n) / supply) / 100 : null;

  burnCache = {
    at: Date.now(),
    body: {
      enabled: true,
      treasury: st.address,
      token,
      symbol: getToken(db, token)?.symbol ?? SITE_TOKEN_SYMBOL,
      ethWaiting: eth === null ? null : formatUnits(eth, 18, 4),
      buybacks: rows.length,
      ethSpent: formatUnits(spent, 18, 4),
      burnedTotal: burned === null ? null : formatUnits(burned, decimals, 0),
      burnedPct: pct === null ? null : pct.toFixed(2),
      lastTx: rows[0]?.tx_hash ?? null,
      lastAt: rows[0]?.ts ?? null,
      feeAddressMatches: st.feeAddressMatches,
      explorer: CHAIN.explorer,
    },
  };
  return burnCache.body;
}

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
const ASSET_ETAGS = new Map();
for (const nome of ['brand-32.png', 'brand-64.png', 'brand-128.png', 'brand-180.png',
  'brand-256.png', 'brand-512.png']) {
  try {
    const bytes = readFileSync(join(HERE, 'assets', nome));
    ASSETS.set(nome, bytes);
    // ETag derivada do conteudo: trocar a marca troca a etiqueta sozinho, sem
    // ninguem precisar lembrar de mexer em versao nenhuma.
    ASSET_ETAGS.set(nome, `"${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}"`);
  } catch { /* asset ausente nao derruba o site */ }
}

/**
 * Versao das imagens, derivada do conteudo de todas elas juntas.
 *
 * As paginas pedem /assets/brand-64.png?v=<isto>. Sem esse sufixo, a troca de
 * marca nao chega em quem visitou o site enquanto ele mandava guardar por um
 * ano com `immutable` — esse cabecalho manda o navegador NAO revalidar, entao
 * nem ETag nova adianta: ele simplesmente nao pergunta. Mudar a URL contorna
 * isso, porque um endereco novo nao esta no cache de ninguem.
 */
const ASSETS_V = createHash('sha256')
  .update([...ASSETS.values()].reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0)))
  .digest('hex').slice(0, 10);

const pageCache = new Map();
const page = (name) => {
  if (!pageCache.has(name)) {
    const html = readFileSync(join(HERE, 'pages', name), 'utf8')
      .replaceAll('{{BRAND_HTML}}', brandHtml())
      .replaceAll('{{BRAND}}', escapeHtml(BRAND))
      .replaceAll('{{FEE_NOTICE}}', feeNotice())
      .replaceAll('{{FEE_NOTICE_BLOCK}}', feeNoticeBlock())
      .replaceAll('{{TOKEN_BADGE}}', tokenBadge())
      .replaceAll('{{FEE_FLOW}}', feeFlow())
      .replaceAll('{{SOCIAL_NAV}}', socialLink(''))
      .replaceAll('{{SOCIAL}}', socialLink())
      .replaceAll('{{ASSETS_V}}', ASSETS_V);
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
    serviceFee: FEE.enabled ? {
      bps: FEE.bps, address: FEE.address,
      // Quando ha tesouraria, a taxa e recompra e queima do token da casa.
      burn: treasuryStatus().enabled ? { treasury: treasuryStatus().address, token: treasuryStatus().token, symbol: SITE_TOKEN_SYMBOL } : null,
    } : null,
  }),

  'GET /api/burn': async () => burnStats(),

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

  /**
   * Edita a política de risco do agente. Os valores chegam em ETH (o que a
   * pessoa lê na tela) e são guardados em wei; o que não vier fica como está.
   *
   * Existe porque o teto padrão de 0,01 ETH por operação bloqueava a compra
   * de quem depositou mais do que isso, e a única saída era criar outro
   * agente — carteira nova, fundos para mover — para voltar ao mesmo teto.
   */
  'PATCH /api/agents/:id/policy': async (body, { id }, ctx) => {
    assertOwnership(db, id, ctx.session.address);
    const agent = getAgent(db, id);
    const next = { ...agent.policy };

    const eth = (key, field) => {
      if (body[key] === undefined || body[key] === '') return;
      const raw = String(body[key]).trim();
      if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`${key} must be a positive amount of ETH, like 0.05`);
      next[field] = parseUnits(raw, 18).toString();
    };
    const int = (key, field, { min = 0, max = 100000 } = {}) => {
      if (body[key] === undefined || body[key] === '') return;
      const n = Number(body[key]);
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be a whole number between ${min} and ${max}`);
      next[field] = n;
    };
    eth('maxPerTradeEth', 'maxNotionalPerTradeWei');
    eth('maxDailyEth', 'maxDailyNotionalWei');
    eth('reserveGasEth', 'reserveGasWei');
    eth('approveAboveEth', 'requireApprovalAboveWei');
    eth('minPoolLiquidityEth', 'minPoolLiquidityWei');
    int('maxTradesPerHour', 'maxTradesPerHour', { min: 1, max: 1000 });
    int('minSecondsBetweenTrades', 'minSecondsBetweenTrades', { min: 0, max: 86400 });
    if (body.mode !== undefined) next.mode = String(body.mode);

    let policy;
    try { policy = validatePolicy(next); }
    catch (err) {
      // A mensagem do validador fala em wei; a pessoa digitou ETH.
      const msg = err.message.replace('maxNotionalPerTradeWei cannot exceed maxDailyNotionalWei',
        'the per-trade limit cannot be higher than the daily limit');
      throw new Error(msg);
    }
    db.prepare('UPDATE agents SET policy = ? WHERE id = ?').run(JSON.stringify(policy), agent.id);
    return { ok: true, policy };
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
    // V1 delega no locker (setFeeRedirect); V2 delega na factory
    // (transferCreatorFeeRecipient). A inspeção diz qual das duas.
    const calls = info?.version === 'v2'
      ? delegationCallsV2({ token, agentAddress: agent.address })
      : delegationCalls({ token, agentAddress: agent.address });
    const transactions = await Promise.all(
      calls.map(async (c) => {
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

    // Imagens da marca.
    //
    // Este bloco ja teve cache de um ano com `immutable`, e o comentario dizia
    // que o conteudo nunca mudava porque o nome carrega o tamanho. Estava
    // errado: o nome carrega o TAMANHO, nao o conteudo. Numa troca de marca o
    // brand-64.png continua se chamando brand-64.png com um desenho diferente —
    // e quem ja tinha visitado o site ficaria com o logo antigo por um ano, sem
    // nenhuma forma de forcar a atualizacao a nao ser limpar o cache na mao.
    //
    // Agora vai ETag: o navegador guarda por uma hora e depois pergunta "mudou?".
    // Se nao mudou, a resposta e um 304 de alguns bytes. Se mudou, ele pega o
    // arquivo novo no mesmo dia — nao no ano que vem.
    if (url.pathname.startsWith('/assets/')) {
      const arquivo = url.pathname.slice('/assets/'.length);
      const bytes = ASSETS.get(arquivo);
      if (!bytes) { res.writeHead(404); return res.end('not found'); }

      const etag = ASSET_ETAGS.get(arquivo);
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag, 'cache-control': 'public, max-age=3600' });
        return res.end();
      }
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=3600',
        etag,
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
    // Tesouraria: a taxa vira recompra e queima, sem clique. So liga com
    // PONS_TREASURY_AGENT + PONS_TREASURY_PASSWORD; sem eles, nada muda.
    startTreasury({
      db, rpc, live: LIVE_EXECUTION,
      isMaintenanceOn: () => maintenance(db).on,
      recordExecution,
      log: console.log,
    });
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
