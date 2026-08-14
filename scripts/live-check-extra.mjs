// Extra live checks: video playback, YouTube embeds, user pages, shorts mode.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.LIVE_BASE ?? 'http://localhost:5173';
const OUT = path.join(process.cwd(), 'test-results', 'live');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const consoleErrors = [];

function record(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 200) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function apiJson(browser, apiPath) {
  const context = await browser.newContext();
  const page = await context.newPage();
  let data = null;
  try {
    const res = await page.request.get(`${BASE}${apiPath}`);
    data = await res.json();
  } catch {}
  await context.close();
  return data;
}

const browser = await chromium.launch();

// ---- 1. Video actually plays (readyState advances) ------------------------
{
  const listing = await apiJson(browser, '/api/reddit/r/funny/hot.json?raw_json=1&limit=25');
  const vidPost = (listing?.data?.children ?? []).find(
    (c) => c.kind === 't3' && (c.data.is_video === true || /v\.redd\.it/i.test(c.data.url ?? '')),
  )?.data;
  if (!vidPost) {
    record('video: playback', false, 'no video post found');
  } else {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(`[video] ${msg.text().slice(0, 160)}`); });
    await page.goto(`${BASE}/r/${vidPost.subreddit}/comments/${vidPost.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.detail-page video.post-video', { timeout: 25000 }).catch(() => {});
    // Wait for real playback readiness: HLS attaches and data flows.
    const ready = await page.waitForFunction(
      () => {
        const v = document.querySelector('.detail-page video.post-video');
        return Boolean(v && v.readyState >= 3);
      },
      { timeout: 25000 },
    ).then(() => true).catch(() => false);
    const playing = await page.locator('.detail-page video.post-video').first().evaluate(async (v) => {
      v.muted = true;
      try {
        await v.play();
        await new Promise((r) => setTimeout(r, 1200));
        return !v.paused && v.currentTime > 0;
      } catch {
        return false;
      }
    }).catch(() => false);
    const info = await page.locator('.detail-page video.post-video').first().evaluate((v) => ({
      readyState: v.readyState,
      duration: v.duration,
      error: v.error ? String(v.error.code) : null,
    })).catch(() => null);
    record('video: playback reaches canplay and plays', ready && playing, JSON.stringify(info));
    await page.screenshot({ path: path.join(OUT, 'video-playback.png'), fullPage: false });
    await context.close();
  }
}

// ---- 2. YouTube embed renders an iframe -----------------------------------
{
  const listing = await apiJson(browser, '/api/reddit/r/videos/hot.json?raw_json=1&limit=25');
  const ytPost = (listing?.data?.children ?? []).find(
    (c) => c.kind === 't3' && /youtube\.com|youtu\.be/i.test(c.data.url ?? ''),
  )?.data;
  if (!ytPost) {
    record('embed: YouTube', false, 'no YouTube post in listing');
  } else {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(`[yt] ${msg.text().slice(0, 160)}`); });
    await page.goto(`${BASE}/r/${ytPost.subreddit}/comments/${ytPost.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.detail-page iframe.external-frame', { timeout: 25000 }).catch(() => {});
    const iframes = await page.locator('.detail-page iframe.external-frame').count();
    const src = iframes > 0 ? await page.locator('.detail-page iframe.external-frame').first().getAttribute('src') : '';
    record('embed: YouTube iframe renders', iframes > 0, (src ?? '').slice(0, 70));
    await page.screenshot({ path: path.join(OUT, 'youtube-embed.png'), fullPage: false });
    await context.close();
  }
}

// ---- 3. User page ----------------------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(`[user] ${msg.text().slice(0, 160)}`); });
  await page.goto(`${BASE}/u/spez`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.post-card', { timeout: 30000 }).catch(() => {});
  const cards = await page.locator('.post-card').count();
  record('user page: posts render', cards > 0, `${cards} cards`);
  await page.screenshot({ path: path.join(OUT, 'user-page.png'), fullPage: false });
  await context.close();
}

// ---- 4. Shorts (video feed) mode ------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 420, height: 800 } });
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(`[shorts] ${msg.text().slice(0, 160)}`); });
  await page.addInitScript(() => {
    localStorage.setItem('redalt.uiSettings', JSON.stringify({ videoFeedMode: true, theme: 'dark' }));
  });
  await page.goto(`${BASE}/r/videos`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shorts-media-wrap, .post-card', { timeout: 30000 }).catch(() => {});
  const mediaBlocks = await page.locator('.shorts-media-wrap').count();
  const videos = await page.locator('video.post-video').count();
  record('shorts: media feed renders', mediaBlocks > 0 || videos > 0, `${mediaBlocks} wraps, ${videos} videos`);
  await page.screenshot({ path: path.join(OUT, 'shorts.png'), fullPage: false });
  await context.close();
}

await browser.close();

console.log('\n---- SUMMARY ----');
const failed = results.filter((r) => !r.ok);
for (const r of failed) console.log('FAILED:', r.name, r.detail);
console.log(`${results.length - failed.length}/${results.length} checks passed.`);
console.log(`console errors: ${consoleErrors.length}`);
for (const err of [...new Set(consoleErrors)].slice(0, 8)) console.log('  ', err);
