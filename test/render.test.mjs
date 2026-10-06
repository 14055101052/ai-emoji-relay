import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay, RelayState } from '../src/relay.mjs';
import { runtimeConfig } from '../src/runtime-config.mjs';

const TEST_URL = 'https://project--a55e5977-6867-4325-9a5e-5e9efbb3a82c-dev.lovable.app/api/public/emoji/generate';
const TEST_KEY = 'synthetic-server-credential-for-render-tests';
const renderEnv = { LOVABLE_GENERATE_URL: TEST_URL, RENDER: 'true', TLS_TERMINATION: 'render', PORT: '10000', NODE_ENV: 'development', RELAY_STORAGE_MODE: 'ephemeral-development' };
const generated = { success: true, id: 'fixture', name: 'BMW M4', imageUrl: 'https://storage.example.com/fixture.png', mimeType: 'image/png', expiresInSeconds: 604800 };
async function harness(t, options = {}) {
  const state = new RelayState(); const calls = [];
  const server = http.createServer(createRelay({ apiKey: TEST_KEY, generateUrl: TEST_URL, state, tlsTermination: 'render',
    fetchImpl: async (url, request) => { calls.push({ url, request }); return Response.json({ ...generated, discarded: TEST_KEY }); }, ...options }));
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); state.close(); });
  async function request(path, { method = 'POST', headers = {}, token, payload = {} } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const session = async (headers = {}) => request('/api/auth/session', { headers });
  const generate = (token, headers = {}) => request('/api/emoji/generate', { token, headers, payload: { prompt: 'BMW M4 in Marina Bay Blue', style: 'Soft 3D' } });
  return { state, calls, request, session, generate };
}

