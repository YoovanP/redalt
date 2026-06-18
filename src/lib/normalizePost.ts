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

function parseEmbedUrl(html: string | undefined): string | undefined {
  if (!html) {
    return undefined;
  }

  const match = decodeBasicEntities(html).match(/<iframe[^>]*src=["']([^"']+)["']/i);
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

function getVideoMedia(post: RedditPostData, includePreviewMp4 = true) {
  const media: RedditMedia | null | undefined = post.secure_media ?? post.media;
  const redditVideo = media?.reddit_video;

  if (redditVideo?.fallback_url) {
    return {
      type: 'video' as const,
      sourceUrl: normalizeUrl(redditVideo.fallback_url),
      hlsUrl: normalizeUrl(redditVideo.hls_url),
      dashUrl: normalizeUrl(redditVideo.dash_url),
      width: redditVideo.width,
      height: redditVideo.height,
      isGif: redditVideo.is_gif,
    };
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

function buildKnownEmbed(url: string): { provider: string; embedUrl: string } | null {
  const youtubeEmbed = buildYouTubeEmbed(url);

  if (youtubeEmbed) {
    return { provider: 'YouTube', embedUrl: youtubeEmbed };
  }

  const vimeoEmbed = buildVimeoEmbed(url);

  if (vimeoEmbed) {
    return { provider: 'Vimeo', embedUrl: vimeoEmbed };
  }

  const redgifsEmbed = buildRedgifsEmbed(url);

  if (redgifsEmbed) {
    return { provider: 'Redgifs', embedUrl: redgifsEmbed };
  }

  return null;
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

function getExternalMedia(post: RedditPostData) {
  const media: RedditMedia | null | undefined = post.secure_media ?? post.media;
  const oembed = media?.oembed;
  const outboundUrl = normalizeUrl(post.url_overridden_by_dest ?? post.url);
  const domain = post.domain?.toLowerCase() ?? '';
  const knownEmbed = buildKnownEmbed(outboundUrl);
  const embedHtml = oembed?.html;
  const embedUrl = parseEmbedUrl(embedHtml) || knownEmbed?.embedUrl;
  const thumbnailUrl = normalizeUrl(oembed?.thumbnail_url) || getThumbnailUrl(post);

  const isExternalDomain =
    domain.length > 0 &&
    !isRedditMediaHost(domain) &&
    !isLikelyImageUrl(outboundUrl);

  if (!isExternalDomain && !embedUrl && post.post_hint !== 'rich:video') {
    return null;
  }

  return {
    type: 'external' as const,
    outboundUrl,
    provider: oembed?.provider_name || knownEmbed?.provider,
    embedHtml,
    embedUrl,
    thumbnailUrl,
  };
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
      const video = getVideoMedia(post, !external?.embedUrl);

      if (video) {
        media = video;
      } else {
        if (external) {
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
