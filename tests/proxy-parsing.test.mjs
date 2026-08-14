import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseOldRedditCommentsResponse,
  parseOldRedditListing,
  parseRedlibCommentsResponse,
  parseRedlibListing,
  parseRssListing,
} from '../api/redditProxy.ts';

const TEST_PATH = '/r/test/hot.json?limit=3';
const TEDDIT_BASE = 'https://teddit.fixture.invalid';
let importId = 0;

function listing(...posts) {
  return {
    kind: 'Listing',
    data: {
      after: null,
      before: null,
      children: posts.map((data) => ({ kind: 't3', data })),
    },
  };
}

function post(id, overrides = {}) {
  const permalink = `/r/test/comments/${id}/fixture/`;

  return {
    id,
    name: `t3_${id}`,
    title: `Fixture ${id}`,
    author: 'fixture-user',
    subreddit: 'test',
    permalink,
    selftext: '',
    is_self: false,
    post_hint: 'link',
    thumbnail: 'default',
    url: `https://www.reddit.com${permalink}`,
    url_overridden_by_dest: `https://www.reddit.com${permalink}`,
    ...overrides,
  };
}

function isTedditJsonRequest(url) {
  const parsed = new URL(url);
  return parsed.origin === TEDDIT_BASE && parsed.searchParams.get('type') === 'json';
}

async function importFreshProxy() {
  importId += 1;
  return import(`../api/redditProxy.ts?proxy-parsing-test=${importId}`);
}

async function withFixtureFetch(resolve, run) {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return resolve(url, init) ?? new Response('fixture miss', { status: 503 });
  };

  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('parses old Reddit listing metadata and media from the matching thing block', () => {
  const html = `
    <div class="thing link" data-fullname="t3_image1" data-permalink="/r/pics/comments/image1/actual_title/"
      data-url="https://i.redd.it/full-image.jpg" data-domain="i.redd.it" data-subreddit="pics"
      data-author="alice" data-timestamp="1700000000000" data-score="1234" data-comments-count="56">
      <div class="entry">
        <p class="title"><a class="title may-blank" href="https://i.redd.it/full-image.jpg">Actual title</a></p>
        <a class="thumbnail" href="https://i.redd.it/full-image.jpg"><img src="https://preview.redd.it/full-image.jpg" /></a>
        <a class="comments" href="/r/pics/comments/image1/actual_title/">56 comments</a>
      </div>
    </div>`;
  const payload = parseOldRedditListing(html, '/r/pics/hot.json?limit=25');
  const result = payload.data.children[0].data;

  assert.equal(result.id, 'image1');
  assert.equal(result.title, 'Actual title');
  assert.equal(result.author, 'alice');
  assert.equal(result.subreddit, 'pics');
  assert.equal(result.score, 1234);
  assert.equal(result.num_comments, 56);
  assert.equal(result.url_overridden_by_dest, 'https://i.redd.it/full-image.jpg');
  assert.equal(result.post_hint, 'image');
  assert.equal(result.preview.images[0].source.url, 'https://i.redd.it/full-image.jpg');
});

test('uses the configured RedAlt agent for direct upstream requests', { concurrency: false }, async () => {
  const payload = listing(post('mobile-agent', { selftext: 'Mobile agent fixture' }));

  await withFixtureFetch(
    (url) => (url === `https://www.reddit.com${TEST_PATH}` ? Response.json(payload) : null),
    async (calls) => {
      const { handleRedditProxyRequest, REDDIT_MOBILE_USER_AGENT } = await importFreshProxy();
      const response = await handleRedditProxyRequest(TEST_PATH, {
        ENABLE_PUBLIC_INSTANCE_FALLBACK: 'false',
        ENABLE_LEGACY_SCRAPE_FALLBACK: 'false',
      });
      const directRequest = calls.find(({ url }) => url === `https://www.reddit.com${TEST_PATH}`);

      assert.equal(response.status, 200);
      assert.equal(directRequest.init.headers['User-Agent'], REDDIT_MOBILE_USER_AGENT);
    },
  );
});

