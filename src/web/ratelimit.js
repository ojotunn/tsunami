// Rate limiting em memória, por IP e por rota.
//
// Não é um limitador distribuído — com várias instâncias cada uma tem seu próprio
// contador. Para um único processo, que é o alvo aqui, resolve o que importa:
// impedir que alguém varra endereços pedindo nonce ou crie agentes em massa
// enchendo o disco de keystores.
const buckets = new Map();

/** Janela deslizante simples: guarda os timestamps dentro da janela. */
export function rateLimit(key, { max, windowMs }) {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    buckets.set(key, hits);
    return { allowed: false, retryAfter: Math.ceil((windowMs - (now - hits[0])) / 1000) };
  }
  hits.push(now);
  buckets.set(key, hits);
  return { allowed: true, remaining: max - hits.length };
}

/** Limpeza periódica para a memória não crescer indefinidamente. */
export function startCleanup(windowMs = 3600_000, everyMs = 300_000) {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, hits] of buckets) {
      const live = hits.filter((t) => now - t < windowMs);
      if (live.length) buckets.set(key, live);
      else buckets.delete(key);
    }
  }, everyMs);
  timer.unref?.();
  return timer;
}

/**
 * IP do cliente. Atrás de um proxy TLS confiável usamos X-Forwarded-For;
 * fora dele o cabeçalho é ignorado, senão qualquer um forja o próprio IP
 * e escapa do limite.
 */
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export const LIMITS = {
  'POST /api/auth/nonce':  { max: 20, windowMs: 60_000 },
  'POST /api/auth/verify': { max: 20, windowMs: 60_000 },
  'POST /api/agents':      { max: 5,  windowMs: 3600_000 },   // 5 agentes por hora por IP
  default:                 { max: 240, windowMs: 60_000 },
};

export const resetAll = () => buckets.clear();
