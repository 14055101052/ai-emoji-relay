import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
class VerificationFailure extends Error {}

async function boundedBody(response, max) {
  if (!response.body || Number(response.headers.get('content-length')) > max) throw new VerificationFailure('Response too large or empty.');
  const reader = response.body.getReader(); const parts = []; let total = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; total += value.length; if (total > max) throw new VerificationFailure('Response too large.'); parts.push(value); }
    return Buffer.concat(parts);
  } finally { await reader.cancel().catch(() => {}); }
}
try {
  const origin = new URL(process.env.RELAY_BASE_URL ?? '');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new VerificationFailure('Set RELAY_BASE_URL to the deployed HTTPS origin.');
  const options = { redirect: 'error', signal: AbortSignal.timeout(180000) };
  const issued = await fetch(new URL('/api/auth/session', origin), { ...options, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!issued.ok) throw new VerificationFailure(`Session endpoint returned HTTP ${issued.status}. Check relay health and server configuration.`);
  const session = JSON.parse((await boundedBody(issued, 4096)).toString());
  if (!/^[A-Za-z0-9_-]{43}$/u.test(session.token ?? '') || !Number.isInteger(session.expiresInSeconds) || session.expiresInSeconds < 61 || session.expiresInSeconds > 3600) throw new VerificationFailure('Invalid session contract.');
  const generated = await fetch(new URL('/api/emoji/generate', origin), { ...options, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ prompt: 'BMW M4 in Marina Bay Blue', style: 'Soft 3D' }) });
  if (!generated.ok) throw new VerificationFailure(`Generation endpoint returned HTTP ${generated.status}. Check backend access and relay quotas.`);
  const result = JSON.parse((await boundedBody(generated, 65536)).toString());
  const imageURL = new URL(result.imageUrl);
  if (result.success !== true || result.mimeType !== 'image/png' || imageURL.protocol !== 'https:' || imageURL.username || imageURL.password) throw new VerificationFailure('Relay returned an invalid PNG response.');
  // Never send a session or backend Authorization header to the signed image URL.
  const image = await fetch(imageURL, options);
  if (!image.ok) throw new VerificationFailure(`Image URL returned HTTP ${image.status}.`);
  const bytes = await boundedBody(image, 16 * 1024 * 1024);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString('ascii',12,16) !== 'IHDR') throw new VerificationFailure('Image URL did not return a PNG.');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width !== 1024 || height !== 1024) throw new VerificationFailure('PNG dimensions differ from the expected 1024 × 1024 pipeline.');
  const out = process.env.VERIFICATION_DIR ?? './live-verification'; mkdirSync(out, { recursive: true, mode: 0o700 });
  writeFileSync(`${out}/bmw-m4-marina-bay-blue.png`, bytes, { mode: 0o600 });
  const report = { prompt: 'BMW M4 in Marina Bay Blue', relayOrigin: origin.origin, id: result.id, name: result.name, mimeType: result.mimeType, expiresInSeconds: result.expiresInSeconds, width, height, pngSha256: createHash('sha256').update(bytes).digest('hex'), verifiedAt: new Date().toISOString() };
  writeFileSync(`${out}/result.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2)); // No tokens, secrets or temporary signed URLs in logs.
} catch (error) { console.error(error instanceof VerificationFailure ? error.message : 'Live verification failed. Check RELAY_BASE_URL, HTTPS connectivity and the relay response contract.'); process.exitCode = 1; }
