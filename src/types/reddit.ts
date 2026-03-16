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
  url_overridden_by_dest?: string;
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
    images?: Array<{
      source?: RedditImageSource;
      variants?: {
        gif?: { source?: RedditImageSource };
        mp4?: { source?: RedditImageSource };
      };
    }>;
  };
  gallery_data?: {
    items: Array<{
      media_id: string;
      id: number;
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
    }
  >;
  media?: RedditMedia | null;
  secure_media?: RedditMedia | null;
}

export interface RedditImageSource {
  url: string;
  u?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

export interface RedditMedia {
  reddit_video?: {
    fallback_url: string;
    hls_url?: string;
    dash_url?: string;
    width?: number;
    height?: number;
    is_gif?: boolean;
  };
  oembed?: {
    provider_name?: string;
    thumbnail_url?: string;
    html?: string;
  };
}

export type NormalizedMedia =
  | { type: 'text' }
  | { type: 'image'; url: string; width?: number; height?: number }
  | { type: 'gallery'; items: GalleryItem[] }
  | {
      type: 'video';
      sourceUrl: string;
      hlsUrl?: string;
      dashUrl?: string;
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
    }
  | { type: 'link'; outboundUrl: string };

export interface GalleryItem {
  id: string;
  url: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

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
}
