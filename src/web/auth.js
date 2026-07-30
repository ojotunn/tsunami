// Autenticação por assinatura de carteira (padrão EIP-4361 / "Sign-In with Ethereum").
//
// O usuário prova que controla um endereço assinando uma mensagem com nonce.
// O servidor recupera o endereço da assinatura — nunca há senha, nunca há chave
// privada do usuário no servidor. É o mesmo mecanismo que sustenta o modo de
// delegação sem chave: quem assina o login é quem pode assinar o setFeeRedirect.
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { recoverPersonalSignature } from '../core/secp256k1.js';
import { isAddress, eqAddress, toChecksumAddress } from '../core/hex.js';

const NONCE_TTL_MS = 10 * 60 * 1000;         // 10 minutos para assinar
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 dias

export function migrateAuth(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      address     TEXT PRIMARY KEY,
      created_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL,
      label       TEXT,
      terms_accepted_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS nonces (
      nonce      TEXT PRIMARY KEY,
      address    TEXT NOT NULL,
      message    TEXT,
      created_at INTEGER NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      address    TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  // agentes passam a pertencer a uma conta
  const cols = db.prepare('PRAGMA table_info(agents)').all().map((c) => c.name);
  if (!cols.includes('owner')) db.exec('ALTER TABLE agents ADD COLUMN owner TEXT');
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userCols.includes('terms_accepted_at')) db.exec('ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER');
  const nonceCols = db.prepare('PRAGMA table_info(nonces)').all().map((c) => c.name);
  if (!nonceCols.includes('message')) db.exec('ALTER TABLE nonces ADD COLUMN message TEXT');
  // Linhas antigas ficam com NULL, que vira versão 0 na leitura — reaceite
  // obrigatório, sem backfill. É o comportamento certo: ninguém concordou com
  // um texto que ainda não existia quando aceitou.
  if (!userCols.includes('terms_version')) db.exec('ALTER TABLE users ADD COLUMN terms_version INTEGER');
}

const hashToken = (t) => createHash('sha256').update(t).digest('hex');

/** Mensagem que a carteira vai assinar. Legível de propósito: o usuário lê antes de assinar. */
export function loginMessage({ address, nonce, domain, chainId }) {
  return [
    `${domain} wants to verify that you control this wallet.`,
    '',
    'Signing this message authorizes no transaction, moves no funds,',
    'and gives no access to your wallet.',
    '',
    `Address: ${address}`,
    `Network: ${chainId}`,
    `Nonce: ${nonce}`,
  ].join('\n');
}

/**
 * Emite o nonce e GUARDA a mensagem exata que o usuário vai assinar.
 *
 * Guardar em vez de remontar não é preciosismo. A MetaMask devolve o endereço
 * em minúsculas; se a verificação remontar a mensagem com o endereço em
 * checksum, o texto muda, o hash muda, e a assinatura legítima é recusada com
 * "the signature does not match". Comparar contra o texto original elimina
 * essa classe inteira de erro, hoje e em qualquer mudança futura do template.
 */
export function issueNonce(db, address, { domain, chainId } = {}) {
  if (!isAddress(address)) throw new Error('invalid address');
  const nonce = randomBytes(16).toString('hex');
  const message = loginMessage({ address, nonce, domain, chainId });
  db.prepare('INSERT INTO nonces (nonce, address, message, created_at) VALUES (?,?,?,?)')
    .run(nonce, address.toLowerCase(), message, Date.now());
  db.prepare('DELETE FROM nonces WHERE created_at < ?').run(Date.now() - NONCE_TTL_MS);
  return { nonce, message };
}

/**
 * Verifica a assinatura, consome o nonce e devolve um token de sessão.
 * O nonce é de uso único: replay da mesma assinatura não autentica de novo.
 */
export function verifyLogin(db, { address, nonce, signature, domain, chainId }) {
  const row = db.prepare('SELECT * FROM nonces WHERE nonce = ?').get(nonce);
  if (!row) throw new Error('unknown nonce — request a new one');
  if (row.used) throw new Error('nonce already used');
  if (Date.now() - row.created_at > NONCE_TTL_MS) throw new Error('nonce expired');
  if (!eqAddress(row.address, address)) throw new Error('nonce was issued for a different address');

  // Usa a mensagem gravada na emissão. Só cai no template como último recurso,
  // para nonces antigos gravados antes desta coluna existir.
  const message = row.message ?? loginMessage({ address, nonce, domain, chainId });
  let recovered;
  try { recovered = recoverPersonalSignature(message, signature); }
  catch (err) { throw new Error(`unreadable signature: ${err.message}`); }

  if (!eqAddress(recovered, address)) throw new Error('the signature does not match the address provided');

  db.prepare('UPDATE nonces SET used = 1 WHERE nonce = ?').run(nonce);

  const now = Date.now();
  const addr = toChecksumAddress(address);
  db.prepare(`INSERT INTO users (address, created_at, last_seen) VALUES (?,?,?)
              ON CONFLICT(address) DO UPDATE SET last_seen = excluded.last_seen`)
    .run(addr, now, now);

  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, address, created_at, expires_at) VALUES (?,?,?,?)')
    .run(hashToken(token), addr, now, now + SESSION_TTL_MS);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);

  return { token, address: addr, expiresAt: now + SESSION_TTL_MS };
}

export function sessionFromToken(db, token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }
  return { address: row.address, expiresAt: row.expires_at };
}

export const logout = (db, token) =>
  token && db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));

export function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2)
      .map(([k, v]) => [k, decodeURIComponent(v)]),
  );
}

export const sessionCookie = (token, secure) =>
  `pons_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`;

export const clearCookie = () => 'pons_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';

/** Confere que o agente pertence a quem está pedindo. */
export function assertOwnership(db, agentId, address) {
  const row = db.prepare('SELECT owner FROM agents WHERE id = ?').get(agentId);
  if (!row) throw Object.assign(new Error('agent not found'), { code: 404 });
  if (!row.owner || !eqAddress(row.owner, address)) {
    throw Object.assign(new Error('this agent belongs to another account'), { code: 403 });
  }
  return true;
}

/**
 * Versão do texto dos termos. Sobe quando o que a pessoa concordou muda de
 * verdade — a introdução da taxa de serviço é exatamente esse caso.
 *
 * Sem isso, o aceite é um booleano vitalício: quem já tinha agente nunca mais
 * seria perguntado e passaria a pagar uma taxa que não existia quando aceitou.
 */
export const TERMS_VERSION = 2;

/** Aceite dos termos: exigido antes do primeiro agente, guardado por conta. */
export const acceptTerms = (db, address) =>
  db.prepare('UPDATE users SET terms_accepted_at = ?, terms_version = ? WHERE address = ?')
    .run(Date.now(), TERMS_VERSION, address);

export const hasAcceptedTerms = (db, address) => {
  const row = db.prepare('SELECT terms_accepted_at, terms_version FROM users WHERE address = ?').get(address);
  return !!row?.terms_accepted_at && (row.terms_version ?? 0) >= TERMS_VERSION;
};

export { timingSafeEqual };
