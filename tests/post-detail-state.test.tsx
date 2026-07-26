import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';
import type { NormalizedPost } from '../src/types/reddit';

const mocks = vi.hoisted(() => ({ fetchPostDetail: vi.fn() }));

vi.mock('../src/lib/redditApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/redditApi')>();
  return {
    ...original,
    fetchPostDetail: mocks.fetchPostDetail,
    fetchPostMediaEnrichment: vi.fn(),
    getRememberedPost: vi.fn(() => null),
  };
});

import { PostDetailPage } from '../src/pages/PostDetailPage';
import { UiSettingsProvider } from '../src/lib/uiSettings';

const fallbackPost: NormalizedPost = {
  id: 'abc', name: 't3_abc', title: 'Fallback remains visible', author: 'author', subreddit: 'fixtures',
  permalink: '/r/fixtures/comments/abc/fallback/', score: 10, numComments: 3,
  createdUtc: 1_700_000_000, selfText: '', isNsfw: false,
  outboundUrl: 'https://example.com/article', media: { type: 'link', outboundUrl: 'https://example.com/article' },
};

beforeEach(() => mocks.fetchPostDetail.mockReset());

test('keeps a route fallback visible when comments fail', async () => {
  mocks.fetchPostDetail.mockRejectedValueOnce(new Error('proxy unavailable'));
  render(
    <MemoryRouter initialEntries={[{ pathname: '/r/fixtures/comments/abc', state: { fallbackPost } }]}>
      <UiSettingsProvider>
        <Routes><Route path="/r/:name/comments/:id" element={<PostDetailPage />} /></Routes>
      </UiSettingsProvider>
    </MemoryRouter>,
  );

  expect(screen.getByRole('heading', { name: 'Fallback remains visible' })).toBeInTheDocument();
  expect(await screen.findByText('The post loaded, but comments are temporarily unavailable.')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Fallback remains visible' })).toBeInTheDocument();
});
