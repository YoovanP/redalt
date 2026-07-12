import type {
  GalleryItem,
  NormalizedPost,
  RedditImageSource,
  RedditMedia,
  RedditPostData,
  RedditVideo,
} from '../types/reddit';

const TRUSTED_EMBED_HOSTS = [
  'youtube.com',
  'youtube-nocookie.com',
  'youtu.be',
  'vimeo.com',
  'redgifs.com',
  'reddit.com',
  'redditmedia.com',
  'instagram.com',
  'instagr.am',
  'tiktok.com',
  'twitter.com',
  'x.com',
  'twitch.tv',
  'streamable.com',
  'dailymotion.com',
  'spotify.com',
  'soundcloud.com',
  'loom.com',
  'imgur.com',
  'gfycat.com',
] as const;

function hostMatches(hostname: string, expectedHost: string): boolean {
  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.+$/g, '');
  const normalizedExpectedHost = expectedHost.trim().toLowerCase().replace(/^\.+|\.+$/g, '');

  return Boolean(
    normalizedHostname &&
      normalizedExpectedHost &&
      (normalizedHostname === normalizedExpectedHost || normalizedHostname.endsWith(`.${normalizedExpectedHost}`)),
  );
}

export function isTrustedEmbedUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return url.protocol === 'https:' && TRUSTED_EMBED_HOSTS.some((host) => hostMatches(url.hostname, host));
  } catch {
    return false;
  }
}

function normalizeUrl(url: unknown): string {
  return typeof url === 'string' ? url.replace(/&amp;/g, '&').trim() : '';
}