test('prefers the official OAuth API and keeps credentials on the server', { concurrency: false }, async () => {
  const payload = listing(post('official-oauth', { selftext: 'Official API fixture' }));

  await withFixtureFetch(
    (url) => {
      if (url === 'https://www.reddit.com/api/v1/access_token') {
        return Response.json({ access_token: 'fixture-access-token', expires_in: 3600 });
      }

      if (url === `https://oauth.reddit.com${TEST_PATH}`) {
        return Response.json(payload);
      }

      return null;
    },
    async (calls) => {
      const { handleRedditProxyRequest } = await importFreshProxy();
      const response = await handleRedditProxyRequest(TEST_PATH, {
        REDDIT_CLIENT_ID: 'fixture-client-id',
        REDDIT_CLIENT_SECRET: 'fixture-client-secret',
      });
      const tokenRequest = calls.find(({ url }) => url === 'https://www.reddit.com/api/v1/access_token');
      const apiRequest = calls.find(({ url }) => url === `https://oauth.reddit.com${TEST_PATH}`);

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-redalt-source'), 'official-oauth');
      assert.ok(tokenRequest, 'OAuth token request was not made');
      assert.ok(apiRequest, 'Official Reddit API request was not made');
      assert.match(String(tokenRequest.init.headers.Authorization), /^Basic /);
      assert.equal(apiRequest.init.headers.Authorization, 'Bearer fixture-access-token');
      assert.equal(calls.some(({ url }) => url === `https://www.reddit.com${TEST_PATH}`), false);
    },
  );
});

test('shares one OAuth token exchange across concurrent cold requests', { concurrency: false }, async () => {
  let tokenRequests = 0;
  const credentials = {
    REDDIT_CLIENT_ID: 'fixture-client-id',
    REDDIT_CLIENT_SECRET: 'fixture-client-secret',
  };

  await withFixtureFetch(
    async (url) => {
      if (url === 'https://www.reddit.com/api/v1/access_token') {
        tokenRequests += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return Response.json({ access_token: 'fixture-access-token', expires_in: 3600 });
      }

      if (url === `https://oauth.reddit.com${TEST_PATH}` || url === 'https://oauth.reddit.com/r/test/new.json?limit=3') {
        return Response.json(listing(post('single-flight', { selftext: 'Shared token fixture' })));
      }

      return null;
    },
    async () => {
      const { handleRedditProxyRequest } = await importFreshProxy();
      const [firstResponse, secondResponse] = await Promise.all([
        handleRedditProxyRequest(TEST_PATH, credentials),
        handleRedditProxyRequest('/r/test/new.json?limit=3', credentials),
      ]);

      assert.equal(firstResponse.status, 200);
      assert.equal(secondResponse.status, 200);
      assert.equal(tokenRequests, 1);
    },
  );
});

test('returns an actionable rate limit response without falling through to a weaker source', { concurrency: false }, async () => {
  await withFixtureFetch(
    (url) => {
      if (url === `https://oauth.reddit.com${TEST_PATH}`) {
        return new Response(JSON.stringify({ reason: 'too many requests' }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '7',
          },
        });
      }

      return null;
    },
    async (calls) => {
      const { handleRedditProxyRequest } = await importFreshProxy();
      const response = await handleRedditProxyRequest(TEST_PATH, {
        REDDIT_OAUTH_ACCESS_TOKEN: 'fixture-static-token',
      });
      const payload = await response.json();

      assert.equal(response.status, 429);
      assert.equal(response.headers.get('retry-after'), '7');
      assert.equal(payload.retryAfterSeconds, 7);
      assert.equal(payload.retryable, true);
      assert.equal(calls.some(({ url }) => url === `https://www.reddit.com${TEST_PATH}`), false);
    },
  );
});

test('reports safe OAuth configuration status without exposing credentials', async () => {
  const { getRedditProxyStatus } = await importFreshProxy();
  const unconfigured = getRedditProxyStatus({});
  const configured = getRedditProxyStatus({
    REDDIT_CLIENT_ID: 'fixture-client-id',
    REDDIT_CLIENT_SECRET: 'fixture-client-secret',
    REDDIT_REFRESH_TOKEN: 'fixture-refresh-token',
    ENABLE_MIRROR_FALLBACK: 'true',
  });

  assert.equal(unconfigured.service, 'redalt-reddit-gateway');
  assert.equal(unconfigured.status, 'degraded');
  assert.equal(unconfigured.oauth.configured, false);
  assert.equal(configured.status, 'ready');
  assert.equal(configured.oauth.mode, 'refresh-token');
  assert.equal(configured.fallbacks.mirror, true);
  assert.doesNotMatch(JSON.stringify(configured), /fixture-client-secret|fixture-refresh-token/);
});

