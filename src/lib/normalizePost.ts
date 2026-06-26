import type {
  GalleryItem,
  NormalizedPost,
  RedditImageSource,
  RedditMedia,
  RedditPostData,
} from '../types/reddit';

function normalizeUrl(url: string | undefined): string {
  return (url ?? '').replace(/&amp;/g, '&');
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&#(?:x20|32);/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function getSourceUrl(source: RedditImageSource | undefined): string {
  if (!source) {
    return '';
  }

  return fullSizeRedditImageUrl(normalizeUrl(source.url || source.u));
}

function getUrlHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function getUrlPathname(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return url.split('?')[0].toLowerCase();
  }
}

function fullSizeRedditImageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const previewMatch = pathname.match(/^\/preview\/pre\/(.+)$/i);

    if (previewMatch) {
      return `${parsed.origin}/img/${previewMatch[1]}`;
    }

    if (parsed.hostname.toLowerCase() === 'preview.redd.it') {
      const imageName = pathname.split('/').filter(Boolean).at(-1);
      return imageName ? `https://i.redd.it/${imageName}` : url;
    }
  } catch {
    // Use the original value when parsing fails.
  }

  return url;
}

function getBestImage(source: RedditImageSource | undefined, fallbackUrl: string): {
  url: string;
  width?: number;
  height?: number;
} {
  const url = fullSizeRedditImageUrl(getSourceUrl(source) || fallbackUrl);

  return {
    url,
    width: source?.width ?? source?.x,
    height: source?.height ?? source?.y,
  };
}

function normalizeEmbedHtml(html: string | undefined): string | undefined {
  const normalized = decodeBasicEntities(html ?? '').trim();
  return normalized || undefined;
}

function parseEmbedUrl(html: string | undefined): string | undefined {
  if (!html) {
    return undefined;
  }

  const match = normalizeEmbedHtml(html)?.match(/<iframe[^>]*src=["']([^"']+)["']/i);
  return match?.[1];
}

function buildGalleryItems(post: RedditPostData): GalleryItem[] {
  if (!post.is_gallery || !post.gallery_data?.items || !post.media_metadata) {
    return [];
  }

  const items: GalleryItem[] = [];

  for (const item of post.gallery_data.items) {
    const media = post.media_metadata?.[item.media_id];
    const source = media?.s;
    const previewSource = media?.p?.[media.p.length - 1];
    const resolvedSource = source?.url || source?.u ? source : previewSource;
    const resolvedUrl = getSourceUrl(resolvedSource);

    if (!resolvedUrl) {
      continue;
    }

    items.push({
      id: item.media_id,
      url: resolvedUrl,
      mimeType: media?.m,
      width: resolvedSource?.width ?? resolvedSource?.x,
      height: resolvedSource?.height ?? resolvedSource?.y,
    });
  }

  return items;
}