function getPostOutboundUrl(post: RedditPostData): string {
  return normalizeUrl(post.url_overridden_by_dest) || normalizeUrl(post.url);
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

function getBestImage(source: RedditImageSource | undefined, fallbackUrl: string, preferFallback = false): {
  url: string;
  width?: number;
  height?: number;
} {
  const sourceUrl = getSourceUrl(source);
  const url = fullSizeRedditImageUrl((preferFallback ? fallbackUrl : sourceUrl) || sourceUrl || fallbackUrl);

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
  if (!post.gallery_data?.items?.length || !post.media_metadata) {
    return [];
  }

  const items: GalleryItem[] = [];

  for (const item of post.gallery_data.items) {
    const media = post.media_metadata?.[item.media_id];
    const source = media?.s;
    const previewSource = media?.p?.[media.p.length - 1];
    const resolvedSource = source?.url || source?.u ? source : previewSource;
    const resolvedUrl = getSourceUrl(resolvedSource);
    const animatedUrl = fullSizeRedditImageUrl(normalizeUrl(source?.gif));
    const mp4Url = normalizeUrl(source?.mp4);
    const dashUrl = normalizeUrl(source?.dashUrl || source?.dash_url || media?.dashUrl || media?.dash_url);
    const hlsUrl =
      normalizeUrl(source?.hlsUrl || source?.hls_url || media?.hlsUrl || media?.hls_url) ||
      deriveHlsUrlFromDash(dashUrl);
    const width = source?.width ?? source?.x ?? media?.x ?? resolvedSource?.width ?? resolvedSource?.x;
    const height = source?.height ?? source?.y ?? media?.y ?? resolvedSource?.height ?? resolvedSource?.y;
    const caption = readString(item.caption) || undefined;
    const outboundUrl = normalizeUrl(item.outbound_url) || undefined;
    const mediaKind = readString(media?.e).toLowerCase();
    const mediaMimeType = readString(media?.m).toLowerCase();
    const isAnimated = mediaKind === 'animatedimage' || mediaMimeType === 'image/gif';
    const isVideo =
      mediaKind === 'redditvideo' ||
      mediaMimeType.startsWith('video/') ||
      Boolean(mp4Url || hlsUrl || dashUrl);
    const videoSourceUrl = mp4Url || hlsUrl || dashUrl;

    if (videoSourceUrl && (isAnimated || isVideo)) {
      items.push({
        id: item.media_id,
        type: 'video',
        sourceUrl: videoSourceUrl,
        hlsUrl: hlsUrl || undefined,
        dashUrl: dashUrl || undefined,
        mimeType: mp4Url ? 'video/mp4' : dashUrl && !hlsUrl ? 'application/dash+xml' : undefined,
        posterUrl: resolvedUrl || undefined,
        width,
        height,
        isGif: isAnimated,
        caption,
        outboundUrl,
      });
      continue;
    }

    const imageUrl = animatedUrl || resolvedUrl;

    if (imageUrl) {
      items.push({
        id: item.media_id,
        type: 'image',
        url: imageUrl,
        mimeType: animatedUrl ? 'image/gif' : mediaMimeType || undefined,
        width,
        height,
        caption,
        outboundUrl,
      });
    }
  }

  return items;
}

function deriveHlsUrlFromDash(dashUrl: string): string {
  return /DASHPlaylist\.mpd/i.test(dashUrl)
    ? dashUrl.replace(/DASHPlaylist\.mpd/i, 'HLSPlaylist.m3u8')
    : '';
}

function deriveRedditVideoFromUrl(post: RedditPostData) {
  const outboundUrl = getPostOutboundUrl(post);

  if (!outboundUrl) {
    return null;
  }

  try {
    const parsed = new URL(outboundUrl);
    const hostname = parsed.hostname.toLowerCase();
    const vRedditId = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    const redditVideoId = parsed.pathname.match(/^\/video\/([^/?#]+)/i)?.[1] ?? '';
    const videoId = hostname === 'v.redd.it' ? vRedditId : hostMatches(hostname, 'reddit.com') ? redditVideoId : '';

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
      posterUrl: getThumbnailUrl(post) || undefined,
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

function getVideoMimeType(url: string): string | undefined {
  const pathname = getUrlPathname(url);

  if (/\.webm$/i.test(pathname)) {
    return 'video/webm';
  }

  if (/\.ogv$/i.test(pathname)) {
    return 'video/ogg';
  }

  if (/\.mov$/i.test(pathname)) {
    return 'video/quicktime';
  }

  if (/\.(?:mp4|m4v|gifv)$/i.test(pathname)) {
    return 'video/mp4';
  }

  return undefined;
}

function isLikelyVideoUrl(url: string): boolean {
  return /\.(?:mp4|webm|mov|m4v|ogv|gifv|m3u8)$/i.test(getUrlPathname(url));
}

function normalizeRedditVideo(video: RedditVideo | undefined, posterUrl?: string) {
  if (!video) {
    return null;
  }

  const fallbackUrl = normalizeUrl(video.fallback_url);
  const hlsUrl = normalizeUrl(video.hls_url);
  const preferredSourceUrl = shouldPreferHlsSource(fallbackUrl, hlsUrl) ? hlsUrl : fallbackUrl || hlsUrl;

  if (!preferredSourceUrl) {
    return null;
  }

  return {
    type: 'video' as const,
    sourceUrl: preferredSourceUrl,
    hlsUrl: hlsUrl || undefined,
    dashUrl: normalizeUrl(video.dash_url) || undefined,
    mimeType: hlsUrl === preferredSourceUrl ? undefined : getVideoMimeType(preferredSourceUrl),
    posterUrl: posterUrl || undefined,
    width: video.width,
    height: video.height,
    isGif: video.is_gif,
  };
}

function getDirectVideoMedia(post: RedditPostData) {
  const outboundUrl = getPostOutboundUrl(post);

  if (!outboundUrl || !isLikelyVideoUrl(outboundUrl)) {
    return null;
  }

  const sourceUrl = /\.gifv(?:[?#]|$)/i.test(outboundUrl)
    ? outboundUrl.replace(/\.gifv(?=[?#]|$)/i, '.mp4')
    : outboundUrl;
  const hlsUrl = /\.m3u8(?:[?#]|$)/i.test(sourceUrl) ? sourceUrl : undefined;
  const previewSource = getPreviewImage(post);

  return {
    type: 'video' as const,
    sourceUrl,
    hlsUrl,
    mimeType: hlsUrl ? undefined : getVideoMimeType(sourceUrl),
    posterUrl: getThumbnailUrl(post) || undefined,
    width: previewSource?.width ?? previewSource?.x,
    height: previewSource?.height ?? previewSource?.y,
    isGif: /\.gifv(?:[?#]|$)/i.test(outboundUrl),
  };
}

function getVideoMedia(post: RedditPostData, includePreviewMp4 = true) {
  const posterUrl = getThumbnailUrl(post);
  const normalizedRedditVideo =
    normalizeRedditVideo(post.secure_media?.reddit_video, posterUrl) ??
    normalizeRedditVideo(post.media?.reddit_video, posterUrl);

  if (normalizedRedditVideo) {
    return normalizedRedditVideo;
  }

  const derivedVideo = deriveRedditVideoFromUrl(post);

  if (derivedVideo) {
    return derivedVideo;
  }

  const directVideo = getDirectVideoMedia(post);

  if (directVideo) {
    return directVideo;
  }

  if (!includePreviewMp4) {
    return null;
  }

  const redditVideoPreview = normalizeRedditVideo(post.preview?.reddit_video_preview, posterUrl);

  if (redditVideoPreview) {
    return redditVideoPreview;
  }

  const previewMp4 = post.preview?.images?.[0]?.variants?.mp4?.source;
  const previewMp4Url = normalizeUrl(previewMp4?.url || previewMp4?.u);

  if (previewMp4Url) {
    return {
      type: 'video' as const,
      sourceUrl: previewMp4Url,
      mimeType: 'video/mp4',
      posterUrl: getThumbnailUrl(post) || undefined,
      width: previewMp4?.width,
      height: previewMp4?.height,
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
    ((hostname === 'i.redd.it' || hostname === 'preview.redd.it' || hostMatches(hostname, 'redditmedia.com')) &&
      !isLikelyVideoUrl(url))
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
    hostMatches(hostname, 'redd.it') ||
    hostMatches(hostname, 'redditmedia.com') ||
    hostMatches(hostname, 'reddit.com')
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

    if (hostMatches(hostname, 'youtu.be')) {
      id = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    } else if (hostMatches(hostname, 'youtube.com') || hostMatches(hostname, 'youtube-nocookie.com')) {
      id =
        parsed.searchParams.get('v') ??
        parsed.pathname.match(/\/(?:embed|shorts|live)\/([^/?]+)/i)?.[1] ??
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

    if (!hostMatches(parsed.hostname, 'vimeo.com')) {
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

    if (!hostMatches(parsed.hostname, 'redgifs.com')) {
      return undefined;
    }

    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const matchedId =
      parsed.pathname.match(/\/(?:watch|ifr|gifs\/detail)\/([^/?#]+)/i)?.[1] ??
      '';
    const singleSlug = pathParts.length === 1 && !/\.[a-z0-9]+$/i.test(pathParts[0]) ? pathParts[0] : '';
    const id = matchedId || singleSlug;

    return id ? `https://www.redgifs.com/ifr/${encodeURIComponent(id)}` : undefined;
  } catch {
    return undefined;
  }
}

function buildTikTokEmbed(url: string): string | undefined {
  try {
    const parsed = new URL(url);

    if (!hostMatches(parsed.hostname, 'tiktok.com')) {
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

    if (!hostMatches(hostname, 'instagram.com') && !hostMatches(hostname, 'instagr.am')) {
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

    if (!hostMatches(hostname, 'twitter.com') && !hostMatches(hostname, 'x.com')) {
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

    if (!hostMatches(parsed.hostname, 'streamable.com')) {
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

    if (hostMatches(hostname, 'dai.ly')) {
      id = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    } else if (hostMatches(hostname, 'dailymotion.com')) {
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

    if (!hostMatches(parsed.hostname, 'spotify.com')) {
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

    if (!hostMatches(hostname, 'soundcloud.com') && !hostMatches(hostname, 'sndcdn.com')) {
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

    if (!hostMatches(parsed.hostname, 'loom.com')) {
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

    if (!hostMatches(parsed.hostname, 'imgur.com')) {
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

    if (!hostMatches(parsed.hostname, 'gfycat.com')) {
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

    if (!hostMatches(hostname, 'twitch.tv')) {
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

  if (
    hostMatches(hostname, 'youtube.com') ||
    hostMatches(hostname, 'youtube-nocookie.com') ||
    hostMatches(hostname, 'youtu.be')
  ) {
    return 'YouTube';
  }

  if (hostMatches(hostname, 'vimeo.com')) {
    return 'Vimeo';
  }

  if (hostMatches(hostname, 'redgifs.com')) {
    return 'Redgifs';
  }

  if (hostMatches(hostname, 'tiktok.com')) {
    return 'TikTok';
  }

  if (hostMatches(hostname, 'instagram.com') || hostMatches(hostname, 'instagr.am')) {
    return 'Instagram';
  }

  if (hostMatches(hostname, 'twitter.com') || hostMatches(hostname, 'x.com')) {
    return 'X';
  }

  if (hostMatches(hostname, 'twitch.tv')) {
    return 'Twitch';
  }

  if (hostMatches(hostname, 'streamable.com')) {
    return 'Streamable';
  }

  if (hostMatches(hostname, 'dailymotion.com') || hostMatches(hostname, 'dai.ly')) {
    return 'Dailymotion';
  }

  if (hostMatches(hostname, 'spotify.com')) {
    return 'Spotify';
  }

  if (hostMatches(hostname, 'soundcloud.com')) {
    return 'SoundCloud';
  }

  if (hostMatches(hostname, 'loom.com')) {
    return 'Loom';
  }

  if (hostMatches(hostname, 'imgur.com')) {
    return 'Imgur';
  }

  if (hostMatches(hostname, 'gfycat.com')) {
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
      (hostMatches(parsedHost, 'redditmedia.com') || hostMatches(parsedHost, 'reddit.com')) &&
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

function normalizeAuthor(value: unknown): string {
  return (typeof value === 'string' ? value : '').trim().replace(/^\/?u\//i, '') || '[unknown]';
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

function getMergedOembed(post: RedditPostData): RedditMedia['oembed'] | undefined {
  const secureOembed = post.secure_media?.oembed;
  const mediaOembed = post.media?.oembed;

  if (!secureOembed && !mediaOembed) {
    return undefined;
  }

  return {
    ...mediaOembed,
    ...secureOembed,
    provider_name: secureOembed?.provider_name || mediaOembed?.provider_name,
    thumbnail_url: secureOembed?.thumbnail_url || mediaOembed?.thumbnail_url,
    html: secureOembed?.html || mediaOembed?.html,
    width: secureOembed?.width ?? mediaOembed?.width,
    height: secureOembed?.height ?? mediaOembed?.height,
  };
}

function getExternalMedia(post: RedditPostData) {
  const oembed = getMergedOembed(post);
  const outboundUrl = getPostOutboundUrl(post);
  const domain = getUrlHostname(outboundUrl) || (typeof post.domain === 'string' ? post.domain.toLowerCase() : '');
  const knownEmbed = buildKnownEmbed(outboundUrl);
  const { embedHtml, embedWidth, embedHeight } = getPostEmbedContent(post, oembed?.html);
  const parsedEmbedUrl = parseEmbedUrl(embedHtml);
  const embedUrl = shouldPreferKnownEmbedUrl(parsedEmbedUrl, outboundUrl, knownEmbed?.embedUrl)
    ? knownEmbed?.embedUrl
    : parsedEmbedUrl || knownEmbed?.embedUrl;
  const thumbnailUrl = normalizeUrl(oembed?.thumbnail_url) || getThumbnailUrl(post);

  const isExternalDomain = domain.length > 0 && !isRedditMediaHost(domain) && !isLikelyImageUrl(outboundUrl);

  if (!isExternalDomain && !embedUrl && !embedHtml) {
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

  return (
    external.provider?.toLowerCase() === 'redgifs' ||
    hostMatches(getUrlHostname(external.embedUrl ?? ''), 'redgifs.com') ||
    hostMatches(getUrlHostname(external.outboundUrl), 'redgifs.com')
  );
}

function hasMediaObject(value: RedditPostData['media']): boolean {
  return Boolean(
    normalizeRedditVideo(value?.reddit_video) ||
      normalizeEmbedHtml(value?.oembed?.html) ||
      normalizeUrl(value?.oembed?.thumbnail_url),
  );
}

function hasPreviewData(value: RedditPostData['preview']): boolean {
  return Boolean(
    normalizeRedditVideo(value?.reddit_video_preview) ||
      value?.images?.some((image) =>
        Boolean(
          getSourceUrl(image.source) ||
            Object.values(image.variants ?? {}).some((variant) => getSourceUrl(variant?.source)),
        ),
      ),
  );
}

function getDirectPostMediaStrength(post: RedditPostData): number {
  if (buildGalleryItems(post).length > 0) {
    return 7;
  }

  if (getVideoMedia(post, true)) {
    return 6;
  }

  const external = getExternalMedia(post);

  if (external?.embedUrl || external?.embedHtml) {
    return 5;
  }

  if (isLikelyImageUrl(getPostOutboundUrl(post)) || getSourceUrl(getPreviewImage(post))) {
    return 4;
  }

  if (external) {
    return 3;
  }

  return readString(post.selftext) || post.is_self ? 1 : 0;
}

function findBestCrosspostMediaSource(
  post: RedditPostData,
  depth = 0,
  seen = new Set<RedditPostData>(),
): RedditPostData {
  if (depth > 3 || seen.has(post)) {
    return post;
  }

  seen.add(post);
  let best = post;
  let bestStrength = getDirectPostMediaStrength(post);

  if (depth === 3 || !Array.isArray(post.crosspost_parent_list)) {
    return best;
  }

  for (const parent of post.crosspost_parent_list.slice(0, 4)) {
    if (!parent || typeof parent !== 'object') {
      continue;
    }

    const candidate = findBestCrosspostMediaSource(parent, depth + 1, seen);
    const candidateStrength = getDirectPostMediaStrength(candidate);

    if (candidateStrength > bestStrength) {
      best = candidate;
      bestStrength = candidateStrength;
    }
  }

  return best;
}

function resolveMediaSourcePost(post: RedditPostData): RedditPostData {
  const parent = findBestCrosspostMediaSource(post);

  if (parent === post) {
    return post;
  }

  const parentOutboundUrl = getPostOutboundUrl(parent);
  const outerOutboundUrl = getPostOutboundUrl(post);
  const outboundUrl = parentOutboundUrl || outerOutboundUrl;
  const parentDomain = typeof parent.domain === 'string' ? parent.domain.trim() : '';

  return {
    ...post,
    url: outboundUrl,
    url_overridden_by_dest: outboundUrl || null,
    domain: parentDomain || getUrlHostname(outboundUrl) || readString(post.domain) || 'reddit.com',
    selftext:
      typeof parent.selftext === 'string' && parent.selftext.trim()
        ? parent.selftext
        : post.selftext,
    over_18: Boolean(post.over_18 || parent.over_18),
    is_self: Boolean(parent.is_self),
    is_gallery: Boolean(parent.is_gallery || parent.gallery_data?.items?.length),
    is_video: Boolean(parent.is_video),
    post_hint: parent.post_hint || post.post_hint,
    thumbnail:
      (typeof parent.thumbnail === 'string' && parent.thumbnail.trim() ? parent.thumbnail : undefined) ??
      post.thumbnail,
    preview: hasPreviewData(parent.preview) ? parent.preview : post.preview,
    gallery_data: parent.gallery_data?.items?.length ? parent.gallery_data : post.gallery_data,
    media_metadata: parent.gallery_data?.items?.length ? parent.media_metadata : post.media_metadata,
    media: hasMediaObject(parent.media) ? parent.media : post.media,
    secure_media: hasMediaObject(parent.secure_media) ? parent.secure_media : post.secure_media,
    media_embed: parent.media_embed?.content ? parent.media_embed : post.media_embed,
    secure_media_embed: parent.secure_media_embed?.content ? parent.secure_media_embed : post.secure_media_embed,
  };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readFiniteNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePermalink(value: unknown): string {
  const permalink = readString(value);

  if (!permalink) {
    return '';
  }

  try {
    return new URL(permalink).pathname || '';
  } catch {
    return permalink.startsWith('/') ? permalink : `/${permalink}`;
  }
}

function getPostIdentity(post: RedditPostData): { id: string; name: string; subreddit: string; permalink: string } {
  const name = readString(post.name);
  const rawPermalink = normalizePermalink(post.permalink);
  const id =
    readString(post.id) ||
    name.replace(/^t3_/i, '') ||
    rawPermalink.match(/\/comments\/([^/?#]+)/i)?.[1] ||
    'unknown';
  const subreddit =
    readString(post.subreddit).replace(/^\/?r\//i, '') ||
    rawPermalink.match(/^\/r\/([^/]+)/i)?.[1] ||
    'unknown';
  const permalink = rawPermalink || `/r/${subreddit}/comments/${id}/`;

  return {
    id,
    name: name || `t3_${id}`,
    subreddit,
    permalink,
  };
}

export function normalizePost(post: RedditPostData): NormalizedPost {
  const mediaPost = resolveMediaSourcePost(post);
  const identity = getPostIdentity(post);
  const discussionUrl = `https://www.reddit.com${identity.permalink}`;
  const outboundUrl = getPostOutboundUrl(mediaPost) || discussionUrl;
  const imageSource = getPreviewImage(mediaPost);
  const thumbnailUrl = getThumbnailUrl(mediaPost);

  let media: NormalizedPost['media'];

  if (mediaPost.is_self) {
    media = { type: 'text' };
  } else {
    const galleryItems = buildGalleryItems(mediaPost);
    const primaryVideo = getVideoMedia(mediaPost, false);

    if (galleryItems.length > 0) {
      media = { type: 'gallery', items: galleryItems };
    } else if (primaryVideo) {
      media = primaryVideo;
    } else if (isLikelyImageUrl(outboundUrl)) {
      media = {
        type: 'image',
        ...getBestImage(imageSource, outboundUrl, true),
      };
    } else {
      const external = getExternalMedia(mediaPost);
      const canUsePreviewVideo =
        !(external?.embedUrl || external?.embedHtml) || isRedgifsExternalEmbed(external);
      const previewVideo = canUsePreviewVideo ? getVideoMedia(mediaPost, true) : null;

      if (previewVideo) {
        media = previewVideo;
      } else if (external) {
        media = external;
      } else {
        const canUseImageFallback = !isHostedVideoPost(mediaPost);
        const imageFallbackUrl = canUseImageFallback ? thumbnailUrl : '';
        const hasImageCandidate = Boolean(getSourceUrl(imageSource) || imageFallbackUrl);

        if (canUseImageFallback && hasImageCandidate) {
          media = {
            type: 'image',
            ...getBestImage(imageSource, imageFallbackUrl),
          };
        } else {
          media = { type: 'link', outboundUrl };
        }
      }
    }
  }

  const rawSelfText =
    readString(post.selftext) || (mediaPost !== post ? readString(mediaPost.selftext) : '');

  return {
    id: identity.id,
    name: identity.name,
    title: readString(post.title) || 'Untitled post',
    author: normalizeAuthor(post.author),
    flairText: readString(post.link_flair_text) || undefined,
    subreddit: identity.subreddit,
    permalink: identity.permalink,
    score: readFiniteNumber(post.score),
    numComments: Math.max(0, readFiniteNumber(post.num_comments)),
    createdUtc: Math.max(0, readFiniteNumber(post.created_utc)),
    selfText: stripSubmissionBoilerplate(rawSelfText),
    isNsfw: Boolean(post.over_18 || mediaPost.over_18),
    outboundUrl,
    media,
  };
}
