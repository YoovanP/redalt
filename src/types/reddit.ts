export interface RedditListingResponse {
  kind: 'Listing';
  data: {
    after: string | null;
    before: string | null;
    children: Array<{
      kind: string;
      data: RedditPostData;
    }>;
  };
}

export interface RedditCommentsResponse extends Array<RedditListingResponse> {}

export interface RedditPostData {
  id: string;
  name: string;
  title: string;
  author: string;
  link_flair_text?: string | null;
  subreddit: string;
  permalink: string;
  url: string;
  url_overridden_by_dest?: string | null;
  domain: string;
  selftext: string;
  selftext_html?: string | null;
  score: number;
  num_comments: number;
  created_utc: number;
  over_18: boolean;
  is_self: boolean;
  is_gallery?: boolean;
  is_video?: boolean;
  post_hint?: string;
  thumbnail?: string;
  preview?: {
    enabled?: boolean;
    images?: Array<{
      source?: RedditImageSource;
      resolutions?: RedditImageSource[];
      variants?: {
        gif?: { source?: RedditImageSource };
        mp4?: { source?: RedditImageSource };
      };
    }>;
    reddit_video_preview?: RedditVideo;
  };
  gallery_data?: {
    items: Array<{
      media_id: string;
      id: number;
      caption?: string;
      outbound_url?: string;
    }>;
  };
  media_metadata?: Record<
    string,
    {
      status?: string;
      e?: string;
      m?: string;
      s?: RedditImageSource;
      p?: RedditImageSource[];
      hlsUrl?: string;
      dashUrl?: string;
      hls_url?: string;
      dash_url?: string;
      x?: number;
      y?: number;
    }
  >;
  media?: RedditMedia | null;
  secure_media?: RedditMedia | null;
  media_embed?: RedditEmbedContent | null;
  secure_media_embed?: RedditEmbedContent | null;
  crosspost_parent_list?: RedditPostData[];
}

export interface RedditImageSource {
  url?: string;
  u?: string;
  gif?: string;
  mp4?: string;
  hlsUrl?: string;
  dashUrl?: string;
  hls_url?: string;
  dash_url?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

export interface ResponsiveImageSource {
  url: string;
  width: number;
  height?: number;
}

export interface RedditVideo {
  fallback_url?: string;
  hls_url?: string;
  dash_url?: string;
  scrubber_media_url?: string;
  width?: number;
  height?: number;
  is_gif?: boolean;
  duration?: number;
  bitrate_kbps?: number;
  transcoding_status?: string;
}

export interface RedditMedia {
  reddit_video?: RedditVideo;
  oembed?: {
    provider_name?: string;
    provider_url?: string;
    author_name?: string;
    author_url?: string;
    title?: string;
    thumbnail_url?: string;
    html?: string;
    width?: number;
    height?: number;
    type?: string;
    version?: string;
  };
}

export interface RedditEmbedContent {
  content?: string;
  width?: number;
  height?: number;
  scrolling?: boolean;
  media_domain_url?: string;
}

export type NormalizedMedia =
  | { type: 'text' }
  | { type: 'image'; url: string; width?: number; height?: number; sources?: ResponsiveImageSource[] }
  | { type: 'gallery'; items: GalleryItem[] }
  | {
      type: 'video';
      sourceUrl: string;
      hlsUrl?: string;
      dashUrl?: string;
      mimeType?: string;
      posterUrl?: string;
      width?: number;
      height?: number;
      isGif?: boolean;
    }
  | {
      type: 'external';
      outboundUrl: string;
      provider?: string;
      embedHtml?: string;
      embedUrl?: string;
      thumbnailUrl?: string;
      embedWidth?: number;
      embedHeight?: number;
    }
  | { type: 'link'; outboundUrl: string };

export type GalleryItem =
  | {
      id: string;
      type: 'image';
      url: string;
      mimeType?: string;
      width?: number;
      height?: number;
      sources?: ResponsiveImageSource[];
      caption?: string;
      outboundUrl?: string;
    }
  | {
      id: string;
      type: 'video';
      sourceUrl: string;
      hlsUrl?: string;
      dashUrl?: string;
      mimeType?: string;
      posterUrl?: string;
      width?: number;
      height?: number;
      isGif?: boolean;
      caption?: string;
      outboundUrl?: string;
    };

export interface NormalizedPost {
  id: string;
  name: string;
  title: string;
  author: string;
  flairText?: string;
  subreddit: string;
  permalink: string;
  score: number;
  numComments: number;
  createdUtc: number;
  selfText: string;
  isNsfw: boolean;
  outboundUrl: string;
  media: NormalizedMedia;
}

export interface PostListingResult {
  posts: RedditPostData[];
  after: string | null;
}

export interface RedditComment {
  id: string;
  author: string;
  body: string;
  parentAuthor?: string;
  replies: RedditComment[];
}

export interface PostDetailResult {
  post: RedditPostData;
  comments: RedditComment[];
  commentsStatus: 'loaded' | 'empty' | 'unavailable';
  mediaStatus: 'ready' | 'incomplete';
}
