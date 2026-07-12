import { useEffect, useState } from 'react';
import type { GalleryItem } from '../../types/reddit';
import { VideoMedia } from './VideoMedia';

type GalleryCarouselProps = {
  items: GalleryItem[];
  title: string;
};

export function GalleryCarousel({ items, title }: GalleryCarouselProps) {
  const [index, setIndex] = useState(0);

  const boundedIndex = items.length === 0 ? 0 : Math.min(index, items.length - 1);

  useEffect(() => {
    setIndex((current) => (items.length === 0 ? 0 : Math.min(current, items.length - 1)));
  }, [items.length]);

  if (items.length === 0) {
    return null;
  }

  const active = items[boundedIndex];
  const hasDimensions = typeof active.width === 'number' && typeof active.height === 'number' && active.width > 0 && active.height > 0;

  return (
    <div className="media-block gallery" style={hasDimensions ? { aspectRatio: `${active.width} / ${active.height}`, maxHeight: '80vh' } : { aspectRatio: '16 / 9', maxHeight: '520px' }}>
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
          inline
        />
      ) : (
        <img
          key={active.id}
          className="post-image"
          src={active.url}
          alt={`${title} (${boundedIndex + 1}/${items.length})`}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      )}
      {items.length > 1 && (
        <div className="gallery-controls">
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
        </div>
      )}
    </div>
  );
}
