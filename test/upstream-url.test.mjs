import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateUpstreamUrl, validateUpstreamDns, isPublicAddress } from '../src/upstream-url.mjs';
import { runtimeConfig } from '../src/runtime-config.mjs';
import { createRelay, RelayState } from '../src/relay.mjs';

const host = 'project--a55e5977-6867-4325-9a5e-5e9efbb3a82c';
const devURL = `https://${host}-dev.lovable.app/api/public/emoji/generate`;
const productionURL = `https://${host}.lovable.app/api/public/emoji/generate`;
const deployment = { TLS_TERMINATION: 'reverse-proxy' };

test('server environment selects development or production URL without fallback', () => {
  for (const url of [devURL, productionURL]) {
    assert.equal(runtimeConfig({ ...deployment, LOVABLE_GENERATE_URL: url }).generateUrl, url);
    assert.equal(validateUpstreamUrl(url), url);
  }
  for (const missing of [undefined, '', ' ']) assert.throws(() => runtimeConfig({ ...deployment, LOVABLE_GENERATE_URL: missing }), /LOVABLE_GENERATE_URL/);
});
test('upstream configuration rejects non-HTTPS, localhost, private names and every IP literal', () => {
  for (const value of [
    'not-a-url', devURL.replace('https:', 'http:'), devURL.replace('https:', 'file:'),
    'https://localhost/api/public/emoji/generate', 'https://localhost./api/public/emoji/generate',
    'https://emoji.local/api/public/emoji/generate', 'https://emoji.internal/api/public/emoji/generate',
    'https://127.0.0.1/api/public/emoji/generate', 'https://10.0.0.1/api/public/emoji/generate',
    'https://172.16.0.1/api/public/emoji/generate', 'https://192.168.0.1/api/public/emoji/generate',
    'https://169.254.169.254/api/public/emoji/generate', 'https://8.8.8.8/api/public/emoji/generate',
    'https://2130706433/api/public/emoji/generate', 'https://0x7f000001/api/public/emoji/generate',
    'https://[::1]/api/public/emoji/generate', 'https://[fd00::1]/api/public/emoji/generate',
    'https://[::ffff:127.0.0.1]/api/public/emoji/generate', 'https://[2606:4700::1111]/api/public/emoji/generate',
  ]) assert.throws(() => validateUpstreamUrl(value), /LOVABLE_GENERATE_URL/);
});
test('credentials, query, fragment, other project hosts, deceptive suffixes, wrong route and port are refused', () => {
  for (const value of [
    devURL.replace('https://', 'https://user:secret@'), `${devURL}?key=secret`, `${devURL}#secret`, `${devURL}?`, `${devURL}#`,
    devURL.replace(`${host}-dev.lovable.app`, 'different.lovable.app'),
    devURL.replace('.lovable.app', '.lovable.app.attacker.example'),
    devURL.replace('/api/public/emoji/generate', '/other'),
    devURL.replace('.app/', '.app:8443/'), ` ${devURL}`, devURL.replace('https://', 'https:\\'),
  ]) {
    try { validateUpstreamUrl(value); assert.fail('Expected invalid configuration'); }
    catch (error) { assert.match(error.message, /LOVABLE_GENERATE_URL/); assert.equal(error.message.includes('secret'), false); assert.equal(error.message.includes(value), false); }
  }
});
test('only public addresses pass DNS address filtering, including IPv6', () => {
  for (const ip of ['104.16.1.1', '93.184.216.34', '2606:4700::1111', '2a00:1450:4001::1']) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '100.127.255.255', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '192.0.2.1', '198.18.1.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fd00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2001::1', '2002:7f00:1::1', '3fff::1', 'invalid']) assert.equal(isPublicAddress(ip), false, ip);
});
test('startup DNS checks approved host, every answer, and fails on private/mixed/missing/unresolvable records', async () => {
  await validateUpstreamDns(devURL, async (hostname, options) => {
    assert.equal(hostname, `${host}-dev.lovable.app`); assert.deepEqual(options, { all: true, verbatim: true });
    return [{ address: '104.16.1.1', family: 4 }, { address: '2606:4700::1111', family: 6 }];
  });
  for (const records of [[], [{ address: '127.0.0.1' }], [{ address: '10.0.0.1' }], [{ address: 'fd00::1' }], [{ address: '104.16.1.1' }, { address: '192.168.0.1' }]])
    await assert.rejects(validateUpstreamDns(devURL, async () => records), /public addresses/);
  await assert.rejects(validateUpstreamDns(devURL, async () => { throw new Error('secret-dns-error'); }), error => !error.message.includes('secret-dns-error') && /public addresses/.test(error.message));
});
test('relay construction refuses absent/unsafe upstream before any request can be accepted', () => {
  const state = new RelayState();
  try {
    for (const generateUrl of [undefined, 'http://localhost/generate', 'https://10.0.0.1/generate'])
      assert.throws(() => createRelay({ generateUrl, state }), /LOVABLE_GENERATE_URL/);
  } finally { state.close(); }
});
test('actual server exits before SQLite/listener for missing, invalid or private-DNS upstream', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upstream-startup-'));
  const secret = 'synthetic-server-only-startup-credential';
  try {
    const preload = join(dir, 'dns-private.mjs');
    writeFileSync(preload, "import dns from 'node:dns'; dns.promises.lookup = async () => [{ address: '10.0.0.1', family: 4 }];");
    for (const value of [undefined, 'http://localhost/api/public/emoji/generate', devURL]) {
      const dbPath = join(dir, 'must-not-exist', 'relay.sqlite');
      const child = spawnSync(process.execPath, ['--import', preload, new URL('../src/server.mjs', import.meta.url).pathname], {
        env: { PATH: process.env.PATH, ...deployment, LOVABLE_GENERATE_URL: value, EMOJI_API_KEY: secret, RELAY_DB_PATH: dbPath }, encoding: 'utf8', timeout: 5000,
      });
      assert.equal(child.status, 1); assert.equal(existsSync(dbPath), false);
      assert.match(child.stderr, /LOVABLE_GENERATE_URL/); assert.equal(child.stdout.includes('listening'), false);
      assert.equal((child.stdout + child.stderr).includes(secret), false);
      if (value) assert.equal((child.stdout + child.stderr).includes(value), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
