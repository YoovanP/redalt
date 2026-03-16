import type { NormalizedPost } from '../../types/reddit';
import { ExternalEmbed } from './ExternalEmbed';
import { GalleryCarousel } from './GalleryCarousel';
import { ImageMedia } from './ImageMedia';
import { TextBlock } from './TextBlock';
import { VideoMedia } from './VideoMedia';

type RenderMediaProps = {
  post: NormalizedPost;
  expanded?: boolean;
  mode?: 'default' | 'shorts';
};

export function RenderMedia({ post, expanded = false, mode = 'default' }: RenderMediaProps) {
  const { media } = post;
  const isShorts = mode === 'shorts';

  if (media.type === 'text') {
    return <TextBlock text={post.selfText} expanded={expanded} />;
  }

  if (media.type === 'image') {
    return <ImageMedia url={media.url} alt={post.title} />;
  }

  if (media.type === 'gallery') {
    return <GalleryCarousel items={media.items} title={post.title} />;
  }

  if (media.type === 'video') {
    return (
      <VideoMedia
        sourceUrl={media.sourceUrl}
        hlsUrl={media.hlsUrl}
        title={post.title}
        showSourceLink={!isShorts}
      />
    );
  }

  if (media.type === 'external') {
    return (
      <ExternalEmbed
        embedUrl={media.embedUrl}
        thumbnailUrl={media.thumbnailUrl}
        outboundUrl={media.outboundUrl}
        provider={media.provider}
        showOutboundLink={!isShorts}
      />
    );
  }

  if (!expanded) {
    return null;
  }

  return (
    <div className="media-block">
      <a href={media.outboundUrl} target="_blank" rel="noreferrer">
        Open external link
      </a>
    </div>
  );
}
