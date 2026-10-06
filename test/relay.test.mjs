import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRelay, RelayState, LOVABLE_ENDPOINT } from '../src/relay.mjs';

// Synthetic server credential and controlled upstream responses: no live generation in tests.
const TEST_KEY = 'synthetic-server-credential-for-relay-tests';
const result = { success: true, id: 'fixture-id', name: 'BMW M4', imageUrl: 'https://storage.example.com/emoji.png?signature=temporary', mimeType: 'image/png', expiresInSeconds: 604800 };
let directory, key, cert;
before(() => {
  directory = mkdtempSync(join(tmpdir(), 'emoji-relay-test-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  key = readFileSync(join(directory, 'key.pem')); cert = readFileSync(join(directory, 'cert.pem'));
});
after(() => rmSync(directory, { recursive: true, force: true }));
async function harness(t, options = {}) {
  const state = options.state ?? new RelayState(); const calls = [];
  const fetchImpl = options.fetchImpl ?? (async (url, request) => { calls.push({ url, request }); return Response.json({ ...result, unsafeExtra: TEST_KEY }); });
  const server = https.createServer({ key, cert }, createRelay({ apiKey: TEST_KEY, state, fetchImpl, ...options }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new https.Agent({ ca: cert });
  t.after(async () => { agent.destroy(); await new Promise(resolve => server.close(resolve)); state.close(); });
  async function request(path, { payload = {}, token, method = 'POST', headers = {}, raw } = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: 'localhost', port: server.address().port, path, method, agent,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } }, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
          const raw = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(raw), raw });
        });
      }); req.on('error', reject); req.end(method === 'GET' ? undefined : raw ?? JSON.stringify(payload));
    });
  }
  async function session() { const response = await request('/api/auth/session'); assert.equal(response.status, 200); return response.body.token; }
  const generate = token => request('/api/emoji/generate', { token, payload: { prompt: 'BMW M4 in Marina Bay Blue', style: 'Soft 3D' } });
  return { state, calls, request, session, generate };
}

