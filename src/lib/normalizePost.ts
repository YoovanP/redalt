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

function getSourceUrl(source: RedditImageSource | undefined): string {
  if (!source) {
    return '';
  }

  return normalizeUrl(source.url || source.u);
}

function getBestImage(source: RedditImageSource | undefined, fallbackUrl: string): {
  url: string;
  width?: number;
  height?: number;
} {
  const url = getSourceUrl(source) || fallbackUrl;

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

  const match = html.match(/<iframe[^>]*src=["']([^"']+)["']/i);
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

function getVideoMedia(post: RedditPostData) {
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

  const previewMp4 = post.preview?.images?.[0]?.variants?.mp4?.source;

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
  return /\.(png|jpe?g|webp|gif)$/i.test(url);
}

function getExternalMedia(post: RedditPostData) {
  const media: RedditMedia | null | undefined = post.secure_media ?? post.media;
  const oembed = media?.oembed;
  const outboundUrl = normalizeUrl(post.url_overridden_by_dest ?? post.url);
  const domain = post.domain?.toLowerCase() ?? '';

  const isExternalDomain =
    domain.length > 0 &&
    !domain.endsWith('reddit.com') &&
    !domain.endsWith('redd.it') &&
    !domain.endsWith('redditmedia.com');

  if (!isExternalDomain && post.post_hint !== 'rich:video') {
    return null;
  }

  const embedHtml = oembed?.html;

  return {
    type: 'external' as const,
    outboundUrl,
    provider: oembed?.provider_name,
    embedHtml,
    embedUrl: parseEmbedUrl(embedHtml),
    thumbnailUrl: normalizeUrl(oembed?.thumbnail_url),
  };
}

export function normalizePost(post: RedditPostData): NormalizedPost {
  const outboundUrl = normalizeUrl(post.url_overridden_by_dest ?? post.url);
  const imageSource = post.preview?.images?.[0]?.source;

  let media: NormalizedPost['media'];

  if (post.is_self) {
    media = { type: 'text' };
  } else {
    const galleryItems = buildGalleryItems(post);

    if (galleryItems.length > 0) {
      media = { type: 'gallery', items: galleryItems };
    } else {
      const video = getVideoMedia(post);

      if (video) {
        media = video;
      } else {
        const external = getExternalMedia(post);

        if (external) {
          media = external;
        } else if (imageSource?.url || isLikelyImageUrl(outboundUrl) || post.post_hint === 'image') {
          media = {
            type: 'image',
            ...getBestImage(imageSource, outboundUrl),
          };
        } else {
          media = { type: 'link', outboundUrl };
        }
      }
    }
  }

  return {
    id: post.id,
    name: post.name,
    title: post.title,
    author: post.author,
    flairText: post.link_flair_text?.trim() || undefined,
    subreddit: post.subreddit,
    permalink: post.permalink,
    score: post.score,
    numComments: post.num_comments,
    createdUtc: post.created_utc,
    selfText: post.selftext,
    isNsfw: post.over_18,
    outboundUrl,
    media,
  };
}
