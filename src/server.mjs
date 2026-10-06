import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { RelayState, createRelay } from './relay.mjs';
import { runtimeConfig } from './runtime-config.mjs';

try {
  process.umask(0o077);
  const config = runtimeConfig();
  const state = new RelayState(config.dbPath);
  const handler = createRelay({ apiKey: process.env.EMOJI_API_KEY ?? '', state, tlsTermination: config.mode,
    generationDailyGlobal: config.generationDailyGlobal, generationDailyIP: config.generationDailyIP,
    maxConcurrent: config.maxConcurrent });
  const direct = config.mode === 'direct';
  const server = direct ? https.createServer({ cert: readFileSync(process.env.TLS_CERT_FILE), key: readFileSync(process.env.TLS_KEY_FILE), minVersion: 'TLSv1.2' }, handler)
    : http.createServer(handler);
  server.headersTimeout = 10000; server.requestTimeout = 20000; server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 100;
  server.on('error', () => { process.stderr.write('Relay listener failed. Check server configuration.\n'); process.exitCode = 1; });
  server.listen(config.port, config.host, () => {
    process.stdout.write('AI Emoji relay listening. No request logging is enabled.\n');
    if (config.ephemeral) process.stdout.write('DEVELOPMENT ONLY: ephemeral SQLite loses sessions and quota budgets on filesystem reset; unsuitable for production.\n');
    if (config.mode === 'render') process.stdout.write('Render ingress mode: all clients share the conservative IP quota bucket; forwarded client-IP headers are ignored.\n');
    if (!process.env.EMOJI_API_KEY) process.stdout.write('Backend credential missing; session issuance and generation are disabled (503).\n');
  });
  function stop() { server.close(() => { state.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); }
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
} catch { process.stderr.write('Relay startup failed. Check TLS/proxy mode, explicit Render storage mode, writable SQLite path, PORT, and numeric configuration.\n'); process.exitCode = 1; }
