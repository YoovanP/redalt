import type { NormalizedPost } from '../../types/reddit';

function getThumbnail(post: NormalizedPost): string | undefined {
  const { media } = post;
  if (media.type === 'image') return media.sources?.[0]?.url ?? media.url;
  if (media.type === 'video') return media.posterUrl;
  if (media.type === 'external') return media.thumbnailUrl;
  if (media.type === 'gallery') {
    const first = media.items[0];
    if (first?.type === 'image') return first.sources?.[0]?.url ?? first.url;
    if (first?.type === 'video') return first.posterUrl;
  }
  return undefined;
}

export function PostThumbnail({ post }: { post: NormalizedPost }) {
  const url = getThumbnail(post);
  if (!url) return <div className="post-thumbnail-placeholder" aria-hidden="true">TEXT</div>;

  return (
    <img
      className="post-thumbnail"
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
    />
  );
}
