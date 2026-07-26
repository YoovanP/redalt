import { memo } from 'react';
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
  active?: boolean;
  nearby?: boolean;
};

export const RenderMedia = memo(function RenderMedia({ post, expanded = false, mode = 'default', active, nearby }: RenderMediaProps) {
  const { media } = post;
  const isShorts = mode === 'shorts';

  if (media.type === 'text') {
    return <TextBlock text={post.selfText} expanded={expanded} />;
  }

  if (media.type === 'image') {
    return <ImageMedia url={media.url} alt={post.title} width={media.width} height={media.height} sources={media.sources} />;
  }

  if (media.type === 'gallery') {
    return <GalleryCarousel items={media.items} title={post.title} active={active} />;
  }

  if (media.type === 'video') {
    return (
      <VideoMedia
        sourceUrl={media.sourceUrl}
        hlsUrl={media.hlsUrl}
        mimeType={media.mimeType}
        posterUrl={media.posterUrl}
        isGif={media.isGif}
        title={post.title}
        showSourceLink={!isShorts}
        width={media.width}
        height={media.height}
        active={active}
        nearby={nearby}
      />
    );
  }

  if (media.type === 'external') {
    return (
      <ExternalEmbed
        embedUrl={media.embedUrl}
        embedHtml={media.embedHtml}
        thumbnailUrl={media.thumbnailUrl}
        outboundUrl={media.outboundUrl}
        provider={media.provider}
        embedWidth={media.embedWidth}
        embedHeight={media.embedHeight}
        showOutboundLink={!isShorts}
        active={active}
        nearby={nearby}
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
});