function deriveRedditVideoFromUrl(post: RedditPostData) {
  const outboundUrl = normalizeUrl(post.url_overridden_by_dest ?? post.url);

  if (!outboundUrl) {
    return null;
  }

  try {
    const parsed = new URL(outboundUrl);
    const hostname = parsed.hostname.toLowerCase();
    const vRedditId = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    const redditVideoId = parsed.pathname.match(/^\/video\/([^/?#]+)/i)?.[1] ?? '';
    const videoId = hostname === 'v.redd.it' ? vRedditId : hostname.endsWith('reddit.com') ? redditVideoId : '';

    if (!videoId) {
      return null;
    }

    const previewSource = getPreviewImage(post);
    const hlsUrl = `https://v.redd.it/${videoId}/HLSPlaylist.m3u8`;

    return {
      type: 'video' as const,
      sourceUrl: hlsUrl,
      hlsUrl,
      dashUrl: `https://v.redd.it/${videoId}/DASHPlaylist.mpd`,
      width: previewSource?.width ?? previewSource?.x,
      height: previewSource?.height ?? previewSource?.y,
      isGif: false,
    };
  } catch {
    return null;
  }
}

function shouldPreferHlsSource(fallbackUrl: string | undefined, hlsUrl: string | undefined): boolean {
  if (!hlsUrl) {
    return false;
  }

  if (!fallbackUrl) {
    return true;
  }

  const pathname = getUrlPathname(fallbackUrl);
  return pathname.includes('/vid/') && !/\.(?:mp4|webm|mov|m4v)(?:$|\?)/i.test(pathname);
}

function getVideoMedia(post: RedditPostData, includePreviewMp4 = true) {
  const media: RedditMedia | null | undefined = post.secure_media ?? post.media;
  const redditVideo = media?.reddit_video;
  const fallbackUrl = normalizeUrl(redditVideo?.fallback_url);
  const hlsUrl = normalizeUrl(redditVideo?.hls_url);
  const preferredSourceUrl = shouldPreferHlsSource(fallbackUrl, hlsUrl) ? hlsUrl : fallbackUrl || hlsUrl;

  if (preferredSourceUrl || hlsUrl) {
    return {
      type: 'video' as const,
      sourceUrl: preferredSourceUrl || hlsUrl,
      hlsUrl,
      dashUrl: normalizeUrl(redditVideo?.dash_url),
      width: redditVideo?.width,
      height: redditVideo?.height,
      isGif: redditVideo?.is_gif,
    };
  }
  const derivedVideo = deriveRedditVideoFromUrl(post);

  if (derivedVideo) {
    return derivedVideo;
  }

  const previewMp4 = includePreviewMp4 ? post.preview?.images?.[0]?.variants?.mp4?.source : undefined;

  if (previewMp4?.url) {
    return {
      type: 'video' as const,
      sourceUrl: normalizeUrl(previewMp4.url),
      width: previewMp4.width,
      height: previewMp4.height,
      isGif: true,
    };
  }

  return null;
}

function isLikelyImageUrl(url: string): boolean {
  const hostname = getUrlHostname(url);
  const pathname = getUrlPathname(url);

  return (
    /\.(png|jpe?g|webp|gif|avif)$/i.test(pathname) ||
    ((hostname === 'i.redd.it' || hostname === 'preview.redd.it' || hostname.endsWith('redditmedia.com')) &&
      !pathname.endsWith('.mp4'))
  );
}

function isLikelyThumbnailUrl(url: string | undefined): url is string {
  const normalized = normalizeUrl(url);

  return (
    Boolean(normalized) &&
    !['default', 'self', 'nsfw', 'spoiler', 'image', ''].includes(normalized.toLowerCase()) &&
    /^https?:\/\//i.test(normalized)
  );
}

function getPreviewImage(post: RedditPostData): RedditImageSource | undefined {
  return post.preview?.images?.[0]?.source;
}

function getThumbnailUrl(post: RedditPostData): string {
  const previewUrl = getSourceUrl(getPreviewImage(post));

  if (previewUrl) {
    return previewUrl;
  }

  return isLikelyThumbnailUrl(post.thumbnail) ? fullSizeRedditImageUrl(normalizeUrl(post.thumbnail)) : '';
}

function isHostedVideoPost(post: RedditPostData): boolean {
  return Boolean(post.is_video || post.post_hint === 'hosted:video');
}

function isRedditMediaHost(hostname: string): boolean {
  return (
    hostname === 'i.redd.it' ||
    hostname === 'preview.redd.it' ||
    hostname === 'v.redd.it' ||
    hostname.endsWith('.redd.it') ||
    hostname.endsWith('redditmedia.com') ||
    hostname.endsWith('reddit.com')
  );
}

function getCurrentEmbedParentHost(): string {
  if (typeof window === 'undefined') {
    return 'www.reddit.com';
  }

  return window.location.hostname || 'localhost';
}

function buildYouTubeEmbed(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    let id = '';

    if (hostname.includes('youtu.be')) {
      id = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    } else if (hostname.includes('youtube.com')) {
      id =
        parsed.searchParams.get('v') ??
        parsed.pathname.match(/\/(?:embed|shorts)\/([^/?]+)/i)?.[1] ??
        '';
    }

    return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}` : undefined;
  } catch {
    return undefined;
  }
}

function buildVimeoEmbed(url: string): string | undefined {
  try {
    const parsed = new URL(url);

    if (!parsed.hostname.toLowerCase().includes('vimeo.com')) {
      return undefined;
    }

    const id = parsed.pathname.match(/\/(\d+)/)?.[1] ?? '';
    return id ? `https://player.vimeo.com/video/${id}` : undefined;
  } catch {
    return undefined;
  }
}

function buildRedgifsEmbed(url: string): string | undefined {
  try {
    const parsed = new URL(url);

    if (!parsed.hostname.toLowerCase().includes('redgifs.com')) {
      return undefined;
    }

    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const id =
      parsed.pathname.match(/\/(?:watch|ifr|gifs\/detail)\/([^/?#]+)/i)?.[1] ??
      (pathParts.length === 1 ? pathParts[0] : '');

    return id ? `https://www.redgifs.com/ifr/${encodeURIComponent(id)}` : undefined;
  } catch {
    return undefined;
  }
}

function buildTikTokEmbed(url: string): string | undefined {
  try {
    const parsed = new URL(url);

    if (!parsed.hostname.toLowerCase().includes('tiktok.com')) {
      return undefined;
    }

    const id =
      parsed.pathname.match(/\/(?:@[^/]+\/video|v)\/(\d+)/i)?.[1] ??
      parsed.pathname.match(/\/embed\/v2\/(\d+)/i)?.[1] ??
      '';

    return id ? `https://www.tiktok.com/embed/v2/${id}` : undefined;
  } catch {
    return undefined;
  }
}

function buildInstagramEmbed(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    if (!hostname.includes('instagram.com') && !hostname.includes('instagr.am')) {
      return undefined;
    }

    const match = parsed.pathname.match(/\/(p|reel|tv)\/([^/?#]+)/i);

    if (!match?.[1] || !match[2]) {
      return undefined;
    }

    return `https://www.instagram.com/${match[1].toLowerCase()}/${match[2]}/embed/captioned/`;
  } catch {
    return undefined;
  }
}

function buildTwitterEmbed(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    if (!hostname.includes('twitter.com') && hostname !== 'x.com' && !hostname.endsWith('.x.com')) {
      return undefined;
    }

    const id = parsed.pathname.match(/\/status\/(\d+)/i)?.[1] ?? '';
    return id ? `https://platform.twitter.com/embed/Tweet.html?id=${id}&dnt=true` : undefined;
  } catch {
    return undefined;
  }
}

function buildStreamableEmbed(url: string): string | undefined {
  try {
    const parsed = new URL(url);

    if (!parsed.hostname.toLowerCase().includes('streamable.com')) {
      return undefined;
    }

    const id = parsed.pathname.split('/').filter(Boolean).at(-1) ?? '';
    return id ? `https://streamable.com/e/${encodeURIComponent(id)}` : undefined;
  } catch {
    return undefined;
  }
}

function buildDailymotionEmbed(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    let id = '';

    if (hostname === 'dai.ly') {
      id = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    } else if (hostname.includes('dailymotion.com')) {
      id = parsed.pathname.match(/\/(?:video|embed\/video)\/([^/?#]+)/i)?.[1] ?? '';
    }

    return id ? `https://www.dailymotion.com/embed/video/${id}` : undefined;
  } catch {
    return undefined;
  }
}

function buildSpotifyEmbed(url: string): string | undefined {
  try {
    const parsed = new URL(url);

    if (!parsed.hostname.toLowerCase().includes('spotify.com')) {
      return undefined;
    }

    const segments = parsed.pathname.split('/').filter(Boolean);

    if (segments.length < 2) {
      return undefined;
    }

    const embedSegments = segments[0] === 'embed' ? segments : ['embed', ...segments];
    return `https://open.spotify.com/${embedSegments.join('/')}`;
  } catch {
    return undefined;
  }
}

function buildSoundCloudEmbed(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    if (!hostname.includes('soundcloud.com') && !hostname.includes('sndcdn.com')) {
      return undefined;
    }

    return `https://w.soundcloud.com/player/?url=${encodeURIComponent(parsed.toString())}`;
  } catch {
    return undefined;
  }
}

function buildLoomEmbed(url: string): string | undefined {
  try {
    const parsed = new URL(url);

    if (!parsed.hostname.toLowerCase().includes('loom.com')) {
      return undefined;
    }

    const match = parsed.pathname.match(/\/(?:share|embed)\/([^/?#]+)/i);
    return match?.[1] ? `https://www.loom.com/embed/${match[1]}` : undefined;
  } catch {
    return undefined;
  }
}

function buildImgurEmbed(url: string): string | undefined {
  try {
    const parsed = new URL(url);

    if (!parsed.hostname.toLowerCase().includes('imgur.com')) {
      return undefined;
    }

    const id = parsed.pathname.match(/\/(?:gallery\/|a\/)?([^/?#.]+)/i)?.[1] ?? '';
    return id ? `https://imgur.com/${id}/embed?pub=true` : undefined;
  } catch {
    return undefined;
  }
}

function buildGfycatEmbed(url: string): string | undefined {
  try {
    const parsed = new URL(url);

    if (!parsed.hostname.toLowerCase().includes('gfycat.com')) {
      return undefined;
    }

    const id = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    return id ? `https://gfycat.com/ifr/${encodeURIComponent(id)}` : undefined;
  } catch {
    return undefined;
  }
}

function buildTwitchEmbed(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const parent = encodeURIComponent(getCurrentEmbedParentHost());

    if (hostname === 'clips.twitch.tv') {
      const clipSlug = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
      return clipSlug ? `https://clips.twitch.tv/embed?clip=${clipSlug}&parent=${parent}` : undefined;
    }

    if (!hostname.includes('twitch.tv')) {
      return undefined;
    }

    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const videoId = parsed.pathname.match(/\/videos\/(\d+)/i)?.[1] ?? '';

    if (videoId) {
      return `https://player.twitch.tv/?video=v${videoId}&parent=${parent}`;
    }

    const clipSlug = parsed.pathname.match(/\/clip\/([^/?#]+)/i)?.[1] ?? '';

    if (clipSlug) {
      return `https://clips.twitch.tv/embed?clip=${clipSlug}&parent=${parent}`;
    }

    const channel = pathParts[0]?.toLowerCase() ?? '';
    const reservedSegments = new Set([
      'clip',
      'collections',
      'dashboard',
      'directory',
      'downloads',
      'jobs',
      'login',
      'messages',
      'moderator',
      'p',
      'payments',
      'popout',
      'prime',
      'products',
      'settings',
      'store',
      'subscriptions',
      'turbo',
      'videos',
      'wallet',
    ]);

    return channel && !reservedSegments.has(channel)
      ? `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=${parent}`
      : undefined;
  } catch {
    return undefined;
  }
}

function inferProviderName(url: string | undefined): string | undefined {
  const hostname = getUrlHostname(url ?? '');

  if (!hostname) {
    return undefined;
  }

  if (hostname.includes('youtube') || hostname.includes('youtu.be')) {
    return 'YouTube';
  }

  if (hostname.includes('vimeo')) {
    return 'Vimeo';
  }

  if (hostname.includes('redgifs')) {
    return 'Redgifs';
  }

  if (hostname.includes('tiktok')) {
    return 'TikTok';
  }

  if (hostname.includes('instagram') || hostname.includes('instagr.am')) {
    return 'Instagram';
  }

  if (hostname.includes('twitter.com') || hostname === 'x.com' || hostname.endsWith('.x.com')) {
    return 'X';
  }

  if (hostname.includes('twitch.tv')) {
    return 'Twitch';
  }

  if (hostname.includes('streamable')) {
    return 'Streamable';
  }

  if (hostname.includes('dailymotion') || hostname === 'dai.ly') {
    return 'Dailymotion';
  }

  if (hostname.includes('spotify')) {
    return 'Spotify';
  }

  if (hostname.includes('soundcloud')) {
    return 'SoundCloud';
  }

  if (hostname.includes('loom.com')) {
    return 'Loom';
  }

  if (hostname.includes('imgur.com')) {
    return 'Imgur';
  }

  if (hostname.includes('gfycat.com')) {
    return 'Gfycat';
  }

  const stripped = hostname.replace(/^www\./, '');
    const [first] = stripped.split('.');
  return first ? `${first.charAt(0).toUpperCase()}${first.slice(1)}` : undefined;
}

function buildKnownEmbed(url: string): { provider: string; embedUrl: string } | null {
  const builders = [
    ['YouTube', buildYouTubeEmbed],
    ['Vimeo', buildVimeoEmbed],
    ['Redgifs', buildRedgifsEmbed],
    ['TikTok', buildTikTokEmbed],
    ['Instagram', buildInstagramEmbed],
    ['X', buildTwitterEmbed],
    ['Twitch', buildTwitchEmbed],
    ['Streamable', buildStreamableEmbed],
    ['Dailymotion', buildDailymotionEmbed],
    ['Spotify', buildSpotifyEmbed],
    ['SoundCloud', buildSoundCloudEmbed],
    ['Loom', buildLoomEmbed],
    ['Imgur', buildImgurEmbed],
    ['Gfycat', buildGfycatEmbed],
  ] as const;

  for (const [provider, build] of builders) {
    const embedUrl = build(url);

    if (embedUrl) {
      return { provider, embedUrl };
    }
  }

  return null;
}

function shouldPreferKnownEmbedUrl(parsedEmbedUrl: string | undefined, outboundUrl: string, knownEmbedUrl: string | undefined): boolean {
  if (!parsedEmbedUrl || !knownEmbedUrl) {
    return false;
  }

  const parsedHost = getUrlHostname(parsedEmbedUrl);
  const outboundHost = getUrlHostname(outboundUrl);

  return Boolean(
    parsedHost &&
      outboundHost &&
      (parsedHost.endsWith('redditmedia.com') || parsedHost.endsWith('reddit.com')) &&
      !isRedditMediaHost(outboundHost),
  );
}

function stripSubmissionBoilerplate(value: string): string {
  return decodeBasicEntities(value)
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(
          /\s*submitted\s+by\s+\/?u\/[A-Za-z0-9_-]+(?:\s+to\s+\/?r\/[A-Za-z0-9_]+)?(?:\s+\[[^\]]+\])*\s*$/i,
          '',
        )
        .trim(),
    )
    .filter((line) => line && !/^submitted\b/i.test(line))
    .join('\n\n');
}

function normalizeAuthor(value: string): string {
  return value.trim().replace(/^\/?u\//i, '') || '[unknown]';
}

function getPostEmbedContent(post: RedditPostData, oembedHtml: string | undefined): {
  embedHtml?: string;
  embedWidth?: number;
  embedHeight?: number;
} {
  const secureEmbed = post.secure_media_embed;
  const mediaEmbed = post.media_embed;
  const embedHtml =
    normalizeEmbedHtml(oembedHtml) ??
    normalizeEmbedHtml(secureEmbed?.content) ??
    normalizeEmbedHtml(mediaEmbed?.content);
  const embedWidth = post.secure_media?.oembed?.width ?? post.media?.oembed?.width ?? secureEmbed?.width ?? mediaEmbed?.width;
  const embedHeight =
    post.secure_media?.oembed?.height ?? post.media?.oembed?.height ?? secureEmbed?.height ?? mediaEmbed?.height;

  return {
    embedHtml,
    embedWidth,
    embedHeight,
  };
}

function getExternalMedia(post: RedditPostData) {
  const media: RedditMedia | null | undefined = post.secure_media ?? post.media;
  const oembed = media?.oembed;
  const outboundUrl = normalizeUrl(post.url_overridden_by_dest ?? post.url);
  const domain = post.domain?.toLowerCase() || getUrlHostname(outboundUrl);
  const knownEmbed = buildKnownEmbed(outboundUrl);
  const { embedHtml, embedWidth, embedHeight } = getPostEmbedContent(post, oembed?.html);
  const parsedEmbedUrl = parseEmbedUrl(embedHtml);
  const embedUrl = shouldPreferKnownEmbedUrl(parsedEmbedUrl, outboundUrl, knownEmbed?.embedUrl)
    ? knownEmbed?.embedUrl
    : parsedEmbedUrl || knownEmbed?.embedUrl;
  const thumbnailUrl = normalizeUrl(oembed?.thumbnail_url) || getThumbnailUrl(post);

  const isExternalDomain = domain.length > 0 && !isRedditMediaHost(domain) && !isLikelyImageUrl(outboundUrl);

  if (!isExternalDomain && !embedUrl && !embedHtml && post.post_hint !== 'rich:video') {
    return null;
  }

  return {
    type: 'external' as const,
    outboundUrl,
    provider: oembed?.provider_name || knownEmbed?.provider || inferProviderName(embedUrl || outboundUrl),
    embedHtml,
    embedUrl,
    thumbnailUrl,
    embedWidth,
    embedHeight,
  };
}

function isRedgifsExternalEmbed(
  external: ReturnType<typeof getExternalMedia> | null | undefined,
): boolean {
  if (!external?.embedUrl && !external?.embedHtml) {
    return false;
  }

  const providerValue = `${external.provider ?? ''} ${external.embedUrl ?? ''} ${external.outboundUrl}`.toLowerCase();
  return providerValue.includes('redgifs');
}

export function normalizePost(post: RedditPostData): NormalizedPost {
  const outboundUrl = normalizeUrl(post.url_overridden_by_dest ?? post.url);
  const imageSource = getPreviewImage(post);
  const thumbnailUrl = getThumbnailUrl(post);

  let media: NormalizedPost['media'];

  if (post.is_self) {
    media = { type: 'text' };
  } else {
    const galleryItems = buildGalleryItems(post);

    if (galleryItems.length > 0) {
      media = { type: 'gallery', items: galleryItems };
    } else {
      const external = getExternalMedia(post);

      if (external && isRedgifsExternalEmbed(external)) {
        media = external;
      } else {
        const video = getVideoMedia(post, !(external?.embedUrl || external?.embedHtml));

        if (video) {
          media = video;
        } else if (external) {
          media = external;
        } else {
          const canUseImageFallback = !isHostedVideoPost(post);
          const imageFallbackUrl = canUseImageFallback
            ? (isLikelyImageUrl(outboundUrl) ? outboundUrl : thumbnailUrl)
            : '';

          if (
            canUseImageFallback &&
            (imageSource?.url || imageSource?.u || imageFallbackUrl || post.post_hint === 'image')
          ) {
            media = {
              type: 'image',
              ...getBestImage(imageSource, imageFallbackUrl || outboundUrl),
            };
          } else {
            media = { type: 'link', outboundUrl };
          }
        }
      }
    }
  }

  return {
    id: post.id,
    name: post.name,
    title: post.title,
    author: normalizeAuthor(post.author),
    flairText: post.link_flair_text?.trim() || undefined,
    subreddit: post.subreddit,
    permalink: post.permalink,
    score: post.score,
    numComments: post.num_comments,
    createdUtc: post.created_utc,
    selfText: stripSubmissionBoilerplate(post.selftext ?? ''),
    isNsfw: post.over_18,
    outboundUrl,
    media,
  };
}

