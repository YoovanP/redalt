import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { RedditListingResponse } from '../src/types/reddit';

function postChild(
  id: string,
  overrides: { num_comments: number; score: number; created_utc: number },
): { kind: 't3'; data: Record<string, unknown> } {
  return {
    kind: 't3',
    data: {
      id,
      name: `t3_${id}`,
      title: `Fixture post ${id}`,
      author: 'alice',
      subreddit: 'fixtures',
      permalink: `/r/fixtures/comments/${id}/fixture_post/`,
      selftext: '',
      is_self: true,
      ...overrides,
      over_18: false,
    },
  };
}

function listing(children: Array<Record<string, unknown>>): RedditListingResponse {
  return {
    kind: 'Listing',
    data: {
      after: null,
      before: null,
      children: children as unknown as RedditListingResponse['data']['children'],
    },
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

test("'new' sort re-orders mirror-served search results by created_utc descending", async () => {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/subreddits/search.json') || url.includes('/users/search.json')) {
      return jsonResponse(listing([]));
    }
    if (url.includes('/search.json')) {
      return jsonResponse(
        listing([
          postChild('a', { num_comments: 0, score: 1, created_utc: 1_700_000_100 }),
          postChild('b', { num_comments: 0, score: 1, created_utc: 1_700_000_000 }),
          postChild('c', { num_comments: 0, score: 1, created_utc: 1_700_000_200 }),
        ]),
      );
    }
    return jsonResponse(listing([]));
  });

  const { fetchGlobalSearch } = await import('../src/lib/redditApi');
  const result = await fetchGlobalSearch('query', { sort: 'new' });

  expect(result.posts.map((post) => post.id)).toEqual(['c', 'a', 'b']);
});

test("'top' sort re-orders by score descending", async () => {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/subreddits/search.json') || url.includes('/users/search.json')) {
      return jsonResponse(listing([]));
    }
    if (url.includes('/search.json')) {
      return jsonResponse(
        listing([
          postChild('a', { num_comments: 5, score: 12, created_utc: 1_700_000_200 }),
          postChild('b', { num_comments: 9, score: 30, created_utc: 1_700_000_000 }),
          postChild('c', { num_comments: 3, score: 30, created_utc: 1_700_000_100 }),
        ]),
      );
    }
    return jsonResponse(listing([]));
  });

  const { fetchGlobalSearch } = await import('../src/lib/redditApi');
  const result = await fetchGlobalSearch('query', { sort: 'top' });

  // Equal scores tie-break on comments, so 'b' (9 comments) beats 'c' (3).
  expect(result.posts.map((post) => post.id)).toEqual(['b', 'c', 'a']);
});
