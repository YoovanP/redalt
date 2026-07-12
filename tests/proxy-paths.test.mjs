import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedRedditPath } from '../api/redditProxy.ts';

const allowedPaths = [
  '/r/popular.json',
  '/r/typescript/comments/abc123/post.json?raw_json=1',
  '/user/example/submitted.json',
  '/subreddits/search.json?q=react',
  '/users/search.json?q=example',
  '/search.json?q=privacy',
  '/api/search_reddit_names.json?query=react',
];

const rejectedPaths = [
  '/r/../settings.json',
  '/r/%2e%2e/settings.json',
  '/r/%252e%252e/settings.json',
  '/users/../api/v1/me',
  '/search.json.evil',
  '/api/search_reddit_names.json/extra',
  '//r/popular.json',
  '/r//popular.json',
  '/r/%E0%A4%A',
];

test('allows only supported public Reddit routes', () => {
  for (const path of allowedPaths) {
    assert.equal(isAllowedRedditPath(path), true, path);
  }
});

test('rejects traversal, malformed, and prefix-confusion routes', () => {
  for (const path of rejectedPaths) {
    assert.equal(isAllowedRedditPath(path), false, path);
  }
});
