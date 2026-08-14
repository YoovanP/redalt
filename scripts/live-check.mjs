// Live end-to-end check against the real gateway (dev server must be running).
// Usage: node scripts/live-check.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.LIVE_BASE ?? 'http://localhost:5173';
const OUT = path.join(process.cwd(), 'test-results', 'live');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const consoleErrors = [];
const brokenImages = new Set();

function record(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 200) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function apiJson(browser, apiPath) {
  // Use the browser context so cookies/UA match a real session.
  const context = await browser.newContext();
  const page = await context.newPage();
  const res = await page.request.get(`${BASE}${apiPath}`);
  let data = null;
  try { data = await res.json(); } catch { /* keep null */ }
  await context.close();
  return data;
}

function pickPost(listing, predicate) {
  const children = listing?.data?.children ?? [];
  const found = children.find((c) => c.kind === 't3' && predicate(c.data));
  return found?.data ?? null;
}

const browser = await chromium.launch();

// ---- 1. Home page trending ------------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`[home] ${msg.text().slice(0, 200)}`);
  });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.home-trending-card', { timeout: 20000 }).catch(() => {});
  const trendingCount = await page.locator('.home-trending-card').count();
  record('home: trending cards render', trendingCount > 0, `${trendingCount} cards`);
  await page
    .waitForFunction(
      () => {
        const imgs = [...document.querySelectorAll('.home-trending-media img')];
        return imgs.length > 0 && imgs.every((img) => img.complete);
      },
      { timeout: 15000 },
    )
    .catch(() => {});
  await page.waitForTimeout(500);
  const thumbs = await page.locator('.home-trending-media img').evaluateAll((imgs) =>
    imgs.map((img) => ({ src: img.src.slice(0, 60), ok: img.complete && img.naturalWidth > 0 })),
  );
  const bad = thumbs.filter((t) => !t.ok);
  for (const t of bad) brokenImages.add(t.src);
  record('home: thumbnails load', bad.length === 0, `${thumbs.length} thumbs, ${bad.length} broken`);
  await page.screenshot({ path: path.join(OUT, 'home.png'), fullPage: false });
  await context.close();
}

// ---- 2. Subreddit feed + types -------------------------------------------
const feedListing = await apiJson(browser, '/api/reddit/r/mildlyinfuriating/hot.json?raw_json=1&limit=25');
record('feed: gateway listing ok', Boolean(feedListing?.data?.children?.length), `${feedListing?.data?.children?.length ?? 0} posts`);

