import dns from 'node:dns';
import { isIP } from 'node:net';

// Credential destinations stay within the existing project, including its dev and published production hosts.
// These are an allowlist, not a default endpoint; the environment must select one.
const projectHosts = new Set([
  'project--a55e5977-6867-4325-9a5e-5e9efbb3a82c.lovable.app',
  'project--a55e5977-6867-4325-9a5e-5e9efbb3a82c-dev.lovable.app',
  'emoji-craft-ai.lovable.app',
]);

export function validateUpstreamUrl(value) {
  const invalid = () => { throw new Error('LOVABLE_GENERATE_URL is required and must be a valid HTTPS generation URL for the existing Lovable project.'); };
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\s\\?#]/u.test(value)) invalid();
  let url;
  try { url = new URL(value); } catch { invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      (url.port && url.port !== '443') || isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
      !projectHosts.has(url.hostname) || url.pathname !== '/api/public/emoji/generate') invalid();
  return url.href;
}

/** Reject private, loopback, link-local, multicast, documentation and reserved addresses. */
export function isPublicAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const n = address.split('.').reduce((result, byte) => result * 256 + Number(byte), 0);
    const blocks = [
      [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
      [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
      [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
      [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
    ];
    return !blocks.some(([base, prefix]) => Math.floor(n / 2 ** (32 - prefix)) === Math.floor(base / 2 ** (32 - prefix)));
  }
  if (version === 6 && !address.includes('%')) {
    const [first, second = '0'] = address.toLowerCase().split(':');
    const head = parseInt(first, 16), next = parseInt(second || '0', 16);
    // Only ordinary global unicast. Reject mapped IPv4, ULA, link/site local,
    // Teredo/special-purpose 2001::/23, documentation, and 6to4 tunnels.
    return head >= 0x2000 && head <= 0x3fff && head !== 0x2002 && head !== 0x3fff &&
      !(head === 0x2001 && (next <= 0x01ff || next === 0x0db8));
  }
  return false;
}

/** Fail startup before SQLite/listeners if DNS has any non-public result. */
export async function validateUpstreamDns(value, lookup = (host, options) => dns.promises.lookup(host, options)) {
  const url = new URL(validateUpstreamUrl(value));
  let timer;
  try {
    const records = await Promise.race([
      lookup(url.hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS_TIMEOUT')), 8000); }),
    ]);
    if (!Array.isArray(records) || records.length === 0 || records.some(record => !isPublicAddress(record.address)))
      throw new Error('NON_PUBLIC_DNS');
  } catch {
    throw new Error('LOVABLE_GENERATE_URL must resolve exclusively to public addresses.');
  } finally { clearTimeout(timer); }
}
