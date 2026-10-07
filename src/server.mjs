import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { RelayState, createRelay } from './relay.mjs';
import { runtimeConfig } from './runtime-config.mjs';
import { validateUpstreamDns } from './upstream-url.mjs';
import { createPollinationsFallback } from './pollinations-fallback.mjs';
import { createAIHordeFallback } from './aihorde-fallback.mjs';
import { probePollinations } from './provider-probe.mjs';

try {
  process.umask(0o077);
  const config = runtimeConfig();
  await validateUpstreamDns(config.generateUrl);
  const state = new RelayState(config.dbPath);
  const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? 'https://ai-emoji-relay.onrender.com';
  const pollinations = createPollinationsFallback({
    publicBaseUrl,
    apiKey: (process.env.POLLINATIONS_API_KEY ?? '').trim()
  });
  const horde = createAIHordeFallback({
    publicBaseUrl,
    apiKey: process.env.AIHORDE_API_KEY ?? '0000000000',
    fetchImpl: pollinations ? pollinations.wrapFetch : globalThis.fetch
  });
  const providerFetch = horde ? horde.wrapFetch : (pollinations ? pollinations.wrapFetch : globalThis.fetch);
  const relayHandler = createRelay({
    apiKey: process.env.EMOJI_API_KEY ?? '',
    generateUrl: config.generateUrl,
    state,
    fetchImpl: providerFetch,
    tlsTermination: config.mode,
    generationDailyGlobal: config.generationDailyGlobal,
    generationDailyIP: config.generationDailyIP,
    maxConcurrent: config.maxConcurrent
  });
  const handler = (req, res) => {
    if (pollinations?.serveImage(req, res)) return;
    if (horde?.serveImage(req, res)) return;
    return relayHandler(req, res);
  };
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
    process.stdout.write(pollinations ? 'Pollinations public image fallback enabled.\n' : 'Pollinations fallback unavailable because PUBLIC_BASE_URL is invalid.\n');
    process.stdout.write(horde ? 'AI Horde last-resort fallback enabled.\n' : 'AI Horde fallback unavailable because PUBLIC_BASE_URL is invalid.\n');
    probePollinations().then(result => {
      process.stdout.write(`[emoji-relay] pollinations_probe=${result.ok ? '200' : result.code}\n`);
    }).catch(() => {
      process.stdout.write('[emoji-relay] pollinations_probe=EXCEPTION\n');
    });
  });
  function stop() { server.close(() => { state.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); }
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
} catch { process.stderr.write('Relay startup failed. Check required LOVABLE_GENERATE_URL (HTTPS, approved project host, public DNS), TLS/proxy mode, explicit Render storage mode, writable SQLite path, PORT, and numeric configuration.\n'); process.exitCode = 1; }
