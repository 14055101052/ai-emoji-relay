import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const MAX_BODY = 16 * 1024 * 1024;
const MAX_PNG = 12 * 1024 * 1024;

function json(res, status, body, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Strict-Transport-Security': 'max-age=31536000',
    ...extra
  });
  res.end(JSON.stringify(body));
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
}

function bearer(req) {
  const prefix = 'Bearer ';
  const header = req.headers.authorization ?? '';
  return header.startsWith(prefix) ? header.slice(prefix.length) : '';
}

function safeStaticBearer(req, secret) {
  if (!secret) return false;
  const candidate = bearer(req);
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorizedImport(req, secret, state) {
  if (safeStaticBearer(req, secret)) return true;
  const token = bearer(req);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
  const now = Math.floor(Date.now() / 1000);
  return !!state?.verify(token, now);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createImportedEmojiLibrary({ publicBaseUrl, storageDir, importSecret, state } = {}) {
  const base = new URL(publicBaseUrl);
  const dir = storageDir;
  const indexPath = join(dir, 'index.json');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let items = [];
  if (existsSync(indexPath)) {
    try { items = JSON.parse(readFileSync(indexPath, 'utf8')); } catch { items = []; }
  }

  const persist = () => writeFileSync(indexPath, JSON.stringify(items), { mode: 0o600 });
  const imagePath = id => join(dir, `${id}.png`);

  async function importEmoji(req, res) {
    cors(res);
    if (!authorizedImport(req, importSecret, state)) return json(res, 401, { success: false, code: 'IMPORT_AUTH_REQUIRED', error: 'Valid import authorization is required.' });
    try {
      const body = await readJson(req);
      const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
      const createdAt = typeof body?.createdAt === 'string' && !Number.isNaN(Date.parse(body.createdAt)) ? body.createdAt : new Date().toISOString();
      const image = typeof body?.image === 'string' ? body.image : '';
      if (!prompt || prompt.length > 500) return json(res, 400, { success: false, code: 'INVALID_PROMPT', error: 'Prompt must be 1-500 characters.' });
      const match = /^data:image\/png;base64,([A-Za-z0-9+/=\r\n]+)$/u.exec(image);
      if (!match) return json(res, 400, { success: false, code: 'PNG_REQUIRED', error: 'image must be a PNG data URL.' });
      const source = Buffer.from(match[1].replace(/[\r\n]/gu, ''), 'base64');
      if (!source.length || source.length > MAX_PNG) return json(res, 413, { success: false, code: 'IMAGE_TOO_LARGE', error: 'PNG is too large.' });
      const metadata = await sharp(source).metadata();
      if (metadata.format !== 'png' || !metadata.width || !metadata.height || metadata.width * metadata.height > 9_000_000) {
        return json(res, 400, { success: false, code: 'INVALID_PNG', error: 'Invalid PNG image.' });
      }
      const png = await sharp(source)
        .ensureAlpha()
        .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toBuffer();
      const id = randomBytes(24).toString('base64url');
      writeFileSync(imagePath(id), png, { mode: 0o600 });
      const item = {
        id,
        name: prompt.slice(0, 120),
        prompt,
        createdAt,
        imageUrl: `${base.origin}${base.pathname.replace(/\/$/u, '')}/api/emoji/library/image/${id}.png`,
        mimeType: 'image/png'
      };
      items = [item, ...items].slice(0, 500);
      persist();
      process.stdout.write('[emoji-relay] imported_emoji_status=201\n');
      return json(res, 201, { success: true, emoji: item });
    } catch (error) {
      const code = error?.message === 'TOO_LARGE' ? 'REQUEST_TOO_LARGE' : 'IMPORT_FAILED';
      return json(res, code === 'REQUEST_TOO_LARGE' ? 413 : 400, { success: false, code, error: 'Emoji import could not be completed.' });
    }
  }

  function listEmojis(req, res) {
    const token = bearer(req);
    const now = Math.floor(Date.now() / 1000);
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token) || !state?.verify(token, now)) return json(res, 401, { success: false, code: 'SESSION_REQUIRED', error: 'Obtain a new short-lived session.' });
    return json(res, 200, { success: true, emojis: items });
  }

  function serveImage(req, res, id) {
    const file = imagePath(id);
    if (!existsSync(file)) return json(res, 404, { success: false, code: 'IMAGE_NOT_FOUND', error: 'Emoji image not found.' });
    const png = readFileSync(file);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': String(png.length),
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Strict-Transport-Security': 'max-age=31536000'
    });
    if (req.method === 'HEAD') res.end(); else res.end(png);
  }

  function handle(req, res) {
    let pathname;
    try { pathname = new URL(req.url ?? '/', 'https://relay.invalid').pathname; } catch { return false; }
    if (pathname === '/api/import-emoji' && req.method === 'OPTIONS') {
      cors(res); res.writeHead(204); res.end(); return true;
    }
    if (pathname === '/api/import-emoji' && req.method === 'POST') {
      importEmoji(req, res).catch(() => json(res, 500, { success: false, code: 'IMPORT_FAILED', error: 'Emoji import could not be completed.' }));
      return true;
    }
    if (pathname === '/api/emojis' && req.method === 'GET') { listEmojis(req, res); return true; }
    const image = /^\/api\/emoji\/library\/image\/([A-Za-z0-9_-]{32})\.png$/u.exec(pathname);
    if (image && ['GET', 'HEAD'].includes(req.method ?? '')) { serveImage(req, res, image[1]); return true; }
    return false;
  }

  return { handle, count: () => items.length };
}
