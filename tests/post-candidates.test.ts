import { describe, expect, test } from 'vitest';
import { mergePostCandidates } from '../src/lib/redditApi';
import type { RedditPostData } from '../src/types/reddit';

function fixture(overrides: Partial<RedditPostData> = {}): RedditPostData {
  return {
    id: 'abc', name: 't3_abc', title: 'Candidate fixture', author: 'author', subreddit: 'fixtures',
    permalink: '/r/fixtures/comments/abc/fixture/', url: 'https://reddit.com/r/fixtures/comments/abc/fixture/',
    domain: 'reddit.com', selftext: '', score: 10, num_comments: 2, created_utc: 1_700_000_000,
    over_18: false, is_self: false, ...overrides,
  };
}

describe('post candidate merging', () => {
  test('keeps fresh detail metadata while adopting richer listing media', () => {
    const detail = fixture({ score: 50, num_comments: 8 });
    const listing = fixture({
      score: 20,
      num_comments: 3,
      is_video: true,
      secure_media: { reddit_video: { fallback_url: 'https://v.redd.it/abc/DASH_720.mp4' } },
    });
    const merged = mergePostCandidates(detail, [listing]);
    expect(merged.score).toBe(50);
    expect(merged.num_comments).toBe(8);
    expect(merged.secure_media?.reddit_video?.fallback_url).toContain('DASH_720.mp4');
  });

  test('ignores candidates for another post', () => {
    const detail = fixture();
    expect(mergePostCandidates(detail, [fixture({ id: 'other', name: 't3_other', score: 999 })])).toBe(detail);
  });
});
