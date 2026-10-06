import { isAbsolute } from 'node:path';
import { validateUpstreamUrl } from './upstream-url.mjs';

/** Non-secret deployment validation. Explicit Render opt-in never affects other TLS modes. */
export function runtimeConfig(env = process.env) {
  const generateUrl = validateUpstreamUrl(env.LOVABLE_GENERATE_URL);
  const fail = message => { throw new Error(message); };
  const bounded = (name, fallback, max) => {
    const value = env[name] ?? String(fallback);
    if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > max) fail(`Invalid ${name}.`);
    return Number(value);
  };
  const hasCert = !!env.TLS_CERT_FILE, hasKey = !!env.TLS_KEY_FILE;
  if (hasCert !== hasKey) fail('Provide both TLS certificate paths.');
  const mode = env.TLS_TERMINATION ?? (hasCert ? 'direct' : '');
  if (!['direct', 'reverse-proxy', 'render'].includes(mode)) fail('Select direct, reverse-proxy, or render TLS termination.');
  if (mode === 'direct' && !hasCert) fail('Direct TLS requires certificate paths.');
  if (mode !== 'direct' && hasCert) fail('Proxy TLS mode must not include direct TLS certificate paths.');
  let host = env.HOST ?? '127.0.0.1';
  let dbPath = env.RELAY_DB_PATH ?? './data/relay.sqlite';
  let ephemeral = false;
  if (mode === 'reverse-proxy' && !['127.0.0.1', '::1'].includes(host)) fail('Local reverse proxy must bind loopback.');
  if (mode === 'render') {
    if (env.RENDER !== 'true') fail('Render mode requires the Render runtime.');
    if (!env.PORT) fail('Render must supply PORT.');
    if (env.HOST && env.HOST !== '0.0.0.0') fail('Render requires HOST=0.0.0.0 or unset HOST.');
    host = '0.0.0.0';
    if (!['persistent', 'ephemeral-development'].includes(env.RELAY_STORAGE_MODE))
      fail('Render requires explicit RELAY_STORAGE_MODE.');
    ephemeral = env.RELAY_STORAGE_MODE === 'ephemeral-development';
    if (ephemeral && env.NODE_ENV !== 'development') fail('Ephemeral Render storage is development-only.');
    if (!ephemeral && (!env.RELAY_DB_PATH || !isAbsolute(dbPath)))
      fail('Persistent Render storage requires an absolute database path on an attached persistent disk.');
    // The operator must mount persistent storage; an absolute path alone does not prove durability.
  }
  return { mode, host, dbPath, ephemeral, generateUrl, port: bounded('PORT', 8787, 65535),
    generationDailyGlobal: bounded('GENERATION_DAILY_GLOBAL', 50, 10000),
    generationDailyIP: bounded('GENERATION_DAILY_IP', 5, 100),
    maxConcurrent: bounded('MAX_CONCURRENT_GENERATIONS', 2, 10) };
}
