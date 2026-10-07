import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

const MODELS = [
  '@cf/black-forest-labs/flux-2-klein-9b',
  '@cf/black-forest-labs/flux-2-klein-4b'
];
const IMAGE_TTL_SECONDS = 3600;
const MAX_GENERATED_BYTES = 12 * 1024 * 1024;

const validAccountId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(value);
const validToken = value => typeof value === 'string' && value.length >= 20 && value.length <= 512 && !/[\r\n]/u.test(value);

function enhancePrompt(prompt) {
  return `Create one premium mobile emoji/sticker of ${prompt}. Soft 3D rendered style, cute rounded proportions, polished materials, expressive details, centered single subject, full subject visible, studio-quality lighting. Put the subject on a perfectly flat pure white (#FFFFFF) background with no scenery, no text, no border, no frame, no watermark, and no cast shadow reaching the image edges. Keep strong clean separation between the subject and the white background.`;
}

function backgroundReference(data, width, height, channels) {
  const points = [];
  const size = Math.max(2, Math.min(12, Math.floor(Math.min(width, height) / 32)));
  const add = (x, y) => {
    const i = (y * width + x) * channels;
    points.push([data[i], data[i + 1], data[i + 2]]);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      add(x, y); add(width - 1 - x, y); add(x, height - 1 - y); add(width - 1 - x, height - 1 - y);
    }
  }
  points.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
  const bright = points.slice(Math.floor(points.length * 0.65));
  const sum = bright.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0]);
  return sum.map(v => Math.round(v / Math.max(1, bright.length)));
}

async function removeEdgeBackground(input) {
  const decoded = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = decoded.info;
  if (!width || !height || channels !== 4 || width * height > 4_500_000) throw new Error('INVALID_IMAGE');
  const data = decoded.data;
  const [br, bg, bb] = backgroundReference(data, width, height, channels);
  const pixels = width * height;
  const seen = new Uint8Array(pixels);
  const queue = new Int32Array(pixels);
  let head = 0; let tail = 0;
  const distance = pixel => {
    const i = pixel * 4;
    return Math.max(Math.abs(data[i] - br), Math.abs(data[i + 1] - bg), Math.abs(data[i + 2] - bb));
  };
  const enqueue = pixel => {
    if (pixel < 0 || pixel >= pixels || seen[pixel] || distance(pixel) > 82) return;
    seen[pixel] = 1; queue[tail++] = pixel;
  };
  for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
  while (head < tail) {
    const p = queue[head++];
    const x = p % width;
    const d = distance(p);
    const i = p * 4;
    const originalAlpha = data[i + 3];
    const alpha = d <= 24 ? 0 : Math.min(255, Math.round(((d - 24) / 58) * 255));
    data[i + 3] = Math.min(originalAlpha, alpha);
    if (x > 0) enqueue(p - 1);
    if (x + 1 < width) enqueue(p + 1);
    if (p >= width) enqueue(p - width);
    if (p + width < pixels) enqueue(p + width);
  }
  return sharp(data, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
}

async function cloudflareRequest(fetchImpl, accountId, token, model, prompt, signal) {
  const form = new FormData();
  form.append('prompt', enhancePrompt(prompt));
  form.append('width', '1024');
  form.append('height', '1024');

  const serialized = new Response(form);
  const contentType = serialized.headers.get('content-type');
  const body = await serialized.arrayBuffer();
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;
  const response = await fetchImpl(endpoint, {
    method: 'POST', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType }, body
  });
  if (!response.ok) {
    let safeCode = '';
    try {
      const errorBody = await response.json();
      const code = errorBody?.errors?.[0]?.code ?? errorBody?.code;
      if (Number.isInteger(code) || (typeof code === 'string' && /^[A-Za-z0-9_-]{1,40}$/u.test(code))) safeCode = `_${code}`;
    } catch { await response.body?.cancel().catch(() => {}); }
    throw new Error(`CLOUDFLARE_${response.status}${safeCode}`);
  }
  return response.json();
}

export function createCloudflareFallback({ accountId, token, publicBaseUrl, fetchImpl = globalThis.fetch } = {}) {
  if (!validAccountId(accountId) || !validToken(token)) return null;
  let base;
  try { base = new URL(publicBaseUrl); } catch { return null; }
  if (base.protocol !== 'https:' || base.username || base.password || base.hash || base.search) return null;
  base.pathname = base.pathname.replace(/\/$/u, '');
  const images = new Map();

  function prune() {
    const now = Date.now();
    for (const [id, item] of images) if (item.expiresAt <= now) images.delete(id);
  }

  async function generate(input, signal) {
    let payload; let lastError;
    for (const model of MODELS) {
      try {
        payload = await cloudflareRequest(fetchImpl, accountId, token, model, input.prompt, signal);
        break;
      } catch (error) {
        lastError = error;
        const message = String(error?.message ?? '');
        if (!/^CLOUDFLARE_5\d\d/u.test(message)) throw error;
      }
    }
    if (!payload) throw lastError ?? new Error('CLOUDFLARE_UNAVAILABLE');
    const encoded = payload?.result?.image ?? payload?.image;
    if (typeof encoded !== 'string' || encoded.length < 100 || encoded.length > MAX_GENERATED_BYTES * 1.5) throw new Error('INVALID_CLOUDFLARE_IMAGE');
    const source = Buffer.from(encoded, 'base64');
    if (!source.length || source.length > MAX_GENERATED_BYTES) throw new Error('INVALID_CLOUDFLARE_IMAGE');
    const png = await removeEdgeBackground(source);
    const id = randomBytes(24).toString('base64url');
    prune();
    images.set(id, { png, expiresAt: Date.now() + IMAGE_TTL_SECONDS * 1000 });
    return {
      success: true,
      id: `cf-${id}`,
      name: input.prompt.slice(0, 120),
      imageUrl: `${base.origin}${base.pathname}/api/emoji/image/${id}`,
      mimeType: 'image/png',
      expiresInSeconds: IMAGE_TTL_SECONDS
    };
  }

  async function wrapFetch(url, init = {}) {
    const primary = await fetchImpl(url, init);
    if (![429, 500, 502, 503, 504].includes(primary.status)) return primary;
    let input;
    try { input = JSON.parse(String(init.body ?? '')); } catch { return primary; }
    if (!input || typeof input.prompt !== 'string' || input.style !== 'Soft 3D') return primary;
    try {
      const fallback = await generate(input, init.signal);
      await primary.body?.cancel().catch(() => {});
      process.stdout.write('[emoji-relay] fallback_status=200\n');
      return new Response(JSON.stringify(fallback), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    } catch (error) {
      process.stdout.write(`[emoji-relay] fallback_error=${String(error?.message ?? 'unknown').replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 80)}\n`);
      return primary;
    }
  }

  function serveImage(req, res) {
    if (!['GET', 'HEAD'].includes(req.method ?? '')) return false;
    let pathname;
    try { pathname = new URL(req.url ?? '/', 'https://relay.invalid').pathname; } catch { return false; }
    const match = /^\/api\/emoji\/image\/([A-Za-z0-9_-]{32})\/?$/u.exec(pathname);
    if (!match) return false;
    prune();
    const item = images.get(match[1]);
    if (!item) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') res.end();
      else res.end(JSON.stringify({ success: false, code: 'IMAGE_EXPIRED', error: 'This generated image has expired.' }));
      return true;
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': String(item.png.length),
      'Cache-Control': 'private, max-age=3600, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Strict-Transport-Security': 'max-age=31536000'
    });
    if (req.method === 'HEAD') res.end();
    else res.end(item.png);
    return true;
  }

  return { wrapFetch, serveImage };
}
