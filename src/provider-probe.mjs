const POLLINATIONS_TEST_URL = 'https://image.pollinations.ai/prompt/simple%20yellow%20smiley%20emoji?model=flux&width=256&height=256&nologo=true&enhance=false&safe=true&private=true';

export async function probePollinations(fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetchImpl(POLLINATIONS_TEST_URL, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'AIEmojiKeyboard-Relay/1.0' }
    });
    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!response.ok) return { ok: false, code: `HTTP_${response.status}` };
    if (!type.startsWith('image/')) return { ok: false, code: 'BAD_CONTENT' };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1024 || bytes.length > 8 * 1024 * 1024) return { ok: false, code: 'BAD_IMAGE' };
    return { ok: true, code: 'OK' };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, code: 'TIMEOUT' };
    return { ok: false, code: 'NETWORK' };
  } finally {
    clearTimeout(timer);
  }
}
