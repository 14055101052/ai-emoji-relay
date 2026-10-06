import { randomBytes, createHash, createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isIP } from 'node:net';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export const LOVABLE_ENDPOINT = 'https://project--a55e5977-6867-4325-9a5e-5e9efbb3a82c.lovable.app/api/public/emoji/generate';
const MAX_BODY = 4096;
const MAX_RESPONSE = 65536;
const invalidControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const sha = value => createHash('sha256').update(value).digest('hex');
const seconds = () => Math.floor(Date.now() / 1000);

export class HttpFailure extends Error {
  constructor(status, code, message, retryAfter) { super(message); Object.assign(this, { status, code, retryAfter }); }
}

export class RelayState {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').run('ipPepper', randomBytes(32).toString('hex'));
    this.pepper = this.db.prepare('SELECT value FROM settings WHERE key=?').get('ipPepper').value;
  }
  ipKey(ip) { return createHmac('sha256', this.pepper).update(ip).digest('hex'); }
  prune(now) {
    this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
    this.db.prepare('DELETE FROM limits WHERE expires<=?').run(now);
  }
  consume(rules, now) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [scope, span, max] of rules) {
        const start = Math.floor(now / span) * span;
        const key = `${scope}:${start}`;
        const row = this.db.prepare('SELECT count FROM limits WHERE key=?').get(key);
        if (row && row.count >= max) throw new HttpFailure(429, 'RATE_LIMITED', 'Please wait before trying again.', start + span - now);
      }
      for (const [scope, span] of rules) {
        const start = Math.floor(now / span) * span;
        this.db.prepare('INSERT INTO limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(`${scope}:${start}`, start + span);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  issue(now, ttl) {
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO sessions(hash,expires) VALUES (?,?)').run(sha(token), now + ttl);
    return token;
  }
  verify(token, now) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
    const hash = sha(token);
    const row = this.db.prepare('SELECT expires FROM sessions WHERE hash=?').get(hash);
    return row && row.expires > now ? hash : null;
  }
  close() { this.db.close(); }
}

function reply(res, status, body, retryAfter) {
  if (res.destroyed) return;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (retryAfter) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfter))));
  res.writeHead(status); res.end(JSON.stringify(body));
}

async function body(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(req.headers['content-type'] ?? ''))
    throw new HttpFailure(415, 'JSON_REQUIRED', 'Use application/json.');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
    throw new HttpFailure(415, 'ENCODING_UNSUPPORTED', 'Compressed requests are not accepted.');
  const length = Number(req.headers['content-length']);
  if (length > MAX_BODY) throw new HttpFailure(413, 'REQUEST_TOO_LARGE', 'The request is too large.');
  const bytes = await new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { req.pause(); reject(new HttpFailure(413, 'REQUEST_TOO_LARGE', 'The request is too large.')); }
      else chunks.push(chunk);
    });
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', () => reject(new HttpFailure(400, 'INVALID_REQUEST', 'The request could not be read.')));
  });
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new HttpFailure(400, 'INVALID_JSON', 'Use valid UTF-8 JSON.'); }
  if (!data || Array.isArray(data) || typeof data !== 'object') throw new HttpFailure(400, 'INVALID_REQUEST', 'Use a JSON object.');
  return data;
}

function promptRequest(data) {
  if (Object.keys(data).sort().join(',') !== 'prompt,style' || typeof data.prompt !== 'string' || data.style !== 'Soft 3D' ||
      !data.prompt.trim() || data.prompt.length > 500 || invalidControls.test(data.prompt))
    throw new HttpFailure(400, 'INVALID_PROMPT', 'Provide a prompt of 1–500 characters and style Soft 3D, with no other fields.');
  return { prompt: data.prompt.trim(), style: data.style };
}

async function smallJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE || !response.body) throw new Error('INVALID_UPSTREAM');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > MAX_RESPONSE) throw new Error('INVALID_UPSTREAM');
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await reader.cancel().catch(() => {}); }
}

function safeResponse(data, apiKey) {
  if (!data || data.success !== true || typeof data.id !== 'string' || !data.id.trim() || data.id.length > 256 ||
      typeof data.name !== 'string' || !data.name.trim() || data.name.length > 200 || invalidControls.test(data.id + data.name) ||
      data.mimeType !== 'image/png' || !Number.isInteger(data.expiresInSeconds) || data.expiresInSeconds <= 0 || data.expiresInSeconds > 604800 ||
      typeof data.imageUrl !== 'string' || data.imageUrl.length > 4096) throw new Error('INVALID_UPSTREAM');
  const image = new URL(data.imageUrl);
  if (image.protocol !== 'https:' || image.username || image.password || image.hash || image.hostname === 'localhost' || isIP(image.hostname.replace(/^\[|\]$/g, '')))
    throw new Error('INVALID_UPSTREAM');
  const safe = { success: true, id: data.id, name: data.name, imageUrl: data.imageUrl, mimeType: 'image/png', expiresInSeconds: data.expiresInSeconds };
  const serialized = JSON.stringify(safe);
  if (serialized.includes(apiKey) || serialized.includes(encodeURIComponent(apiKey))) throw new Error('CREDENTIAL_IN_UPSTREAM');
  return safe;
}