test('keeps old Reddit detail media scoped to the post instead of comments or sidebar', () => {
  const html = `
    <div class="thing link self" data-fullname="t3_self1" data-permalink="/r/test/comments/self1/scoped_self_post/"
      data-domain="self.test" data-subreddit="test" data-author="post-author" data-score="88" data-comments-count="1">
      <div class="entry">
        <p class="title"><a class="title" href="/r/test/comments/self1/scoped_self_post/">Scoped self post</a></p>
        <div class="usertext-body"><div class="md"><p>The real self post body.</p></div></div>
        <a class="comments" href="/r/test/comments/self1/scoped_self_post/">1 comment</a>
      </div>
    </div>
    <div id="comment_count">1 comment</div>
    <div class="thing comment" data-fullname="t1_comment1" data-author="commenter">
      <div class="entry">
        <div class="usertext-body"><div class="md"><p>Unrelated clip: <a href="https://v.redd.it/unrelated-video">video</a></p></div></div>
      </div>
    </div>`;
  const payload = parseOldRedditCommentsResponse(
    html,
    '/r/test/comments/self1/scoped_self_post.json?raw_json=1',
  );
  const result = payload[0].data.children[0].data;

  assert.equal(result.id, 'self1');
  assert.equal(result.title, 'Scoped self post');
  assert.equal(result.author, 'post-author');
  assert.equal(result.is_self, true);
  assert.equal(result.selftext, 'The real self post body.');
  assert.equal(result.media, undefined);
  assert.equal(result.secure_media, undefined);
  assert.equal(result.url, 'https://www.reddit.com/r/test/comments/self1/scoped_self_post/');
  assert.equal(payload[1].data.children[0].data.body.includes('Unrelated clip'), true);
  assert.equal(payload[1].data.children[0].data.body.includes('[video](https://v.redd.it/unrelated-video)'), true);
});

test('parses Redlib GIF detail media and removes flair/status labels from the title', () => {
  const html = `
    <div class="post highlighted">
      <p class="post_header"><a class="post_subreddit" href="/r/test">r/test</a><a class="post_author" href="/u/alice">u/alice</a></p>
      <h1 class="post_title"><a class="post_flair">Funny</a>Actual GIF title <small class="nsfw">NSFW</small></h1>
      <!-- post_type: gif -->
      <div class="post_media_content">
        <video class="post_media_video" src="https://redlib.fixture/vid/gif123/DASH/720.mp4" width="720" height="1280"></video>
      </div>
      <div class="post_body"></div>
      <div class="post_score" title="42"></div>
      <a class="post_comments">3 comments</a>
    </div>
    <p id="comment_count">3 comments</p>`;
  const payload = parseRedlibCommentsResponse(
    html,
    '/r/test/comments/gif123/actual_gif_title.json',
    'https://redlib.fixture',
    'instance',
  );
  const result = payload[0].data.children[0].data;

  assert.equal(result.title, 'Actual GIF title');
  assert.equal(result.is_video, true);
  assert.equal(result.media.reddit_video.is_gif, true);
  assert.equal(result.media.reddit_video.fallback_url, 'https://redlib.fixture/vid/gif123/DASH/720.mp4');
});

test('keeps collapsed Redlib galleries marked for detail enrichment', () => {
  const html = `
    <div class="post" id="gallery1">
      <p class="post_header"><a class="post_subreddit" href="/r/test">r/test</a><a class="post_author" href="/u/alice">u/alice</a></p>
      <h2 class="post_title"><a href="/r/test/comments/gallery1/gallery_title/">Gallery title</a></h2>
      <!-- post_type: gallery -->
      <a class="post_thumbnail" href="/r/test/comments/gallery1/gallery_title/"><img src="https://redlib.fixture/preview/pre/gallery-first.jpg?width=140" /></a>
      <div class="post_score" title="12"></div>
      <a class="post_comments">4 comments</a>
    </div>`;
  const payload = parseRedlibListing(
    html,
    '/r/test/hot.json?limit=25',
    'https://redlib.fixture',
    'instance',
  );
  const result = payload.data.children[0].data;

  assert.equal(result.id, 'gallery1');
  assert.equal(result.post_hint, 'gallery');
  assert.equal(result.is_gallery, undefined);
  assert.equal(result.url, 'https://www.reddit.com/r/test/comments/gallery1/gallery_title/');
  assert.equal(result.preview.images[0].source.url, 'https://redlib.fixture/img/gallery-first.jpg');
});

