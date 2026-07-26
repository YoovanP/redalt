import { useEffect, useState } from 'react';
import type { GalleryItem } from '../../types/reddit';
import { MediaShell } from './MediaShell';
import { VideoMedia } from './VideoMedia';

type GalleryCarouselProps = {
  items: GalleryItem[];
  title: string;
  active?: boolean;
};

export function GalleryCarousel({ items, title, active: galleryActive }: GalleryCarouselProps) {
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  const boundedIndex = items.length === 0 ? 0 : Math.min(index, items.length - 1);

  useEffect(() => {
    setIndex((current) => (items.length === 0 ? 0 : Math.min(current, items.length - 1)));
  }, [items.length]);

  useEffect(() => setStatus('loading'), [boundedIndex]);

  if (items.length === 0) {
    return null;
  }

  const active = items[boundedIndex];
  const srcSet = active.type === 'image'
    ? active.sources?.map((source) => `${source.url} ${source.width}w`).join(', ')
    : undefined;

  return (
    <div className="gallery-block">
      <MediaShell
        width={active.width}
        height={active.height}
        className="gallery"
        status={active.type === 'video' ? 'ready' : status}
        sourceUrl={active.type === 'video' ? active.sourceUrl : active.url}
      >
        {active.type === 'video' ? (
          <VideoMedia
            key={active.id}
            sourceUrl={active.sourceUrl}
            hlsUrl={active.hlsUrl}
            mimeType={active.mimeType}
            posterUrl={active.posterUrl}
            isGif={active.isGif}
            title={title}
            showSourceLink={false}
            width={active.width}
            height={active.height}
            active={galleryActive}
            inline
          />
        ) : (
          <img
            key={active.id}
            className="post-image"
            src={active.url}
            srcSet={srcSet || undefined}
            sizes="(max-width: 900px) 100vw, 50vw"
            alt={`${title} (${boundedIndex + 1}/${items.length})`}
            width={active.width}
            height={active.height}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onLoad={() => setStatus('ready')}
            onError={() => setStatus('error')}
          />
        )}
        {items.length > 1 && <div className="gallery-controls">
          <button
            type="button"
            className="gallery-nav gallery-nav-prev"
            aria-label="Previous image"
            disabled={boundedIndex === 0}
            onClick={(e) => {
              e.preventDefault();
              setIndex((value) => Math.max(0, value - 1));
            }}
          >
            ←
          </button>
          <span className="gallery-progress">
            {boundedIndex + 1} / {items.length}
          </span>
          <button
            type="button"
            className="gallery-nav gallery-nav-next"
            aria-label="Next image"
            disabled={boundedIndex === items.length - 1}
            onClick={(e) => {
              e.preventDefault();
              setIndex((value) => Math.min(items.length - 1, value + 1));
            }}
          >
            →
          </button>
        </div>}
      </MediaShell>
      {(active.caption || active.outboundUrl) && (
        <div className="gallery-caption">
          {active.caption && <span>{active.caption}</span>}
          {active.outboundUrl && <a href={active.outboundUrl} target="_blank" rel="noreferrer">Open item</a>}
        </div>
      )}
    </div>
  );
}
