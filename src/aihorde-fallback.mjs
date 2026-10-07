import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

const HORDE_BASE = 'https://aihorde.net/api/v2';
const IMAGE_TTL_SECONDS = 3600;
const MAX_GENERATED_BYTES = 12 * 1024 * 1024;
const POLL_INTERVAL_MS = 2500;
const MAX_WAIT_MS = 120000;

function enhancePrompt(prompt) {
  return `premium mobile emoji sticker of ${prompt}, soft 3D render, cute rounded proportions, polished materials, expressive details, centered single subject, full subject visible, clean silhouette, studio lighting, pure white background, no scenery, no text, no border, no frame, no watermark###busy background, scenery, text, letters, watermark, frame, border, multiple subjects`;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('HORDE_ABORTED'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('HORDE_ABORTED')); }, { once: true });
  });
}

async function jsonRequest(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, { redirect: 'error', ...init });
  let data = null;
  try { data = await response.json(); } catch { /* handled below */ }
  if (!response.ok) {
    const safeCode = typeof data?.rc === 'string' ? data.rc.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 40) : '';
    throw new Error(`HORDE_${response.status}${safeCode ? `_${safeCode}` : ''}`);
  }
  return data;
}

function backgroundReference(data, width, height) {
  const points = [];
  const size = Math.max(2, Math.min(12, Math.floor(Math.min(width, height) / 32)));
  const add = (x, y) => {
    const i = (y * width + x) * 4;
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
  const [br, bg, bb] = backgroundReference(data, width, height);
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

async function downloadGeneration(fetchImpl, generation, signal) {
  const raw = generation?.img ?? generation?.image;
  if (typeof raw !== 'string' || raw.length < 20) throw new Error('HORDE_INVALID_IMAGE');
  if (/^https:\/\//u.test(raw)) {
    const response = await fetchImpl(raw, { method: 'GET', redirect: 'follow', signal });
    if (!response.ok) throw new Error(`HORDE_IMAGE_${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_GENERATED_BYTES) throw new Error('HORDE_INVALID_IMAGE');
    return bytes;
  }
  const bytes = Buffer.from(raw, 'base64');
  if (!bytes.length || bytes.length > MAX_GENERATED_BYTES) throw new Error('HORDE_INVALID_IMAGE');
  return bytes;
}

export function createAIHordeFallback({ publicBaseUrl, apiKey = process.env.AIHORDE_API_KEY ?? '0000000000', fetchImpl = globalThis.fetch } = {}) {
  let base;
  try { base = new URL(publicBaseUrl); } catch { return null; }
  if (base.protocol !== 'https:' || base.username || base.password || base.hash || base.search) return null;
  base.pathname = base.pathname.replace(/\/$/u, '');
  const token = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : '0000000000';
  const images = new Map();

  function prune() {
    const now = Date.now();
    for (const [id, item] of images) if (item.expiresAt <= now) images.delete(id);
  }

  async function generate(input, signal) {
    const submit = await jsonRequest(fetchImpl, `${HORDE_BASE}/generate/async`, {
      method: 'POST', signal,
      headers: {
        'Content-Type': 'application/json',
        apikey: token,
        'Client-Agent': 'AIEmojiKeyboard:1.0:github.com/14055101052/ai-emoji-relay'
      },
      body: JSON.stringify({
        prompt: enhancePrompt(input.prompt),
        params: {
          n: 1,
          width: 1024,
          height: 1024,
          steps: 8,
          cfg_scale: 2,
          sampler_name: 'k_dpmpp_sde',
          karras: true
        },
        nsfw: false,
        censor_nsfw: true,
        shared: false,
        replacement_filter: true,
        r2: true,
        allow_downgrade: true
      })
    });
    const requestId = submit?.id;
    if (typeof requestId !== 'string' || !/^[0-9a-f-]{20,64}$/iu.test(requestId)) throw new Error('HORDE_INVALID_JOB');

    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      const check = await jsonRequest(fetchImpl, `${HORDE_BASE}/generate/check/${encodeURIComponent(requestId)}`, { method: 'GET', signal });
      if (check?.faulted) throw new Error('HORDE_FAULTED');
      if (check?.done === true) break;
      await sleep(POLL_INTERVAL_MS, signal);
    }
    if (Date.now() >= deadline) throw new Error('HORDE_TIMEOUT');

    const status = await jsonRequest(fetchImpl, `${HORDE_BASE}/generate/status/${encodeURIComponent(requestId)}`, { method: 'GET', signal });
    const generation = Array.isArray(status?.generations) ? status.generations[0] : null;
    if (!generation) throw new Error('HORDE_NO_GENERATION');
    const source = await downloadGeneration(fetchImpl, generation, signal);
    const png = await removeEdgeBackground(source);
    const id = randomBytes(24).toString('base64url');
    prune();
    images.set(id, { png, expiresAt: Date.now() + IMAGE_TTL_SECONDS * 1000 });
    return {
      success: true,
      id: `horde-${id}`,
      name: input.prompt.slice(0, 120),
      imageUrl: `${base.origin}${base.pathname}/api/emoji/image/${id}.png`,
      mimeType: 'image/png',
      expiresInSeconds: IMAGE_TTL_SECONDS
    };
  }

  async function wrapFetch(url, init = {}) {
    const primary = await fetchImpl(url, init);
    if (![402, 429, 500, 502, 503, 504].includes(primary.status)) return primary;
    let input;
    try { input = JSON.parse(String(init.body ?? '')); } catch { return primary; }
    if (!input || typeof input.prompt !== 'string' || input.style !== 'Soft 3D') return primary;
    try {
      const fallback = await generate(input, init.signal);
      await primary.body?.cancel().catch(() => {});
      process.stdout.write('[emoji-relay] horde_status=200\n');
      return new Response(JSON.stringify(fallback), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    } catch (error) {
      const safe = String(error?.message ?? 'unknown').replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 80);
      process.stdout.write(`[emoji-relay] horde_error=${safe}\n`);
      return primary;
    }
  }

  function serveImage(req, res) {
    if (!['GET', 'HEAD'].includes(req.method ?? '')) return false;
    let pathname;
    try { pathname = new URL(req.url ?? '/', 'https://relay.invalid').pathname; } catch { return false; }
    if (!pathname.startsWith('/api/emoji/image/')) return false;
    const match = /^\/api\/emoji\/image\/(?:horde-)?([A-Za-z0-9_-]{32})(?:\.png)?\/?$/u.exec(pathname);
    if (!match) return false;
    prune();
    const item = images.get(match[1]);
    if (!item) {
      process.stdout.write('[emoji-relay] image_cache_miss\n');
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') res.end();
      else res.end(JSON.stringify({ success: false, code: 'IMAGE_EXPIRED', error: 'This generated image has expired.' }));
      return true;
    }
    process.stdout.write(`[emoji-relay] image_status=200 method=${req.method}\n`);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': String(item.png.length),
      'Cache-Control': 'private, max-age=3600, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Strict-Transport-Security': 'max-age=31536000'
    });
    if (req.method === 'HEAD') res.end(); else res.end(item.png);
    return true;
  }

  return { wrapFetch, serveImage };
}
