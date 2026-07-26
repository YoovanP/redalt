import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test } from 'vitest';
import { RenderMedia } from '../src/components/media/RenderMedia';
import { UiSettingsProvider } from '../src/lib/uiSettings';
import { canClientPlayVideo } from '../src/lib/mediaCapabilities';
import type { NormalizedPost } from '../src/types/reddit';

function post(media: NormalizedPost['media']): NormalizedPost {
  return {
    id: 'abc', name: 't3_abc', title: 'Media fixture', author: 'author', subreddit: 'fixtures',
    permalink: '/r/fixtures/comments/abc/media_fixture/', score: 10, numComments: 2,
    createdUtc: 1_700_000_000, selfText: '', isNsfw: false,
    outboundUrl: 'https://example.com/source', media,
  };
}

function renderMedia(value: NormalizedPost, props: { mode?: 'default' | 'shorts'; active?: boolean } = {}) {
  return render(
    <MemoryRouter>
      <UiSettingsProvider><RenderMedia post={value} {...props} /></UiSettingsProvider>
    </MemoryRouter>,
  );
}

describe('media rendering', () => {
  test('shows a recoverable fallback when an image fails', () => {
    renderMedia(post({ type: 'image', url: 'https://example.com/image.jpg', width: 800, height: 600 }));
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByRole('alert')).toHaveTextContent('Media could not be loaded');
    expect(screen.getByRole('link', { name: 'Open source' })).toHaveAttribute('href', 'https://example.com/image.jpg');
  });

  test('keeps a generic external post actionable in shorts mode', () => {
    renderMedia(post({ type: 'external', outboundUrl: 'https://example.com/article' }), { mode: 'shorts', active: true });
    expect(screen.getByRole('link', { name: /Open external media/i })).toHaveAttribute('href', 'https://example.com/article');
  });

  test('mounts a trusted provider iframe when the post is near the viewport', () => {
    renderMedia(post({
      type: 'external',
      outboundUrl: 'https://www.youtube.com/watch?v=fixture',
      provider: 'YouTube',
      embedUrl: 'https://www.youtube.com/embed/fixture',
    }));
    expect(screen.getByTitle('YouTube')).toHaveAttribute('src', expect.stringContaining('/embed/fixture'));
  });

  test('renders gallery captions and item links', () => {
    renderMedia(post({
      type: 'gallery',
      items: [
        { id: 'one', type: 'image', url: 'https://example.com/one.jpg', caption: 'First caption', outboundUrl: 'https://example.com/one' },
        { id: 'two', type: 'image', url: 'https://example.com/two.jpg', caption: 'Second caption' },
      ],
    }));
    expect(screen.getByText('First caption')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(screen.getByText('Second caption')).toBeInTheDocument();
  });

  test('rejects DASH-only candidates that the client cannot play', () => {
    expect(canClientPlayVideo({ sourceUrl: 'https://v.redd.it/id/DASHPlaylist.mpd', mimeType: 'application/dash+xml' })).toBe(false);
    expect(canClientPlayVideo({ sourceUrl: 'https://v.redd.it/id/DASH_720.mp4', mimeType: 'video/mp4' })).toBe(true);
  });
});