test('keeps RSS self posts as text when their body contains external links', () => {
  const xml = `
    <rss><channel><item>
      <title>Long self post</title>
      <author>alice</author>
      <link>https://teddit.fixture/r/test/comments/rssself/long_self_post/</link>
      <url>https://teddit.fixture/r/test/comments/rssself/long_self_post/</url>
      <description><![CDATA[
        <p>Paragraph one.</p><p>Paragraph two with <a href="https://example.com/reference">a reference</a>.</p>
        <p>Paragraph three.</p><p>Paragraph four.</p><p>Paragraph five must remain.</p>
        <a href="https://teddit.fixture/r/test/comments/rssself/long_self_post/">[comments]</a>
      ]]></description>
      <is_self_link>true</is_self_link><ups>321</ups><num_comments>7</num_comments>
    </item></channel></rss>`;
  const payload = parseRssListing(xml, '/r/test/hot.json?limit=25', 'https://teddit.fixture');
  const result = payload.data.children[0].data;

  assert.equal(result.is_self, true);
  assert.equal(result.score, 321);
  assert.equal(result.num_comments, 7);
  assert.equal(result.selftext.includes('Paragraph five must remain.'), true);
  assert.equal(result.url, 'https://teddit.fixture/r/test/comments/rssself/long_self_post/');
  assert.equal(result.media, null);
});

test('prefers the RSS submission image over a small inline thumbnail', () => {
  const xml = `
    <feed><entry>
      <title>Full image post</title>
      <author><name>/u/alice</name></author>
      <link href="https://reddit.example/r/test/comments/rssimage/full_image_post/" />
      <updated>2026-07-12T00:00:00Z</updated>
      <content type="html"><![CDATA[
        <a href="https://cdn.example.com/original.jpg">[link]</a>
        <a href="https://reddit.example/r/test/comments/rssimage/full_image_post/">[comments]</a>
        <img src="https://cdn.example.com/thumb.jpg" />
      ]]></content>
    </entry></feed>`;
  const payload = parseRssListing(xml, '/r/test/hot.json?limit=25', 'https://reddit.example');
  const result = payload.data.children[0].data;

  assert.equal(result.post_hint, 'image');
  assert.equal(result.url_overridden_by_dest, 'https://cdn.example.com/original.jpg');
  assert.equal(result.preview.images[0].source.url, 'https://cdn.example.com/original.jpg');
});

test('does not treat lookalike provider hosts as trusted embeds', () => {
  const xml = `
    <rss><channel><item>
      <title>Lookalike provider link</title>
      <author>alice</author>
      <link>https://teddit.fixture/r/test/comments/spoofed/lookalike_provider/</link>
      <url>https://notyoutube.com/watch?v=spoofed</url>
      <description><![CDATA[
        <a href="https://notyoutube.com/watch?v=spoofed">[link]</a>
        <a href="https://teddit.fixture/r/test/comments/spoofed/lookalike_provider/">[comments]</a>
      ]]></description>
    </item></channel></rss>`;
  const payload = parseRssListing(xml, '/r/test/hot.json?limit=25', 'https://teddit.fixture');
  const result = payload.data.children[0].data;

  assert.equal(result.post_hint, 'link');
  assert.equal(result.url_overridden_by_dest, 'https://notyoutube.com/watch?v=spoofed');
  assert.equal(result.media, null);
  assert.equal(result.secure_media, null);
});

