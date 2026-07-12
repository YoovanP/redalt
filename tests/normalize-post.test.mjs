import assert from 'node:assert/strict';
import test from 'node:test';
import { isTrustedEmbedUrl, normalizePost } from '../src/lib/normalizePost.ts';

function postFixture(overrides = {}) {
  return {
    id: 'abc123',
    name: 't3_abc123',
    title: 'Fixture post',
    author: 'fixture-author',
    subreddit: 'fixtures',
    permalink: '/r/fixtures/comments/abc123/fixture_post/',
    url: 'https://www.reddit.com/r/fixtures/comments/abc123/fixture_post/',
    domain: 'reddit.com',
    selftext: '',
    score: 10,
    num_comments: 2,
    created_utc: 1_700_000_000,
    over_18: false,
    is_self: false,
    ...overrides,
  };
}

test('falls through an empty secure_media object to media.reddit_video', () => {
  for (const secure_media of [{}, { reddit_video: {} }]) {
    const normalized = normalizePost(
      postFixture({
        secure_media,
        media: {
          reddit_video: {
            fallback_url: 'https://redlib.example/vid/clip/720.webm',
          },
        },
      }),
    );

    assert.equal(normalized.media.type, 'video');
    assert.equal(normalized.media.sourceUrl, 'https://redlib.example/vid/clip/720.webm');
    assert.equal(normalized.media.mimeType, 'video/webm');
  }
});

test('does not turn an image hint without an image candidate into a broken image', () => {
  const normalized = normalizePost(postFixture({ post_hint: 'image' }));

  assert.deepEqual(normalized.media, {
    type: 'link',
    outboundUrl: 'https://www.reddit.com/r/fixtures/comments/abc123/fixture_post/',
  });
});

test('prefers direct image URLs over provider embeds and ignores an empty override', () => {
  const normalized = normalizePost(
    postFixture({
      url: 'https://i.imgur.com/full-size.jpg',
      url_overridden_by_dest: '',
      domain: 'i.imgur.com',
      post_hint: 'image',
    }),
  );

  assert.deepEqual(normalized.media, {
    type: 'image',
    url: 'https://i.imgur.com/full-size.jpg',
    width: undefined,
    height: undefined,
  });
});

test('uses reddit_video_preview when an external post has no real embed', () => {
  const normalized = normalizePost(
    postFixture({
      url: 'https://example.com/watch/clip',
      url_overridden_by_dest: 'https://example.com/watch/clip',
      domain: 'example.com',
      preview: {
        reddit_video_preview: {
          fallback_url: 'https://v.redd.it/preview/DASH_720.mp4',
          hls_url: 'https://v.redd.it/preview/HLSPlaylist.m3u8',
          width: 720,
          height: 1280,
        },
      },
    }),
  );

  assert.equal(normalized.media.type, 'video');
  assert.equal(normalized.media.sourceUrl, 'https://v.redd.it/preview/DASH_720.mp4');
  assert.equal(normalized.media.hlsUrl, 'https://v.redd.it/preview/HLSPlaylist.m3u8');
});

test('normalizes direct video links with the correct source kind', () => {
  const cases = [
    ['https://cdn.example.com/clip.mp4', 'video/mp4', undefined],
    ['https://cdn.example.com/clip.webm', 'video/webm', undefined],
    ['https://cdn.example.com/clip.m3u8', undefined, 'https://cdn.example.com/clip.m3u8'],
  ];

  for (const [url, mimeType, hlsUrl] of cases) {
    const normalized = normalizePost(
      postFixture({ url, url_overridden_by_dest: url, domain: 'cdn.example.com', post_hint: 'hosted:video' }),
    );

    assert.equal(normalized.media.type, 'video', url);
    assert.equal(normalized.media.sourceUrl, url, url);
    assert.equal(normalized.media.mimeType, mimeType, url);
    assert.equal(normalized.media.hlsUrl, hlsUrl, url);
  }
});