test('HTTPS sessions invoke only fixed Lovable URL with server auth and safe response projection', async t => {
  const h = await harness(t); const token = await h.session(); assert.match(token, /^[A-Za-z0-9_-]{43}$/u);
  const response = await h.generate(token); assert.equal(response.status, 200); assert.deepEqual(response.body, result);
  assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(h.calls.length, 1);
  const { url, request } = h.calls[0]; assert.equal(url, LOVABLE_ENDPOINT);
  assert.equal(request.headers.Authorization, `Bearer ${TEST_KEY}`); assert.notEqual(request.headers.Authorization, `Bearer ${token}`);
  assert.equal(request.redirect, 'error'); assert.deepEqual(JSON.parse(request.body), { prompt: 'BMW M4 in Marina Bay Blue', style: 'Soft 3D' });
  assert.equal(response.raw.includes(TEST_KEY), false);
  const row = h.state.db.prepare('SELECT hash,expires FROM sessions').get(); assert.notEqual(row.hash, token); assert.equal(row.hash.length, 64);
});
test('missing backend credential fails closed with no token or upstream call', async t => {
  const h = await harness(t, { apiKey: '' });
  for (const path of ['/healthz', '/api/auth/session']) assert.equal((await h.request(path, { method: path === '/healthz' ? 'GET' : 'POST' })).status, 503);
  assert.equal((await h.generate('a'.repeat(43))).status, 503); assert.equal(h.calls.length, 0);
});
test('expired, malformed and unknown sessions are rejected before Lovable', async t => {
  let now = 100000; const h = await harness(t, { clock: () => now }); const token = await h.session(); now += 3601;
  for (const invalid of [token, 'invalid', 'x'.repeat(43), undefined]) assert.equal((await h.generate(invalid)).status, 401);
  assert.equal(h.calls.length, 0);
});
test('invalid prompts, styles, unknown fields, arrays and JSON never reach Lovable', async t => {
  const h = await harness(t); const token = await h.session();
  for (const payload of [{ prompt: '', style: 'Soft 3D' }, { prompt: 'a'.repeat(501), style: 'Soft 3D' }, { prompt: 'car', style: 'Other' }, { prompt: 'car', style: 'Soft 3D', text: 'forbidden' }, { prompt: 1, style: 'Soft 3D' }, { prompt: 'bad\u0000', style: 'Soft 3D' }, [], null])
    assert.equal((await h.request('/api/emoji/generate', { token, payload })).status, 400);
  assert.equal((await h.request('/api/emoji/generate', { token, raw: '{invalid' })).status, 400); assert.equal(h.calls.length, 0);
});
test('large bodies, wrong content types and extra session fields are rejected', async t => {
  const h = await harness(t); const token = await h.session();
  assert.equal((await h.request('/api/emoji/generate', { token, raw: 'x'.repeat(4097) })).status, 413);
  assert.equal((await h.request('/api/auth/session', { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await h.request('/api/auth/session', { payload: { key: TEST_KEY } })).status, 400); assert.equal(h.calls.length, 0);
});
test('400/429/5xx preserve useful status while upstream auth errors become 503 and secrets are suppressed', async t => {
  for (const status of [400, 422, 429, 500, 503, 401, 403]) {
    const h = await harness(t, { fetchImpl: async () => new Response(TEST_KEY, { status, headers: { 'Retry-After': '40' } }) });
    const response = await h.generate(await h.session());
    assert.equal(response.status, status === 422 ? 400 : status === 401 || status === 403 ? 503 : status);
    if (status === 429) assert.equal(response.headers['retry-after'], '40'); assert.equal(response.raw.includes(TEST_KEY), false);
  }
});
test('unsafe or credential-containing upstream success becomes generic 502', async t => {
  for (const data of [{ ...result, imageUrl: 'http://storage.example.com/a.png' }, { ...result, imageUrl: 'https://localhost/a.png' }, { ...result, mimeType: 'image/svg+xml' }, { ...result, expiresInSeconds: 0 }, { ...result, name: TEST_KEY }]) {
    const h = await harness(t, { fetchImpl: async () => Response.json(data) }); const r = await h.generate(await h.session());
    assert.equal(r.status, 502); assert.equal(r.raw.includes(TEST_KEY), false);
  }
});
test('timeout yields 504 and never exposes exception contents', async t => {
  const h = await harness(t, { timeoutMs: 10, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(TEST_KEY)))) });
  const r = await h.generate(await h.session()); assert.equal(r.status, 504); assert.equal(r.raw.includes(TEST_KEY), false);
});
test('token rotation and forged forwarded IP cannot bypass IP daily quota on HTTPS', async t => {
  const h = await harness(t, { generationDailyIP: 1 }); assert.equal((await h.generate(await h.session())).status, 200);
  const r = await h.request('/api/emoji/generate', { token: await h.session(), headers: { 'X-Forwarded-For': '8.8.8.8' }, payload: { prompt: 'car', style: 'Soft 3D' } });
  assert.equal(r.status, 429); assert.equal(h.calls.length, 1);
});
test('global daily cap bounds upstream cost', async t => {
  const h = await harness(t, { generationDailyGlobal: 1 }); const token = await h.session();
  assert.equal((await h.generate(token)).status, 200); assert.equal((await h.generate(token)).status, 429); assert.equal(h.calls.length, 1);
});
test('new session issuance is rate limited', async t => {
  const h = await harness(t); for (let i = 0; i < 6; i++) await h.session(); const r = await h.request('/api/auth/session');
  assert.equal(r.status, 429); assert.ok(Number(r.headers['retry-after']) > 0);
});
test('hashed sessions and budget counters persist across SQLite reopen', () => {
  const file = join(directory, 'persistent.sqlite'); let state = new RelayState(file);
  const token = state.issue(1000, 3600); state.consume([['budget', 86400, 1]], 1000); state.close();
  state = new RelayState(file); assert.ok(state.verify(token, 1001)); assert.throws(() => state.consume([['budget', 86400, 1]], 1001), e => e.status === 429);
  assert.equal(state.verify(token, 4600), null); state.close();
});
test('concurrency limit prevents another upstream call', async t => {
  let release, entered; const started = new Promise(r => { entered = r; }); const held = new Promise(r => { release = r; });
  const h = await harness(t, { maxConcurrent: 1, fetchImpl: async () => { entered(); await held; return Response.json(result); } });
  const token = await h.session(); const first = h.generate(token); await started; assert.equal((await h.generate(token)).status, 429);
  release(); assert.equal((await first).status, 200);
});
test('HTTP cannot impersonate trusted TLS termination using forwarded headers', async t => {
  const state = new RelayState(); const server = http.createServer(createRelay({ apiKey: TEST_KEY, state }));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(async () => { await new Promise(r => server.close(r)); state.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '8.8.8.8' }, body: '{}' });
  assert.equal(response.status, 403);
});

test('trusted loopback TLS proxy requires verified single-IP headers', async t => {
  const state = new RelayState(); const server = http.createServer(createRelay({ apiKey: TEST_KEY, state, tlsTermination: 'reverse-proxy' }));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(async () => { await new Promise(r => server.close(r)); state.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/auth/session`;
  const request = headers => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
  assert.equal((await request({})).status, 403);
  assert.equal((await request({ 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '8.8.8.8, 1.1.1.1' })).status, 400);
  const valid = await request({ 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '8.8.8.8' });
  assert.equal(valid.status, 200); const session = await valid.json(); assert.equal(session.expiresInSeconds, 3600); assert.match(session.token, /^[A-Za-z0-9_-]{43}$/u);
});
test('oversized upstream success and redirects cannot disclose credentials', async t => {
  for (const response of [new Response('x'.repeat(65537)), new Response(TEST_KEY, { status: 302, headers: { Location: 'https://other.example.com' } })]) {
    const h = await harness(t, { fetchImpl: async () => response }); const r = await h.generate(await h.session());
    assert.equal(r.status, 502); assert.equal(r.raw.includes(TEST_KEY), false);
  }
});