test('rejects Teddit title stubs with empty media, preview, and gallery shells', { concurrency: false }, async () => {
  const emptyPayload = listing(
    post('empty-objects', {
      media: {},
      secure_media: {},
      preview: {},
    }),
    post('empty-nested-media', {
      media: { oembed: {} },
      secure_media: { reddit_video: {} },
      preview: { images: [{ source: {}, variants: { mp4: { source: {} } } }] },
    }),
    post('empty-gallery', {
      is_gallery: true,
      gallery_data: { items: [] },
      media_metadata: {},
    }),
  );
  const fallbackPayload = listing(post('direct-fallback', { selftext: 'Full fallback post body' }));

  await withFixtureFetch(
    (url) => {
      if (isTedditJsonRequest(url)) {
        return Response.json(emptyPayload);
      }

      if (url === `https://www.reddit.com${TEST_PATH}`) {
        return Response.json(fallbackPayload);
      }

      return null;
    },
    async (calls) => {
      const { handleRedditProxyRequest } = await importFreshProxy();
      const response = await handleRedditProxyRequest(
        TEST_PATH,
        {
          ENABLE_PUBLIC_INSTANCE_FALLBACK: 'true',
          ENABLE_LEGACY_SCRAPE_FALLBACK: 'false',
          REDDIT_PUBLIC_INSTANCE_BASES: TEDDIT_BASE,
        },
        { enableMirrorFallback: false },
      );
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.data.children[0].data.id, 'direct-fallback');
      assert.ok(calls.some(({ url }) => isTedditJsonRequest(url)), 'Teddit JSON fixture was not exercised');
      assert.ok(calls.some(({ url }) => url === `https://www.reddit.com${TEST_PATH}`), 'fallback did not continue');
    },
  );
});

test('accepts Teddit JSON when reddit_video and preview contain real sources', { concurrency: false }, async () => {
  const videoPayload = listing(
    post('video-post', {
      is_video: true,
      post_hint: 'hosted:video',
      url: 'https://v.redd.it/video123',
      url_overridden_by_dest: 'https://v.redd.it/video123',
      media: {
        reddit_video: {
          fallback_url: 'https://v.redd.it/video123/DASH_720.mp4',
          hls_url: 'https://v.redd.it/video123/HLSPlaylist.m3u8',
        },
      },
      preview: {
        images: [{ source: { url: 'https://preview.redd.it/video123.jpg' } }],
      },
    }),
  );

  await withFixtureFetch(
    (url) => (isTedditJsonRequest(url) ? Response.json(videoPayload) : null),
    async (calls) => {
      const { handleRedditProxyRequest } = await importFreshProxy();
      const response = await handleRedditProxyRequest(
        TEST_PATH,
        {
          ENABLE_PUBLIC_INSTANCE_FALLBACK: 'true',
          REDDIT_PUBLIC_INSTANCE_BASES: TEDDIT_BASE,
        },
        { enableMirrorFallback: false },
      );
      const payload = await response.json();
      const result = payload.data.children[0].data;

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-redalt-instance'), TEDDIT_BASE);
      assert.equal(result.id, 'video-post');
      assert.equal(result.media.reddit_video.hls_url, 'https://v.redd.it/video123/HLSPlaylist.m3u8');
      assert.equal(
        calls.some(({ url }) => url === `https://www.reddit.com${TEST_PATH}`),
        false,
        'valid Teddit media should stop fallback',
      );
    },
  );
});

test('accepts gallery image and video source variants with real URLs', { concurrency: false }, async () => {
  const cases = [
    ['source-mp4', { s: { mp4: 'https://preview.redd.it/gallery-video.mp4' } }],
    ['source-gif', { s: { gif: 'https://i.redd.it/gallery-animation.gif' } }],
    ['metadata-hls', { hlsUrl: 'https://v.redd.it/gallery-hls/HLSPlaylist.m3u8' }],
    ['metadata-dash', { dashUrl: 'https://v.redd.it/gallery-dash/DASHPlaylist.mpd' }],
  ];

  for (const [id, metadata] of cases) {
    const galleryPayload = listing(
      post(id, {
        is_gallery: true,
        gallery_data: { items: [{ media_id: id, id: 0 }] },
        media_metadata: {
          [id]: {
            status: 'valid',
            e: 'AnimatedImage',
            ...metadata,
          },
        },
      }),
    );

    await withFixtureFetch(
      (url) => (isTedditJsonRequest(url) ? Response.json(galleryPayload) : null),
      async () => {
        const { handleRedditProxyRequest } = await importFreshProxy();
        const response = await handleRedditProxyRequest(
          TEST_PATH,
          {
            ENABLE_PUBLIC_INSTANCE_FALLBACK: 'true',
            REDDIT_PUBLIC_INSTANCE_BASES: TEDDIT_BASE,
          },
          { enableMirrorFallback: false },
        );
        const payload = await response.json();

        assert.equal(response.status, 200, id);
        assert.equal(response.headers.get('x-redalt-instance'), TEDDIT_BASE, id);
        assert.equal(payload.data.children[0].data.id, id);
      },
    );
  }
});

