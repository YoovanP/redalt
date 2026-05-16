import { useMemo, useState } from 'react';
import type { GalleryItem } from '../../types/reddit';

type GalleryCarouselProps = {
  items: GalleryItem[];
  title: string;
};

export function GalleryCarousel({ items, title }: GalleryCarouselProps) {
  const [index, setIndex] = useState(0);

  const boundedIndex = useMemo(() => {
    if (items.length === 0) {
      return 0;
    }

    const clamped = Math.min(index, items.length - 1);

    if (clamped !== index) {
      setIndex(clamped);
    }

    return clamped;
  }, [index, items.length]);

  if (items.length === 0) {
    return null;
  }

  const active = items[boundedIndex];

  return (
    <div className="media-block media-aspect-wrap gallery">
      <img className="post-image" src={active.url} alt={`${title} (${boundedIndex + 1}/${items.length})`} loading="lazy" />
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