test('inherits media from a crosspost parent without replacing outer post identity', () => {
  const parent = postFixture({
    id: 'parent1',
    name: 't3_parent1',
    permalink: '/r/videos/comments/parent1/parent/',
    url: 'https://v.redd.it/crosspost1',
    url_overridden_by_dest: 'https://v.redd.it/crosspost1',
    domain: 'v.redd.it',
    is_video: true,
    post_hint: 'hosted:video',
    secure_media: {
      reddit_video: {
        fallback_url: 'https://v.redd.it/crosspost1/DASH_720.mp4',
        hls_url: 'https://v.redd.it/crosspost1/HLSPlaylist.m3u8',
      },
    },
  });
  const normalized = normalizePost(postFixture({ crosspost_parent_list: [parent] }));

  assert.equal(normalized.id, 'abc123');
  assert.equal(normalized.title, 'Fixture post');
  assert.equal(normalized.outboundUrl, 'https://v.redd.it/crosspost1');
  assert.equal(normalized.media.type, 'video');
  assert.equal(normalized.media.sourceUrl, 'https://v.redd.it/crosspost1/DASH_720.mp4');
});

test('keeps image, animated, and video gallery items in source order', () => {
  const normalized = normalizePost(
    postFixture({
      is_gallery: true,
      url: 'https://www.reddit.com/gallery/abc123',
      gallery_data: {
        items: [
          { media_id: 'still', id: 0 },
          { media_id: 'animated', id: 1, caption: 'Animated item' },
          { media_id: 'video', id: 2 },
          { media_id: 'hls-video', id: 3 },
          { media_id: 'untyped-source-video', id: 4 },
        ],
      },
      media_metadata: {
        still: {
          status: 'valid',
          e: 'Image',
          m: 'image/jpeg',
          s: { u: 'https://i.redd.it/still.jpg', x: 100, y: 80 },
        },
        animated: {
          status: 'valid',
          e: 'AnimatedImage',
          m: 'image/gif',
          s: {
            gif: 'https://i.redd.it/animated.gif',
            mp4: 'https://preview.redd.it/animated.mp4',
            x: 200,
            y: 200,
          },
        },
        video: {
          status: 'valid',
          e: 'RedditVideo',
          m: 'video/mp4',
          s: { mp4: 'https://v.redd.it/gallery/DASH_720.mp4', x: 720, y: 1280 },
        },
        'hls-video': {
          status: 'valid',
          e: 'RedditVideo',
          m: 'video/mp4',
          hlsUrl: 'https://v.redd.it/gallery-hls/HLSPlaylist.m3u8',
          dashUrl: 'https://v.redd.it/gallery-hls/DASHPlaylist.mpd',
          x: 1080,
          y: 1920,
        },
        'untyped-source-video': {
          status: 'valid',
          s: {
            hlsUrl: 'https://v.redd.it/untyped-gallery/HLSPlaylist.m3u8',
            dashUrl: 'https://v.redd.it/untyped-gallery/DASHPlaylist.mpd',
          },
        },
      },
    }),
  );

  assert.equal(normalized.media.type, 'gallery');
  assert.deepEqual(normalized.media.items.map((item) => item.type), ['image', 'video', 'video', 'video', 'video']);
  assert.equal(normalized.media.items[1].isGif, true);
  assert.equal(normalized.media.items[1].caption, 'Animated item');
  assert.equal(normalized.media.items[2].sourceUrl, 'https://v.redd.it/gallery/DASH_720.mp4');
  assert.equal(normalized.media.items[3].sourceUrl, 'https://v.redd.it/gallery-hls/HLSPlaylist.m3u8');
  assert.equal(normalized.media.items[3].hlsUrl, 'https://v.redd.it/gallery-hls/HLSPlaylist.m3u8');
  assert.equal(normalized.media.items[4].sourceUrl, 'https://v.redd.it/untyped-gallery/HLSPlaylist.m3u8');
  assert.equal(normalized.media.items[4].hlsUrl, 'https://v.redd.it/untyped-gallery/HLSPlaylist.m3u8');
});

test('walks through empty crosspost wrappers to the richest bounded media parent', () => {
  const grandparent = postFixture({
    id: 'grandparent',
    name: 't3_grandparent',
    url: 'https://v.redd.it/nested-video',
    url_overridden_by_dest: 'https://v.redd.it/nested-video',
    domain: 'v.redd.it',
    is_video: true,
    secure_media: {
      reddit_video: {
        fallback_url: 'https://v.redd.it/nested-video/DASH_720.mp4',
      },
    },
  });
  const emptyParent = postFixture({
    id: 'empty-parent',
    name: 't3_empty-parent',
    media: {},
    secure_media: { reddit_video: {} },
    preview: { images: [] },
    crosspost_parent_list: [grandparent],
  });
  const normalized = normalizePost(postFixture({ crosspost_parent_list: [emptyParent] }));

  assert.equal(normalized.id, 'abc123');
  assert.equal(normalized.media.type, 'video');
  assert.equal(normalized.media.sourceUrl, 'https://v.redd.it/nested-video/DASH_720.mp4');
});