test('accepts and rewrites media from a bounded canonical crosspost', { concurrency: false }, async () => {
  const crosspostPayload = listing(
    post('crosspost-wrapper', {
      crosspost_parent_list: [
        post('canonical-video', {
          is_video: true,
          post_hint: 'hosted:video',
          url: `${TEDDIT_BASE}/vid/video123/DASH/720.mp4`,
          url_overridden_by_dest: `${TEDDIT_BASE}/vid/video123/DASH/720.mp4`,
          media: {
            reddit_video: {
              fallback_url: `${TEDDIT_BASE}/vid/video123/DASH/720.mp4`,
              hls_url: `${TEDDIT_BASE}/hls/video123/HLSPlaylist.m3u8`,
            },
          },
          preview: {
            images: [
              {
                source: { url: `${TEDDIT_BASE}/preview/pre/video123.jpg?width=1080` },
                variants: {
                  mp4: { source: { mp4: `${TEDDIT_BASE}/vid/video123/DASH/480.mp4` } },
                },
              },
            ],
          },
          media_metadata: {
            'video-variant': {
              s: { mp4: `${TEDDIT_BASE}/vid/video123/DASH/360.mp4` },
              hlsUrl: `${TEDDIT_BASE}/hls/video123/HLSPlaylist.m3u8`,
            },
          },
        }),
      ],
    }),
  );

  await withFixtureFetch(
    (url) => (isTedditJsonRequest(url) ? Response.json(crosspostPayload) : null),
    async () => {
      const { handleRedditProxyRequest } = await importFreshProxy();
      const response = await handleRedditProxyRequest(
        `${TEST_PATH}&redalt_media=reddit`,
        {
          ENABLE_PUBLIC_INSTANCE_FALLBACK: 'true',
          REDDIT_PUBLIC_INSTANCE_BASES: TEDDIT_BASE,
        },
        { enableMirrorFallback: false },
      );
      const payload = await response.json();
      const canonical = payload.data.children[0].data.crosspost_parent_list[0];

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-redalt-instance'), TEDDIT_BASE);
      assert.equal(canonical.media.reddit_video.fallback_url, 'https://v.redd.it/video123/DASH_720.mp4');
      assert.equal(canonical.media.reddit_video.hls_url, 'https://v.redd.it/video123/HLSPlaylist.m3u8');
      assert.equal(canonical.preview.images[0].source.url, 'https://preview.redd.it/video123.jpg?width=1080');
      assert.equal(
        canonical.preview.images[0].variants.mp4.source.mp4,
        'https://v.redd.it/video123/DASH_480.mp4',
      );
      assert.equal(
        canonical.media_metadata['video-variant'].s.mp4,
        'https://v.redd.it/video123/DASH_360.mp4',
      );
      assert.equal(
        canonical.media_metadata['video-variant'].hlsUrl,
        'https://v.redd.it/video123/HLSPlaylist.m3u8',
      );
    },
  );
});