const normalizeIP = ip => ip?.startsWith('::ffff:') ? ip.slice(7) : ip;
function clientIP(req, config) {
  const peer = normalizeIP(req.socket.remoteAddress);
  if (!req.socket.encrypted) {
    if (config.tlsTermination !== 'reverse-proxy' || !config.trustedProxyIPs.includes(peer) || req.headers['x-forwarded-proto'] !== 'https')
      throw new HttpFailure(403, 'HTTPS_REQUIRED', 'HTTPS is required.');
    const ip = req.headers['x-forwarded-for'];
    if (typeof ip !== 'string' || !isIP(ip)) throw new HttpFailure(400, 'INVALID_PROXY_HEADERS', 'The proxy must forward a single verified client IP.');
    return normalizeIP(ip);
  }
  return peer; // Ignore forwarded IP headers on direct HTTPS connections.
}

/** Production always uses the fixed Lovable endpoint. fetchImpl/clock are only seams for component tests. */
export function createRelay({ apiKey = '', state = new RelayState(), fetchImpl = globalThis.fetch, clock = seconds,
  sessionTTL = 3600, timeoutMs = 150000, maxConcurrent = 2, generationDailyGlobal = 50, generationDailyIP = 5,
  tlsTermination = 'direct', trustedProxyIPs = ['127.0.0.1', '::1'] } = {}) {
  let active = 0; let pruneAt = 0;
  const config = { tlsTermination, trustedProxyIPs };
  return async function handle(req, res) {
    let timeout; let charged = false; let abort; let disconnect;
    try {
      const ip = clientIP(req, config);
      if (req.url === '/healthz' && req.method === 'GET') { reply(res, apiKey ? 200 : 503, { ready: !!apiKey }); return; }
      if (req.method !== 'POST' || !['/api/auth/session', '/api/emoji/generate'].includes(req.url)) {
        throw new HttpFailure(404, 'NOT_FOUND', 'Endpoint not found.');
      }
      const now = clock(); const ipHash = state.ipKey(ip);
      if (now >= pruneAt) { state.prune(now); pruneAt = now + 60; }
      // Applies before body parsing/auth, including malicious and unauthenticated requests.
      state.consume([[`requests:${ipHash}`, 60, 30], ['requests:global', 60, 300]], now);
      if (!apiKey) throw new HttpFailure(503, 'BACKEND_NOT_CONFIGURED', 'The generation service is not configured.');
      if (req.url === '/api/auth/session') {
        const data = await body(req);
        if (Object.keys(data).length !== 0) throw new HttpFailure(400, 'INVALID_REQUEST', 'Session issuance accepts an empty JSON object.');
        state.consume([[`issue:${ipHash}`, 3600, 6], [`issue-day:${ipHash}`, 86400, 12], ['issue:global', 3600, 100]], now);
        state.prune(now);
        reply(res, 200, { token: state.issue(now, sessionTTL), expiresInSeconds: sessionTTL }); return;
      }
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(req.headers.authorization ?? '');
      const sessionHash = match && state.verify(match[1], now);
      if (!sessionHash) throw new HttpFailure(401, 'SESSION_REQUIRED', 'Obtain a new short-lived session.');
      const input = promptRequest(await body(req));
      if (active >= maxConcurrent) throw new HttpFailure(429, 'BUSY', 'The generator is busy. Please retry shortly.', 10);
      state.consume([[`generate:${sessionHash}`, 60, 2], [`generate-hour:${sessionHash}`, 3600, 5],
        [`generate-day:${ipHash}`, 86400, generationDailyIP], ['generate-day:global', 86400, generationDailyGlobal]], now);
      active++; charged = true;
      abort = new AbortController();
      timeout = setTimeout(() => abort.abort(), timeoutMs);
      disconnect = () => { if (!res.writableEnded) abort.abort(); };
      res.once('close', disconnect);
      const upstream = await fetchImpl(LOVABLE_ENDPOINT, { method: 'POST', redirect: 'error', signal: abort.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`,
          'User-Agent': 'AIEmojiKeyboard-Relay/1.0' }, body: JSON.stringify(input) });
      if (upstream.status !== 200) {
        await upstream.body?.cancel().catch(() => {});
        if (upstream.status === 400 || upstream.status === 422) throw new HttpFailure(400, 'PROMPT_REJECTED', 'Lovable did not accept this prompt.');
        if (upstream.status === 429) {
          const retry = upstream.headers.get('retry-after');
          const numeric = /^\d+$/u.test(retry ?? '') ? Number(retry) : Math.ceil((Date.parse(retry) - Date.now()) / 1000);
          throw new HttpFailure(429, 'UPSTREAM_RATE_LIMIT', 'Lovable is rate limited. Please retry later.', Number.isFinite(numeric) ? Math.min(3600, Math.max(1, numeric)) : 30);
        }
        if (upstream.status === 401 || upstream.status === 403) throw new HttpFailure(503, 'BACKEND_AUTH_UNAVAILABLE', 'The generation service needs administrator attention.');
        throw new HttpFailure(upstream.status >= 500 && upstream.status <= 599 ? upstream.status : 502, 'UPSTREAM_UNAVAILABLE', 'Lovable is temporarily unavailable.');
      }
      reply(res, 200, safeResponse(await smallJson(upstream), apiKey));
    } catch (error) {
      if (error instanceof HttpFailure) {
        if (error.status === 413) { res.setHeader('Connection', 'close'); res.once('finish', () => req.destroy()); }
        reply(res, error.status, { success: false, code: error.code, error: error.message }, error.retryAfter);
      } else {
        reply(res, abort?.signal.aborted ? 504 : 502, { success: false, code: 'UPSTREAM_UNAVAILABLE', error: 'The generation service could not complete the request.' });
      }
      // Intentionally no request, prompt, token, upstream payload, or exception logging.
    } finally {
      clearTimeout(timeout);
      if (disconnect) res.off('close', disconnect);
      if (charged) active--;
    }
  };
                                                                                  }
