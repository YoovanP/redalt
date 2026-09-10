// Reliability comparison for the RSS-to-JSON mirror fallback.
//
// Runs the OLD mirror strategy (one feed2json call on the full RSS path) and
// the NEW one (two mirrors x reduced query variants x one retry round) against
// the same live services at the same moment, then reports success rate, the
// source that served the request, and latency per endpoint class.
//
//   node scripts/bench-mirror-fallbacks.mjs
//
// Reads from /candidate probe only: it does not touch Reddit-owned hosts, so
// it never extends a Reddit block. Still, run it sparingly.
const SUBREDDITS = [
  'programming',
  'webdev',
  'games',
  'worldnews',
  'askscience',
  'movies',
  'space',
  'cooking',
  'buildapc',
  'dataisbeautiful',
];

const SEARCHES = ['keyboard', 'mechanical keyboard', 'linux'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Count upstream mirror calls so the strategies can be compared on request
// volume as well as success rate. These are free services; the old code sent
// one request per fallback, the candidate walk can send several.
let mirrorCalls = 0;

const escapeXml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

function jsonFeedItemCount(payload) {
  if (!payload || typeof payload !== 'object') return 0;
  if (typeof payload.err === 'string') return 0;
  return Array.isArray(payload.items) ? payload.items.length : 0;
}

function rss2JsonItemCount(payload) {
  if (!payload || typeof payload !== 'object' || payload.status !== 'ok') return 0;
  return Array.isArray(payload.items) ? payload.items.length : 0;
}

async function getJson(url) {
  mirrorCalls += 1;
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  try {
    return { status: response.status, payload: JSON.parse(text) };
  } catch {
    return { status: response.status, payload: null };
  }
}

async function tryFeed2Json(redditRssPath) {
  const target = `https://www.reddit.com${redditRssPath}`;
  const url = `https://feed2json.org/convert?url=${encodeURIComponent(target)}`;
  try {
    const { status, payload } = await getJson(url);
    if (status === 429) return { items: 0, source: null, throttled: true };
    const items = jsonFeedItemCount(payload);
    return items > 0 ? { items, source: 'feed2json' } : null;
  } catch {
    return null;
  }
}

async function tryRss2Json(redditRssPath) {
  const target = `https://www.reddit.com${redditRssPath}`;
  const url = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(target)}`;
  try {
    const { payload } = await getJson(url);
    const message = String(payload?.message ?? '');
    if (/short period|too quickly|too many|rate ?limit|throttl|capacity/i.test(message)) {
      return { items: 0, source: null, throttled: true };
    }
    const items = rss2JsonItemCount(payload);
    return items > 0 ? { items, source: 'rss2json' } : null;
  } catch {
    return null;
  }
}

// Mirror of the shipped buildMirrorRssCandidates(): full query, then a reduced
// query, then the bare path.
function candidates(rssPath, upstreamQuery, isSearch) {
  const [basePath, rawQuery = ''] = rssPath.split('?');
  const params = new URLSearchParams(rawQuery);
  const requested = new URLSearchParams(upstreamQuery);
  const list = [];

  const add = (value) => {
    if (value && !list.includes(value)) list.push(value);
  };

  add(rssPath);
  params.delete('limit');
  const withoutLimit = params.toString();
  add(withoutLimit ? `${basePath}?${withoutLimit}` : basePath);

  if (isSearch) {
    const query = requested.get('q') ?? params.get('q') ?? '';
    const timeWindow = requested.get('t') ?? params.get('t');
    const reduced = new URLSearchParams();
    if (query) reduced.set('q', query);
    if (timeWindow) reduced.set('t', timeWindow);
    if (query) add(`${basePath}?${reduced.toString()}`);
  } else {
    add(basePath);
  }

  return list;
}

async function oldStrategy(rssPath) {
  const started = Date.now();
  const before = mirrorCalls;
  const hit = await tryFeed2Json(rssPath);
  return {
    items: hit?.items ?? 0,
    source: hit?.throttled ? null : (hit?.source ?? null),
    ms: Date.now() - started,
    calls: mirrorCalls - before,
  };
}

async function newStrategy(rssPath, upstreamQuery, isSearch) {
  const started = Date.now();
  const before = mirrorCalls;
  const paths = candidates(rssPath, upstreamQuery, isSearch);

  // Same order as the shipped gateway: every feed2json variant first, then
  // rss2json with the full RSS path, then one retry round. A throttle response
  // ends that mirror's round immediately, exactly as the gateway does.
  for (let round = 0; round < 2; round += 1) {
    let throttled = false;

    for (const path of paths) {
      const hit = await tryFeed2Json(path);
      if (hit?.items > 0) {
        return { items: hit.items, source: hit.source, ms: Date.now() - started, calls: mirrorCalls - before };
      }
      if (hit?.throttled) {
        throttled = true;
        break;
      }
    }

    const rss2 = await tryRss2Json(rssPath);
    if (rss2?.items > 0) {
      return { items: rss2.items, source: rss2.source, ms: Date.now() - started, calls: mirrorCalls - before };
    }

    if (throttled || rss2?.throttled || round === 1) {
      break;
    }

    await sleep(350);
  }

  return { items: 0, source: null, ms: Date.now() - started, calls: mirrorCalls - before };
}

function summarize(label, results) {
  const ok = results.filter((r) => r.items > 0);
  const bySource = {};
  let items = 0;
  let ms = 0;
  let calls = 0;

  for (const result of results) {
    items += result.items;
    ms += result.ms;
    calls += result.calls ?? 0;
    if (result.source) bySource[result.source] = (bySource[result.source] ?? 0) + 1;
  }

  const rate = ((ok.length / results.length) * 100).toFixed(0);
  const avgMs = Math.round(ms / results.length);
  const avgItems = ok.length ? (items / ok.length).toFixed(1) : '0';
  console.log(
    `  ${label.padEnd(4)} ${ok.length}/${results.length} (${rate}%)`.padEnd(18) +
      `avg ${String(avgMs).padStart(5)}ms  mirror calls ${String(calls).padStart(3)}  ` +
      `items/ok ${String(avgItems).padStart(5)}  ` +
      JSON.stringify(bySource),
  );
  return { rate: Number(rate), avgMs, ok: ok.length, total: results.length, calls };
}

console.log('=== listing feeds (10 subreddits, /r/<sub>.rss?limit=50) ===');
const listingOld = [];
const listingNew = [];
for (const sub of SUBREDDITS) {
  const rssPath = `/r/${sub}.rss?limit=50`;
  listingOld.push(await oldStrategy(rssPath));
  listingNew.push(await newStrategy(rssPath, 'limit=12', false));
  await sleep(300);
}
const oldListing = summarize('OLD', listingOld);
const newListing = summarize('NEW', listingNew);

console.log('=== searches (3 queries) ===');
const searchOld = [];
const searchNew = [];
for (const query of SEARCHES) {
  const encoded = encodeURIComponent(query);
  const rssPath = `/search.rss?q=${encoded}&sort=relevance&type=link&limit=50`;
  const upstreamQuery = `q=${encoded}&sort=relevance&type=link&limit=12`;
  searchOld.push(await oldStrategy(rssPath));
  searchNew.push(await newStrategy(rssPath, upstreamQuery, true));
  await sleep(300);
}
summarize('OLD', searchOld);
summarize('NEW', searchNew);

console.log('=== user listings (3 users) ===');
const users = ['spez', 'GallowBoob', 'shreddit'];
const userOld = [];
const userNew = [];
for (const user of users) {
  const rssPath = `/user/${user}/submitted.rss?limit=50`;
  userOld.push(await oldStrategy(rssPath));
  userNew.push(await newStrategy(rssPath, 'limit=12', false));
  await sleep(300);
}
summarize('OLD', userOld);
summarize('NEW', userNew);

console.log('');
console.log('listing delta: ' + (newListing.rate - oldListing.rate) + ' points');