test('rejects a weak JSON response from another proxy before accepting a richer canonical source', { concurrency: false }, async () => {
  const path = '/r/test/new.json?limit=1';
  const cloudflareBase = 'https://cloudflare.fixture.invalid/api/reddit';
  const weakPayload = listing(post('weak-proxy', { media: {}, secure_media: {}, preview: {} }));
  const canonicalPayload = listing(post('canonical-rich', { selftext: 'Canonical body from the next source' }));

  await withFixtureFetch(
    (url) => {
      if (url === `${cloudflareBase}${path}`) {
        return Response.json(weakPayload);
      }

      if (url === `https://www.reddit.com${path}`) {
        return Response.json(canonicalPayload);
      }

      return null;
    },
    async (calls) => {
      const { handleRedditProxyRequest } = await importFreshProxy();
      const response = await handleRedditProxyRequest(
        path,
        { ENABLE_PUBLIC_INSTANCE_FALLBACK: 'false', ENABLE_LEGACY_SCRAPE_FALLBACK: 'false' },
        { cloudflareProxyBase: cloudflareBase, enableMirrorFallback: false },
      );
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.data.children[0].data.id, 'canonical-rich');
      assert.ok(calls.some(({ url }) => url === `${cloudflareBase}${path}`));
      assert.ok(calls.some(({ url }) => url === `https://www.reddit.com${path}`));
    },
  );
});

test('rejects an empty comment-thread JSON response before trying the canonical source', { concurrency: false }, async () => {
  const path = '/r/test/comments/detail1/fixture.json?raw_json=1';
  const cloudflareBase = 'https://cloudflare.fixture.invalid/api/reddit';
  const emptyThread = [listing(), listing()];
  const canonicalThread = [
    listing(
      post('detail1', {
        selftext: 'Canonical detail body',
        is_self: true,
      }),
    ),
    listing(),
  ];

  await withFixtureFetch(
    (url) => {
      if (url === `${cloudflareBase}${path}`) {
        return Response.json(emptyThread);
      }

      if (url === `https://www.reddit.com${path}`) {
        return Response.json(canonicalThread);
      }

      return null;
    },
    async (calls) => {
      const { handleRedditProxyRequest } = await importFreshProxy();
      const response = await handleRedditProxyRequest(
        path,
        { ENABLE_PUBLIC_INSTANCE_FALLBACK: 'false', ENABLE_LEGACY_SCRAPE_FALLBACK: 'false' },
        { cloudflareProxyBase: cloudflareBase, enableMirrorFallback: false },
      );
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload[0].data.children[0].data.id, 'detail1');
      assert.ok(calls.some(({ url }) => url === `${cloudflareBase}${path}`));
      assert.ok(calls.some(({ url }) => url === `https://www.reddit.com${path}`));
    },
  );
});

test('rejects a media-less comment-thread post even when comments contain text', { concurrency: false }, async () => {
  const path = '/r/test/comments/detail2/fixture.json?raw_json=1';
  const cloudflareBase = 'https://cloudflare.fixture.invalid/api/reddit';
  const weakThread = [
    listing(
      post('detail2', {
        media: {},
        secure_media: {},
        preview: {},
      }),
    ),
    {
      kind: 'Listing',
      data: {
        after: null,
        before: null,
        children: [{ kind: 't1', data: { id: 'comment1', body: 'A real comment on a weak post stub' } }],
      },
    },
  ];
  const canonicalThread = [
    listing(
      post('detail2', {
        selftext: 'Canonical detail body',
        is_self: true,
      }),
    ),
    listing(),
  ];

  await withFixtureFetch(
    (url) => {
      if (url === `${cloudflareBase}${path}`) {
        return Response.json(weakThread);
      }

      if (url === `https://www.reddit.com${path}`) {
        return Response.json(canonicalThread);
      }

      return null;
    },
    async (calls) => {
      const { handleRedditProxyRequest } = await importFreshProxy();
      const response = await handleRedditProxyRequest(
        path,
        { ENABLE_PUBLIC_INSTANCE_FALLBACK: 'false', ENABLE_LEGACY_SCRAPE_FALLBACK: 'false' },
        { cloudflareProxyBase: cloudflareBase, enableMirrorFallback: false },
      );
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload[0].data.children[0].data.selftext, 'Canonical detail body');
      assert.ok(calls.some(({ url }) => url === `${cloudflareBase}${path}`));
      assert.ok(calls.some(({ url }) => url === `https://www.reddit.com${path}`));
    },
  );
});