{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`[feed] ${msg.text().slice(0, 200)}`);
  });
  await page.goto(`${BASE}/r/mildlyinfuriating`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.post-card', { timeout: 25000 }).catch(() => {});
  const cardCount = await page.locator('.post-card').count();
  record('feed: post cards render', cardCount > 0, `${cardCount} cards`);
  // Scroll through the feed so lazy images actually load, then wait for them.
  await page.evaluate(async () => {
    for (let y = 0; y <= document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page
    .waitForFunction(
      () => {
        const imgs = [...document.querySelectorAll('.post-card img.post-image')];
        return imgs.length > 0 && imgs.every((img) => img.complete);
      },
      { timeout: 15000 },
    )
    .catch(() => {});
  await page.waitForTimeout(800);
  const feedImages = await page.locator('.post-card img.post-image').evaluateAll((imgs) =>
    imgs.map((img) => ({ src: img.src.slice(0, 60), ok: img.complete && img.naturalWidth > 0 })),
  );
  const badFeed = feedImages.filter((i) => !i.ok);
  for (const i of badFeed) brokenImages.add(i.src);
  record('feed: inline images load', badFeed.length === 0, `${feedImages.length} images, ${badFeed.length} broken`);
  const mediaKinds = await page.locator('.post-card').evaluateAll((cards) =>
    cards.map((card) => {
      if (card.querySelector('img.post-image')) return 'image';
      if (card.querySelector('video')) return 'video';
      if (card.querySelector('iframe.external-frame')) return 'embed';
      if (card.querySelector('.gallery-block')) return 'gallery';
      return 'text/other';
    }),
  );
  record('feed: mixed media kinds present', new Set(mediaKinds).size >= 2, [...new Set(mediaKinds)].join(','));
  await page.screenshot({ path: path.join(OUT, 'feed.png'), fullPage: false });
  await context.close();
}

// ---- 3. Image post detail -------------------------------------------------
{
  const imgPost = pickPost(feedListing, (d) =>
    d.post_hint === 'image' || /\.(png|jpe?g|webp)$/i.test(d.url ?? ''),
  );
  if (!imgPost) {
    record('detail: image post', false, 'no image post found in listing');
  } else {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[img-detail] ${msg.text().slice(0, 200)}`);
    });
    await page.goto(`${BASE}/r/${imgPost.subreddit}/comments/${imgPost.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.detail-page img.post-image', { timeout: 25000 }).catch(() => {});
    const img = page.locator('.detail-page img.post-image').first();
    await img
      .waitFor({ state: 'visible', timeout: 15000 })
      .catch(() => {});
    await page
      .waitForFunction(
        () => {
          const el = document.querySelector('.detail-page img.post-image');
          return Boolean(el && el.complete);
        },
        { timeout: 15000 },
      )
      .catch(() => {});
    const ok = await img.evaluate((el) => el.complete && el.naturalWidth > 0).catch(() => false);
    record('detail: image renders', ok, imgPost.id);
    const comments = await page.locator('.comment-item').count();
    record('detail: comments render', comments > 0, `${comments} comments`);
    await page.screenshot({ path: path.join(OUT, 'detail-image.png'), fullPage: false });
    await context.close();
  }
}

// ---- 4. Gallery post detail -----------------------------------------------
{
  const galPost = pickPost(feedListing, (d) => d.is_gallery === true || /\/gallery\//i.test(d.url ?? ''));
  if (!galPost) {
    record('detail: gallery post', false, 'no gallery in this listing');
  } else {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[gal-detail] ${msg.text().slice(0, 200)}`);
    });
    await page.goto(`${BASE}/r/${galPost.subreddit}/comments/${galPost.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.gallery-block img.post-image', { timeout: 25000 }).catch(() => {});
    let items = await page.locator('.gallery-block img.post-image').count();
    if (items === 0) {
      // Transient upstream block — retry once before declaring failure.
      await page.waitForTimeout(4000);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.gallery-block img.post-image', { timeout: 25000 }).catch(() => {});
      items = await page.locator('.gallery-block img.post-image').count();
    }
    if (items === 0) {
      // The parse may degrade a gallery to a single-image fallback; that is
      // still usable media for the reader.
      const fallbackImage = page.locator('.detail-page img.post-image').first();
      const fallbackOk = await fallbackImage.evaluate((el) => el.complete && el.naturalWidth > 0).catch(() => false);
      record('detail: gallery renders (or image fallback)', fallbackOk, 'image fallback');
    } else {
      record('detail: gallery renders', true, `${items} visible items`);
    }
    await page.screenshot({ path: path.join(OUT, 'detail-gallery.png'), fullPage: false });
    await context.close();
  }
}

// ---- 5. Video post detail --------------------------------------------------
{
  let vidPost = pickPost(feedListing, (d) => d.is_video === true || /v\.redd\.it/i.test(d.url ?? ''));
  if (!vidPost) {
    const videoListing = await apiJson(browser, '/api/reddit/r/videos/hot.json?raw_json=1&limit=25');
    vidPost = pickPost(videoListing, (d) => d.is_video === true || /v\.redd\.it/i.test(d.url ?? ''));
  }
  if (!vidPost) {
    record('detail: video post', false, 'no video post found');
  } else {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[vid-detail] ${msg.text().slice(0, 200)}`);
    });
    await page.goto(`${BASE}/r/${vidPost.subreddit}/comments/${vidPost.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.detail-page video.post-video', { timeout: 25000 }).catch(() => {});
    const video = page.locator('.detail-page video.post-video').first();
    const src = await video.evaluate((el) => el.currentSrc || el.querySelector('source')?.getAttribute('src') || '').catch(() => '');
    record('detail: video element with source', Boolean(src), src.slice(0, 70));
    await page.screenshot({ path: path.join(OUT, 'detail-video.png'), fullPage: false });
    await context.close();
  }
}

// ---- 6. Load more ----------------------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`[loadmore] ${msg.text().slice(0, 200)}`);
  });
  await page.addInitScript(() => {
    localStorage.setItem('redalt.uiSettings', JSON.stringify({ columns: 1, loadMoreMode: 'button', theme: 'dark' }));
  });
  await page.goto(`${BASE}/r/mildlyinfuriating`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.post-card', { timeout: 25000 }).catch(() => {});
  const before = await page.locator('.post-card').count();
  const loadMore = page.getByRole('button', { name: 'Load more' });
  const canLoad = (await loadMore.count()) > 0;
  if (canLoad) {
    await loadMore.click();
    await page.waitForTimeout(4000);
    const after = await page.locator('.post-card').count();
    record('feed: load more appends', after > before, `${before} -> ${after}`);
  } else {
    record('feed: load more button present', false, 'no Load more button');
  }
  await context.close();
}

// ---- 7. Search -------------------------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`[search] ${msg.text().slice(0, 200)}`);
  });
  await page.goto(`${BASE}/search?q=cat%20photos`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.search-page', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const postCards = await page.locator('.search-page .post-card').count();
  const chips = await page.locator('.search-page .search-chip-card').count();
  record('search: results render', postCards > 0 || chips > 0, `${postCards} posts, ${chips} chips`);
  await page.screenshot({ path: path.join(OUT, 'search.png'), fullPage: false });
  await context.close();
}

// ---- 8. Text post detail (self-post) ---------------------------------------
{
  const textPost = pickPost(feedListing, (d) => d.is_self === true);
  if (!textPost) {
    record('detail: text post', false, 'no text post found');
  } else {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[text-detail] ${msg.text().slice(0, 200)}`);
    });
    await page.goto(`${BASE}/r/${textPost.subreddit}/comments/${textPost.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.detail-page .self-text-markdown', { timeout: 25000 }).catch(() => {});
    const hasText = (await page.locator('.detail-page .self-text-markdown').count()) > 0;
    record('detail: self-post text renders', hasText, textPost.id);
    await context.close();
  }
}

await browser.close();

console.log('\n---- SUMMARY ----');
const failed = results.filter((r) => !r.ok);
for (const r of failed) console.log('FAILED:', r.name, r.detail);
console.log(`${results.length - failed.length}/${results.length} checks passed.`);
console.log(`broken image urls: ${brokenImages.size}`);
for (const src of [...brokenImages].slice(0, 10)) console.log('  ', src);
console.log(`console errors: ${consoleErrors.length}`);
for (const err of [...new Set(consoleErrors)].slice(0, 10)) console.log('  ', err);