test('Render config binds 0.0.0.0 and supplied PORT without TLS files or Caddy', () => {
  const config = runtimeConfig({ ...renderEnv, PORT: '12345' });
  assert.equal(config.host, '0.0.0.0'); assert.equal(config.port, 12345); assert.equal(config.mode, 'render'); assert.equal(config.ephemeral, true);
});
test('Render startup rejects platform, port, host and ambiguous TLS configuration', () => {
  for (const overrides of [{ RENDER: 'false' }, { RENDER: undefined }, { PORT: undefined }, { PORT: '0' }, { PORT: 'bad' }, { HOST: '127.0.0.1' }, { TLS_CERT_FILE: 'a', TLS_KEY_FILE: 'b' }])
    assert.throws(() => runtimeConfig({ ...renderEnv, ...overrides }));
});
test('Render ephemeral storage requires explicit development opt-in; production fails closed', () => {
  for (const overrides of [{ RELAY_STORAGE_MODE: undefined }, { RELAY_STORAGE_MODE: 'ephemeral' }, { NODE_ENV: undefined }, { NODE_ENV: 'production' }])
    assert.throws(() => runtimeConfig({ ...renderEnv, ...overrides }));
  assert.equal(runtimeConfig(renderEnv).ephemeral, true);
});
test('Render persistent mode requires absolute configured disk path and retains production budgets', () => {
  const env = { ...renderEnv, NODE_ENV: 'production', RELAY_STORAGE_MODE: 'persistent' };
  for (const path of [undefined, './data/relay.sqlite', ':memory:']) assert.throws(() => runtimeConfig({ ...env, RELAY_DB_PATH: path }));
  const config = runtimeConfig({ ...env, RELAY_DB_PATH: '/var/data/relay/relay.sqlite' });
  assert.equal(config.ephemeral, false); assert.equal(config.generationDailyGlobal, 50); assert.equal(config.generationDailyIP, 5); assert.equal(config.maxConcurrent, 2);
});
test('existing direct and loopback proxy modes remain strict', () => {
  assert.equal(runtimeConfig({ LOVABLE_GENERATE_URL: TEST_URL, TLS_CERT_FILE: 'cert', TLS_KEY_FILE: 'key' }).mode, 'direct');
  assert.equal(runtimeConfig({ LOVABLE_GENERATE_URL: TEST_URL, TLS_TERMINATION: 'reverse-proxy' }).host, '127.0.0.1');
  for (const env of [{}, { TLS_TERMINATION: 'unknown' }, { TLS_TERMINATION: 'reverse-proxy', HOST: '0.0.0.0' }, { TLS_CERT_FILE: 'cert' }]) assert.throws(() => runtimeConfig({ LOVABLE_GENERATE_URL: TEST_URL, ...env }));
});
test('Render HTTP ingress obtains short-lived session and forwards safe generation only to Lovable', async t => {
  const h = await harness(t); const issued = await h.session(); assert.equal(issued.status, 200); assert.equal(issued.body.expiresInSeconds, 3600);
  assert.match(issued.body.token, /^[A-Za-z0-9_-]{43}$/u);
  const result = await h.generate(issued.body.token); assert.equal(result.status, 200); assert.deepEqual(result.body, generated);
  assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, TEST_URL); assert.equal(h.calls[0].request.headers.Authorization, `Bearer ${TEST_KEY}`);
  assert.deepEqual(JSON.parse(h.calls[0].request.body), { prompt: 'BMW M4 in Marina Bay Blue', style: 'Soft 3D' });
  assert.equal(JSON.stringify(result.body).includes(TEST_KEY), false);
  assert.notEqual(h.state.db.prepare('SELECT hash FROM sessions').get().hash, issued.body.token);
});
test('Render generation refuses missing or expired session before upstream', async t => {
  let now = 10000; const h = await harness(t, { clock: () => now });
  assert.equal((await h.generate(undefined)).status, 401);
  const issued = await h.session(); now += 3601;
  assert.equal((await h.generate(issued.body.token)).status, 401); assert.equal(h.calls.length, 0);
});
test('Render API rejects missing, HTTP and ambiguous HTTPS forwarding values', async t => {
  const h = await harness(t);
  for (const value of ['', 'http', 'https,http', 'https, https', 'HTTPS']) {
    assert.equal((await h.session({ 'X-Forwarded-Proto': value })).status, 403);
    assert.equal((await h.generate('a'.repeat(43), { 'X-Forwarded-Proto': value })).status, 403);
  }
  assert.equal(h.calls.length, 0);
});
test('Render internal HTTP health probe needs no forwarding headers but exposes only readiness', async t => {
  const h = await harness(t);
  const health = await h.request('/healthz', { method: 'GET', headers: { 'X-Forwarded-Proto': '' } });
  assert.equal(health.status, 200); assert.deepEqual(health.body, { ready: true });
  assert.equal((await h.request('/healthz?probe=1', { method: 'GET', headers: { 'X-Forwarded-Proto': '' } })).status, 403);
  assert.equal((await h.request('/healthz', { headers: { 'X-Forwarded-Proto': '' } })).status, 403);
});
test('Render missing backend secret disables readiness, issuance and generation', async t => {
  const h = await harness(t, { apiKey: '' });
  const health = await h.request('/healthz', { method: 'GET', headers: { 'X-Forwarded-Proto': '' } });
  assert.equal(health.status, 503); assert.deepEqual(health.body, { ready: false });
  assert.equal((await h.session()).status, 503); assert.equal((await h.generate('a'.repeat(43))).status, 503); assert.equal(h.calls.length, 0);
});
test('Render spoofed client IPs and token rotation cannot reset shared ingress quota', async t => {
  const h = await harness(t, { generationDailyIP: 1 });
  const first = await h.session({ 'X-Forwarded-For': '8.8.8.8' }); assert.equal((await h.generate(first.body.token)).status, 200);
  const second = await h.session({ 'X-Forwarded-For': 'malformed, 1.1.1.1' });
  const refused = await h.generate(second.body.token, { 'X-Forwarded-For': '9.9.9.9', Forwarded: 'for=9.9.9.9;proto=https', 'True-Client-IP': '9.9.9.9' });
  assert.equal(refused.status, 429); assert.ok(Number(refused.headers.get('retry-after')) > 0); assert.equal(h.calls.length, 1);
});
test('ephemeral filesystem reset invalidates old tokens and resets budgets (not production-safe)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-ephemeral-')); const file = join(dir, 'relay.sqlite');
  try {
    let state = new RelayState(file); const token = state.issue(1000, 3600); state.consume([['budget', 86400, 1]], 1000); state.close();
    rmSync(dir, { recursive: true });
    state = new RelayState(file); assert.equal(state.verify(token, 1001), null);
    assert.doesNotThrow(() => state.consume([['budget', 86400, 1]], 1001)); state.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('actual Render entry point starts without TLS files, accepts health probe and warns about ephemeral storage', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'render-entry-'));
  const reservation = http.createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port; await new Promise(r => reservation.close(r));
  const dnsFixture = join(dir, 'dns-fixture.mjs');
  writeFileSync(dnsFixture, "import dns from 'node:dns'; dns.promises.lookup = async () => [{ address: '104.16.1.1', family: 4 }];");
  const child = spawn(process.execPath, ['--import', dnsFixture, new URL('../src/server.mjs', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, ...renderEnv, PORT: String(port), RELAY_DB_PATH: join(dir, 'relay.sqlite') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let stdout = '', stderr = '';
  child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited; rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Render server did not start.')), 5000);
    child.stdout.on('data', () => { if (stdout.includes('relay listening')) { clearTimeout(timer); resolve(); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Render entry point failed.')); });
  });
  const response = await fetch(`http://127.0.0.1:${port}/healthz`); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { ready: false });
  assert.match(stdout, /DEVELOPMENT ONLY/); assert.match(stdout, /share the conservative IP quota/);
  assert.equal((stdout + stderr).includes(TEST_KEY), false);
});

test('actual Render server uses LOVABLE_GENERATE_URL for authenticated generation, not former production fallback', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'render-upstream-env-'));
  const reservation = http.createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port; await new Promise(r => reservation.close(r));
  const preload = join(dir, 'upstream-fixture.mjs');
  // Test-only seams in a temporary child preload: production startup/configuration
  // and real HTTP handlers run unchanged; no live provider secret/image is used.
  writeFileSync(preload, `import dns from 'node:dns';
    dns.promises.lookup = async () => [{ address: '104.16.1.1', family: 4 }];
    globalThis.fetch = async (url, request) => {
      if (url !== process.env.LOVABLE_GENERATE_URL || request.headers.Authorization !== 'Bearer ' + process.env.EMOJI_API_KEY || request.redirect !== 'error') throw new Error('INVALID_FORWARDING');
      const body = JSON.parse(request.body);
      if (body.prompt !== 'BMW M4 in Marina Bay Blue' || body.style !== 'Soft 3D' || Object.keys(body).length !== 2) throw new Error('INVALID_PROMPT');
      return Response.json(${JSON.stringify(generated)});
    };`);
  const child = spawn(process.execPath, ['--import', preload, new URL('../src/server.mjs', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, ...renderEnv, PORT: String(port), RELAY_DB_PATH: join(dir, 'relay.sqlite'), EMOJI_API_KEY: TEST_KEY }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let stdout = '', stderr = '';
  child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited; rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Render server did not start.')), 5000);
    child.stdout.on('data', () => { if (stdout.includes('relay listening')) { clearTimeout(timer); resolve(); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Render entry point failed.')); });
  });
  const base = `http://127.0.0.1:${port}`;
  const issued = await fetch(base + '/api/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' }, body: '{}' });
  assert.equal(issued.status, 200); const session = await issued.json();
  const response = await fetch(base + '/api/emoji/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ prompt: 'BMW M4 in Marina Bay Blue', style: 'Soft 3D' }) });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), generated);
  assert.equal((stdout + stderr).includes(TEST_KEY), false); assert.equal((stdout + stderr).includes(session.token), false);
});
