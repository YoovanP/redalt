// Two focused questions about the mirror fallback:
//  1. Does rss2json's 500 ("Cannot download this RSS feed") behave differently
//     once a free API key is supplied? A keyed call is the one upgrade path a
//     self-hoster can complete without Reddit cooperation.
//  2. Is feed2json's "Error processing feed" partly self-inflicted by our own
//     request volume (free-tier throttling), or is it per-feed upstream luck?
//     Measured by repeating the SAME feed back to back and watching the hit
//     rate degrade.
//
//   node scripts/probe-mirror-capacity.mjs [rss2json-api-key]
const apiKey = process.argv[2] ?? '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const enc = encodeURIComponent;

async function probe(url) {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    return { status: response.status, payload, ms: Date.now() - started };
  } catch (error) {
    return { status: 0, payload: null, ms: Date.now() - started, error: error.name };
  }
}

const feeds = ['programming', 'games', 'movies', 'space', 'cooking'];

console.log('=== rss2json: anonymous vs keyed on feeds feed2json rejects ===');
for (const sub of feeds) {
  const target = enc(`https://www.reddit.com/r/${sub}.rss?limit=50`);
  const anon = await probe(`https://api.rss2json.com/v1/api.json?rss_url=${target}`);
  const anonItems = anon.payload?.items?.length ?? 0;
  const anonNote = anonItems ? `${anonItems} items` : (anon.payload?.message ?? `http ${anon.status}`).slice(0, 46);

  if (!apiKey) {
    console.log(`  ${sub.padEnd(12)} anon: ${anonNote}`);
  } else {
    const keyed = await probe(
      `https://api.rss2json.com/v1/api.json?rss_url=${target}&api_key=${enc(apiKey)}&count=50`,
    );
    const keyedItems = keyed.payload?.items?.length ?? 0;
    const keyedNote = keyedItems
      ? `${keyedItems} items`
      : (keyed.payload?.message ?? `http ${keyed.status}`).slice(0, 46);
    console.log(`  ${sub.padEnd(12)} anon: ${anonNote.padEnd(24)} keyed: ${keyedNote}`);
  }

  await sleep(600);
}

console.log('');
console.log('=== feed2json: same feed repeated 6x (throttling signal) ===');
const repeatTarget = enc('https://www.reddit.com/r/webdev.rss?limit=50');
const outcomes = [];
for (let attempt = 1; attempt <= 6; attempt += 1) {
  const result = await probe(`https://feed2json.org/convert?url=${repeatTarget}`);
  const items = result.payload?.items?.length ?? 0;
  const note = items ? `${items} items` : (result.payload?.err ?? `http ${result.status}`);
  outcomes.push(items > 0 ? 'HIT' : 'miss');
  console.log(`  attempt ${attempt}: ${String(result.ms).padStart(5)}ms  ${note}`);
  await sleep(400);
}
console.log(`  pattern: ${outcomes.join(' ')}`);
