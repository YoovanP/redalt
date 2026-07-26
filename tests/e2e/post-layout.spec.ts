import { expect, test } from '@playwright/test';

const fixturePosts = Array.from({ length: 8 }, (_, index) => ({
  kind: 't3',
  data: {
    id: `post${index}`,
    name: `t3_post${index}`,
    title: `Responsive fixture ${index}`,
    author: 'fixture-author',
    subreddit: 'fixtures',
    permalink: `/r/fixtures/comments/post${index}/fixture/`,
    url: `https://i.redd.it/fixture${index}.jpg`,
    domain: 'i.redd.it',
    selftext: '', score: 10, num_comments: 2, created_utc: 1_700_000_000,
    over_18: false, is_self: false, post_hint: 'image',
    preview: { images: [{ source: { url: `https://i.redd.it/fixture${index}.jpg`, width: 1200, height: 800 } }] },
  },
}));

const embedPosts = Array.from({ length: 8 }, (_, index) => ({
  kind: 't3',
  data: {
    id: `embed${index}`,
    name: `t3_embed${index}`,
    title: `Embed fixture ${index}`,
    author: 'fixture-author',
    subreddit: 'fixtures',
    permalink: `/r/fixtures/comments/embed${index}/fixture/`,
    url: `https://www.youtube.com/watch?v=fixture${index}`,
    url_overridden_by_dest: `https://www.youtube.com/watch?v=fixture${index}`,
    domain: 'youtube.com',
    selftext: '', score: 10, num_comments: 2, created_utc: 1_700_000_000,
    over_18: false, is_self: false,
  },
}));

async function openFixtureFeed(page: import('@playwright/test').Page, width: number, height: number) {
  await page.route('**/api/reddit/**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ kind: 'Listing', data: { after: null, before: null, children: fixturePosts } }),
    });
  });
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => {
    localStorage.setItem('redalt.uiSettings', JSON.stringify({ columns: 4, theme: 'dark' }));
  });
  await page.goto('/r/fixtures');
  await expect(page.locator('.post-card')).toHaveCount(8);
}

test('post cards do not overflow a mobile viewport', async ({ page }) => {
  await openFixtureFeed(page, 360, 740);
  const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.viewport);
  const boxes = await page.locator('.post-card').evaluateAll((cards) => cards.slice(0, 3).map((card) => card.getBoundingClientRect().x));
  expect(new Set(boxes).size).toBe(1);
});

test('column preference is a maximum with readable card widths', async ({ page }) => {
  await openFixtureFeed(page, 1180, 800);
  const widths = await page.locator('.post-card').evaluateAll((cards) => cards.slice(0, 4).map((card) => card.getBoundingClientRect().width));
  expect(Math.min(...widths)).toBeGreaterThanOrEqual(260);
});

test('mounts provider embeds after loading another page', async ({ page }) => {
  await page.route('**/api/reddit/**', async (route) => {
    const after = new URL(route.request().url()).searchParams.get('after');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        kind: 'Listing',
        data: {
          after: after ? null : 't3_next',
          before: null,
          children: embedPosts.map((post, index) => after
            ? { ...post, data: { ...post.data, id: `next${index}`, name: `t3_next${index}` } }
            : post),
        },
      }),
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem('redalt.uiSettings', JSON.stringify({ columns: 1, loadMoreMode: 'button', theme: 'dark' }));
  });
  await page.goto('/r/fixtures');
  await expect(page.locator('.post-card')).toHaveCount(8);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.locator('.post-card')).toHaveCount(16);

  const appendedCard = page.locator('.post-card').last();
  await expect(appendedCard.locator('iframe.external-frame')).toHaveCount(1);
});
