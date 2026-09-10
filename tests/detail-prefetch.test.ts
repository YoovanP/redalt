import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { RedditCommentsResponse } from '../src/types/reddit';

function commentsPayload(postId: string): RedditCommentsResponse {
  return [
    {
      kind: 'Listing',
      data: {
        after: null,
        before: null,
        children: [
          {
            kind: 't3',
            data: {
              id: postId,
              name: `t3_${postId}`,
              title: 'Prefetched post',
              author: 'alice',
              subreddit: 'fixtures',
              permalink: `/r/fixtures/comments/${postId}/prefetched_post/`,
              selftext: 'Body text.',
              is_self: true,
              num_comments: 1,
              score: 4,
              created_utc: 1_700_000_000,
              over_18: false,
            },
          },
        ],
      },
    },
    {
      kind: 'Listing',
      data: {
        after: null,
        before: null,
        children: [
          { kind: 't1', data: { id: 'c1', author: 'bob', body: 'A comment.', replies: '' } },
        ],
      },
    },
  ];
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

test('opening a hovered post consumes the prefetch without a second request', async () => {
  fetchMock.mockResolvedValue(jsonResponse(commentsPayload('prefetch1')));

  const { prefetchPostDetail, fetchPostDetailWithPrefetch } = await import('../src/lib/redditApi');
  prefetchPostDetail('fixtures', 'prefetch1');

  // Prefetch dedupes while in flight and starts exactly one network request.
  prefetchPostDetail('fixtures', 'prefetch1');
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

  const result = await fetchPostDetailWithPrefetch('fixtures', 'prefetch1');

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(result.post.id).toBe('prefetch1');
  expect(result.comments.map((comment) => comment.body)).toEqual(['A comment.']);
});

test('a failed prefetch falls through to a live fetch', async () => {
  fetchMock.mockRejectedValueOnce(new Error('gateway down'));
  fetchMock.mockResolvedValue(jsonResponse(commentsPayload('prefetch2')));

  const { prefetchPostDetail, fetchPostDetailWithPrefetch } = await import('../src/lib/redditApi');
  prefetchPostDetail('fixtures', 'prefetch2');
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

  const result = await fetchPostDetailWithPrefetch('fixtures', 'prefetch2');

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(result.post.id).toBe('prefetch2');
});
