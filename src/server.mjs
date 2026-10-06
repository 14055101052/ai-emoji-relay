import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { RelayState, createRelay } from './relay.mjs';

function bounded(name, fallback, max) {
  const value = process.env[name] ?? String(fallback);
  if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > max) throw new Error('INVALID_CONFIG');
  return Number(value);
}

try {
  process.umask(0o077);
  const direct = !!process.env.TLS_CERT_FILE && !!process.env.TLS_KEY_FILE;
  const reverse = process.env.TLS_TERMINATION === 'reverse-proxy';
  if (!direct && !reverse) throw new Error('HTTPS_CONFIG_REQUIRED');
  const host = process.env.HOST ?? '127.0.0.1';
  if (reverse && !['127.0.0.1', '::1'].includes(host)) throw new Error('REVERSE_PROXY_MUST_BIND_LOOPBACK');
  const state = new RelayState(process.env.RELAY_DB_PATH ?? './data/relay.sqlite');
  const handler = createRelay({ apiKey: process.env.EMOJI_API_KEY ?? '', state, tlsTermination: direct ? 'direct' : 'reverse-proxy',
    generationDailyGlobal: bounded('GENERATION_DAILY_GLOBAL', 50, 10000), generationDailyIP: bounded('GENERATION_DAILY_IP', 5, 100),
    maxConcurrent: bounded('MAX_CONCURRENT_GENERATIONS', 2, 10) });
  const server = direct ? https.createServer({ cert: readFileSync(process.env.TLS_CERT_FILE), key: readFileSync(process.env.TLS_KEY_FILE), minVersion: 'TLSv1.2' }, handler)
    : http.createServer(handler);
  server.headersTimeout = 10000; server.requestTimeout = 20000; server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 100;
  server.on('error', () => { process.stderr.write('Relay listener failed. Check server configuration.\n'); process.exitCode = 1; });
  server.listen(bounded('PORT', 8787, 65535), host, () => {
    process.stdout.write('AI Emoji relay listening. No request logging is enabled.\n');
    if (!process.env.EMOJI_API_KEY) process.stdout.write('Backend credential missing; session issuance and generation are disabled (503).\n');
  });
  function stop() { server.close(() => { state.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); }
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
} catch { process.stderr.write('Relay startup failed. Check TLS, writable SQLite storage, and numeric environment configuration.\n'); process.exitCode = 1; }