function htmlResponse(body) {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

const OLD_REDDIT_THING = `
  <div class="thing link" data-fullname="t3_htmlpost1" data-permalink="/r/test/comments/htmlpost1/html_title/"
    data-url="https://i.redd.it/html-image.jpg" data-domain="i.redd.it" data-subreddit="test"
    data-author="htmluser" data-timestamp="1700000000000" data-score="42" data-comments-count="7">
    <div class="entry">
      <p class="title"><a class="title may-blank" href="https://i.redd.it/html-image.jpg">HTML fixture title</a></p>
      <a class="thumbnail" href="https://i.redd.it/html-image.jpg"><img src="https://preview.redd.it/html-image.jpg" /></a>
      <a class="comments" href="/r/test/comments/htmlpost1/html_title/">7 comments</a>
    </div>
  </div>`;

test('auto-enables the old.reddit scrape path when OAuth is not configured', { concurrency: false }, async () => {
  await withFixtureFetch(
    (url) => (url === 'https://old.reddit.com/r/test?limit=50' ? htmlResponse(OLD_REDDIT_THING) : null),
    async (calls) => {
      const { handleRedditProxyRequest } = await importFreshProxy();
      const response = await handleRedditProxyRequest(TEST_PATH, {});
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-redalt-fallback'), 'old-reddit-html');
      assert.equal(payload.data.children[0].data.id, 'htmlpost1');
      assert.equal(payload.data.children[0].data.post_hint, 'image');
      assert.equal(
        calls.some(({ url }) => url === `https://www.reddit.com${TEST_PATH}`),
        false,
        'anonymous JSON endpoint should not be contacted in scrape mode',
      );
    },
  );
});

test('falls through when the scraped page has no parseable posts', { concurrency: false }, async () => {
  await withFixtureFetch(
    (url) => (url === 'https://old.reddit.com/r/test?limit=50' ? htmlResponse('<html>no posts here</html>') : null),
    async (calls) => {
      const { handleRedditProxyRequest } = await importFreshProxy();
      const response = await handleRedditProxyRequest(TEST_PATH, {});

      assert.equal(response.status, 502);
      assert.ok(
        calls.some(({ url }) => url === 'https://www.reddit.com/r/test.rss?limit=50'),
        'RSS should be tried after an unparseable scrape',
      );
    },
  );
});

test('returns a structured block response when old.reddit rejects the request', { concurrency: false }, async () => {
  await withFixtureFetch(
    (url) =>
      url.startsWith('https://old.reddit.com/')
        ? new Response('<body class="theme-beta">blocked page</body>', { status: 403 })
        : null,
    async (calls) => {
      const { handleRedditProxyRequest } = await importFreshProxy();
      const response = await handleRedditProxyRequest(TEST_PATH, {});
      const payload = await response.json();

      assert.equal(response.status, 403);
      assert.equal(payload.error, 'blocked');
      assert.equal(
        calls.some(({ url }) => url === `https://www.reddit.com${TEST_PATH}`),
        false,
        'no further Reddit-owned requests should follow a WAF block',
      );
    },
  );
});

test('maps subreddit discovery to the old.reddit search page', { concurrency: false }, async () => {
  const html = '<html><body><a href="/r/cats">cats</a><a href="/r/CatPics">cat pics</a></body></html>';

  await withFixtureFetch(
    (url) => (url === 'https://old.reddit.com/subreddits/search?q=cat&limit=12' ? htmlResponse(html) : null),
    async () => {
      const { handleRedditProxyRequest } = await importFreshProxy();
      const response = await handleRedditProxyRequest('/subreddits/search.json?raw_json=1&include_over_18=on&limit=12&q=cat', {});
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-redalt-fallback'), 'old-reddit-html');
      assert.deepEqual(
        payload.data.children.map((child) => child.data.display_name),
        ['cats', 'CatPics'],
      );
    },
  );
});

test('maps user discovery to the old.reddit users search page', { concurrency: false }, async () => {
  const html = '<html><body><a href="/user/cat_user">cat_user</a></body></html>';

  await withFixtureFetch(
    (url) => (url === 'https://old.reddit.com/users/search?q=cat&limit=12' ? htmlResponse(html) : null),
    async () => {
      const { handleRedditProxyRequest } = await importFreshProxy();
      const response = await handleRedditProxyRequest('/users/search.json?raw_json=1&include_over_18=on&limit=12&q=cat', {});
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.data.children[0].data.name, 'cat_user');
    },
  );
});
