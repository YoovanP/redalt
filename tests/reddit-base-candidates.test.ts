import { afterEach, beforeEach, expect, test, vi } from 'vitest';

/**
 * Regression guard for the production incident where VITE_REDDIT_API_BASES was
 * set to two dead Render/Pages deployments. That variable is documented as
 * *additional* owned origins, but the resolver used to treat it as a
 * replacement, so the same-origin /api/reddit gateway disappeared from the
 * candidate list and every visitor lost the feed even though the gateway was
 * healthy.
 */

const fetchMock = vi.fn();

function listingResponse(ids: string[]): Response {
  return new Response(
    JSON.stringify({
      kind: 'Listing',
      data: {
        after: null,
        before: null,
        children: ids.map((id) => ({
          kind: 't3',
          data: {
            id,
            name: `t3_${id}`,
            title: `Fixture ${id}`,
            author: 'alice',
            subreddit: 'webdev',
            permalink: `/r/webdev/comments/${id}/fixture/`,
            selftext: '',
            is_self: true,
            score: 1,
            num_comments: 0,
            created_utc: 1_700_000_000,
            over_18: false,
          },
        })),
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fetchMock.mockReset();
});

test('treats configured bases as additive and calls the same-origin gateway first', async () => {
  vi.stubEnv('VITE_REDDIT_API_BASES', 'https://dead-one.example,https://dead-two.example');

  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/reddit')) {
      return listingResponse(['sameorigin']);
    }
    return new Response('gone', { status: 503 });
  });

  const { fetchSubredditListing } = await import('../src/lib/redditApi');
  const result = await fetchSubredditListing('webdev');

  expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/reddit/r/webdev/hot.json');
  expect(result.posts.map((post) => post.id)).toEqual(['sameorigin']);
});

test('still calls the same-origin gateway when no extra bases are configured', async () => {
  vi.stubEnv('VITE_REDDIT_API_BASES', '');

  fetchMock.mockImplementation(async () => listingResponse(['onlyorigin']));

  const { fetchSubredditListing } = await import('../src/lib/redditApi');
  const result = await fetchSubredditListing('webdev');

  expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/reddit/r/webdev/hot.json');
  expect(result.posts.map((post) => post.id)).toEqual(['onlyorigin']);
});

test('falls through to a configured owned base when the same-origin gateway fails', async () => {
  vi.stubEnv('VITE_REDDIT_API_BASES', 'https://backup.example');

  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/reddit')) {
      throw new TypeError('Failed to fetch');
    }
    if (url.startsWith('https://backup.example')) {
      return listingResponse(['backup']);
    }
    return new Response('gone', { status: 503 });
  });

  const { fetchSubredditListing } = await import('../src/lib/redditApi');
  const result = await fetchSubredditListing('webdev');

  const urls = fetchMock.mock.calls.map((call) => String(call[0]));
  expect(urls[0]).toContain('/api/reddit');
  expect(urls.some((url) => url.startsWith('https://backup.example'))).toBe(true);
  expect(result.posts.map((post) => post.id)).toEqual(['backup']);
});
