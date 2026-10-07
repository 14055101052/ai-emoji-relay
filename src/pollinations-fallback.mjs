import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

const IMAGE_TTL_SECONDS = 3600;
const MAX_GENERATED_BYTES = 12 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 35000;
const PUBLIC_IMAGE_BASE = 'https://image.pollinations.ai/prompt/';

function enhancePrompt(prompt) {
  return `premium mobile emoji sticker of ${prompt}, soft 3D render, cute rounded proportions, polished materials, expressive details, centered single subject, full subject visible, clean silhouette, studio lighting, pure white background, no scenery, no text, no border, no frame, no watermark`;
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

async function removeEdgeBackgroundAndNormalize(input) {
  const decoded = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = decoded.info;
  if (!width || !height || channels !== 4 || width * height > 4_500_000) throw new Error('POLLINATIONS_INVALID_IMAGE');
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
  return sharp(data, { raw: { width, height, channels: 4 } })
    .resize(1024, 1024, { fit: 'contain' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export function createPollinationsFallback({ publicBaseUrl, apiKey = process.env.POLLINATIONS_API_KEY ?? '', fetchImpl = globalThis.fetch } = {}) {
  let base;
  try { base = new URL(publicBaseUrl); } catch { return null; }
  if (base.protocol !== 'https:' || base.username || base.password || base.hash || base.search) return null;
  base.pathname = base.pathname.replace(/\/$/u, '');
  const images = new Map();

  function prune() {
    const now = Date.now();
    for (const [id, item] of images) if (item.expiresAt <= now) images.delete(id);
  }

  async function generate(input, parentSignal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    parentSignal?.addEventListener('abort', onAbort, { once: true });
    try {
      const prompt = encodeURIComponent(enhancePrompt(input.prompt));
      const url = new URL(`${PUBLIC_IMAGE_BASE}${prompt}`);
      url.searchParams.set('model', 'flux');
      url.searchParams.set('width', '768');
      url.searchParams.set('height', '768');
      url.searchParams.set('nologo', 'true');
      url.searchParams.set('enhance', 'false');
      url.searchParams.set('safe', 'true');
      url.searchParams.set('private', 'true');
      const headers = { 'User-Agent': 'AIEmojiKeyboard-Relay/1.0' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const response = await fetchImpl(url, { method: 'GET', headers, redirect: 'follow', signal: controller.signal });
      if (!response.ok) throw new Error(`POLLINATIONS_${response.status}`);
      const type = (response.headers.get('content-type') ?? '').toLowerCase();
      if (!type.startsWith('image/')) throw new Error('POLLINATIONS_INVALID_CONTENT');
      const source = Buffer.from(await response.arrayBuffer());
      if (!source.length || source.length > MAX_GENERATED_BYTES) throw new Error('POLLINATIONS_INVALID_IMAGE');
      const png = await removeEdgeBackgroundAndNormalize(source);
      const id = randomBytes(24).toString('base64url');
      prune();
      images.set(id, { png, expiresAt: Date.now() + IMAGE_TTL_SECONDS * 1000 });
      return {
        success: true,
        id: `pollinations-${id}`,
        name: input.prompt.slice(0, 120),
        imageUrl: `${base.origin}${base.pathname}/api/emoji/image/${id}.png`,
        mimeType: 'image/png',
        expiresInSeconds: IMAGE_TTL_SECONDS
      };
    } catch (error) {
      if (controller.signal.aborted && !parentSignal?.aborted) throw new Error('POLLINATIONS_TIMEOUT');
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
    }
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
      process.stdout.write('[emoji-relay] pollinations_status=200\n');
      return new Response(JSON.stringify(fallback), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    } catch (error) {
      const safe = String(error?.message ?? 'unknown').replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 80);
      process.stdout.write(`[emoji-relay] pollinations_error=${safe}\n`);
      return primary;
    }
  }

  function serveImage(req, res) {
    if (!['GET', 'HEAD'].includes(req.method ?? '')) return false;
    let pathname;
    try { pathname = new URL(req.url ?? '/', 'https://relay.invalid').pathname; } catch { return false; }
    const match = /^\/api\/(?:public\/)?emoji\/(?:image\/)?(?:pollinations-)?([A-Za-z0-9_-]{32})(?:\.png)?\/?$/u.exec(pathname);
    if (!match) return false;
    prune();
    const item = images.get(match[1]);
    if (!item) {
      process.stdout.write('[emoji-relay] image_cache_miss\n');
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') res.end(); else res.end(JSON.stringify({ success: false, code: 'IMAGE_EXPIRED', error: 'This generated image has expired.' }));
      return true;
    }
    process.stdout.write(`[emoji-relay] image_status=200 method=${req.method}\n`);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(item.png.length), 'Cache-Control': 'private, max-age=3600, immutable', 'X-Content-Type-Options': 'nosniff', 'Strict-Transport-Security': 'max-age=31536000' });
    if (req.method === 'HEAD') res.end(); else res.end(item.png);
    return true;
  }

  return { wrapFetch, serveImage };
}
