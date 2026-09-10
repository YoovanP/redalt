// Manual diagnostic: force the Reddit-owned path to fail and confirm the
// RSS-to-JSON mirrors still answer a feed, a search, a user listing, and a
// comment thread. Run it when Reddit is reachable (or not) to tell a mirror
// outage apart from a Reddit block:
//
//   node scripts/probe-mirror-fallbacks.mjs
//
// It calls third-party mirrors and Reddit, so run it sparingly and never in a
// loop against the live gateway.
import { handleRedditProxyRequest } from '../api/redditProxy.ts';

const realFetch = globalThis.fetch;
const log = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (/^https:\/\/(old\.reddit\.com|www\.reddit\.com)\//.test(url)) {
    log.push('BLOCK ' + url);
    return new Response('<body class="theme-beta">blocked</body>', { status: 403 });
  }
  const started = Date.now();
  const response = await realFetch(input, init);
  log.push('LIVE  ' + response.status + ' ' + (Date.now() - started) + 'ms ' + url.slice(0, 130));
  return response;
};

const env = {
  ENABLE_LEGACY_SCRAPE_FALLBACK: 'true',
  ENABLE_PUBLIC_INSTANCE_FALLBACK: 'false',
  REDDIT_DISABLE_SCRAPE_FALLBACK: 'false',
};

const paths = [
  ['feed', '/r/programming.json?limit=12'],
  ['search', '/search.json?q=keyboard&sort=relevance&type=link&limit=12'],
  ['user', '/user/spez/submitted.json?limit=12'],
  ['detail', '/r/nextfuckinglevel/comments/1wcadba/x.json?limit=10'],
];

for (const [name, path] of paths) {
  const started = Date.now();
  try {
    const response = await handleRedditProxyRequest(path, env);
    const text = await response.text();
    let detail = '';
    try {
      const payload = JSON.parse(text);
      detail = Array.isArray(payload)
        ? 'children=' + payload.map((l) => l?.data?.children?.length).join('/')
        : 'children=' + (payload?.data?.children?.length ?? '-') + ' kind=' + payload?.kind;
    } catch {
      detail = text.slice(0, 90).replace(/\s+/g, ' ');
    }
    console.log(
      name.padEnd(7),
      response.status,
      String(Date.now() - started).padStart(5) + 'ms',
      'fallback=' + (response.headers.get('x-redalt-fallback') || '-'),
      'instance=' + (response.headers.get('x-redalt-instance') || '-'),
      '|', detail,
    );
  } catch (e) {
    console.log(name, 'ERR', e.message);
  }
  await new Promise((r) => setTimeout(r, 1000));
}

console.log('--- upstream calls ---');
for (const line of log) console.log(line);