test('provider and Reddit host checks require an exact host boundary', () => {
  const fakeYouTube = normalizePost(
    postFixture({
      url: 'https://notyoutube.com/watch?v=wrong',
      url_overridden_by_dest: 'https://notyoutube.com/watch?v=wrong',
      domain: 'notyoutube.com',
    }),
  );
  const fakeReddit = normalizePost(
    postFixture({
      url: 'https://notreddit.com/video/fake',
      url_overridden_by_dest: 'https://notreddit.com/video/fake',
      domain: 'notreddit.com',
    }),
  );

  assert.equal(fakeYouTube.media.type, 'external');
  assert.equal(fakeYouTube.media.embedUrl, undefined);
  assert.notEqual(fakeYouTube.media.provider, 'YouTube');
  assert.equal(fakeReddit.media.type, 'external');
});

test('embed trust covers every host emitted by known provider builders', () => {
  const builderOutputs = [
    'https://www.youtube.com/embed/id',
    'https://player.vimeo.com/video/123',
    'https://www.redgifs.com/ifr/id',
    'https://www.tiktok.com/embed/v2/123',
    'https://www.instagram.com/reel/id/embed/captioned/',
    'https://platform.twitter.com/embed/Tweet.html?id=123',
    'https://player.twitch.tv/?channel=test&parent=localhost',
    'https://streamable.com/e/id',
    'https://www.dailymotion.com/embed/video/id',
    'https://open.spotify.com/embed/track/id',
    'https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Ftest',
    'https://www.loom.com/embed/id',
    'https://imgur.com/id/embed?pub=true',
    'https://gfycat.com/ifr/id',
  ];

  for (const url of builderOutputs) {
    assert.equal(isTrustedEmbedUrl(url), true, url);
  }

  assert.equal(isTrustedEmbedUrl('https://youtube.com.attacker.example/embed/id'), false);
  assert.equal(isTrustedEmbedUrl('http://www.youtube.com/embed/id'), false);
});

test('uses a playable Reddit preview before a Redgifs iframe', () => {
  const normalized = normalizePost(
    postFixture({
      url: 'https://www.redgifs.com/watch/example',
      url_overridden_by_dest: 'https://www.redgifs.com/watch/example',
      domain: 'redgifs.com',
      secure_media: {
        oembed: {
          provider_name: 'Redgifs',
          html: '<iframe src="https://www.redgifs.com/ifr/example"></iframe>',
        },
      },
      preview: {
        images: [
          {
            source: { url: 'https://preview.redd.it/example.jpg' },
            variants: { mp4: { source: { url: 'https://preview.redd.it/example.mp4' } } },
          },
        ],
      },
    }),
  );

  assert.equal(normalized.media.type, 'video');
  assert.equal(normalized.media.sourceUrl, 'https://preview.redd.it/example.mp4');
});

test('normalizes an identifiable malformed fallback post without throwing', () => {
  const normalized = normalizePost({
    name: 't3_malformed1',
    permalink: '/r/fallback/comments/malformed1/title/',
    author: null,
    title: null,
    subreddit: null,
    url: null,
    url_overridden_by_dest: '',
    domain: null,
    selftext: null,
    link_flair_text: 42,
    score: 'not-a-number',
    num_comments: '7',
    created_utc: Number.POSITIVE_INFINITY,
    over_18: null,
    is_self: false,
  });

  assert.equal(normalized.id, 'malformed1');
  assert.equal(normalized.name, 't3_malformed1');
  assert.equal(normalized.title, 'Untitled post');
  assert.equal(normalized.author, '[unknown]');
  assert.equal(normalized.subreddit, 'fallback');
  assert.equal(normalized.score, 0);
  assert.equal(normalized.numComments, 7);
  assert.equal(normalized.createdUtc, 0);
  assert.equal(normalized.selfText, '');
  assert.equal(normalized.media.type, 'link');
});
