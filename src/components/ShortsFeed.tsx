import { useEffect, useRef } from 'react';
import { RenderMedia } from './media/RenderMedia';
import type { NormalizedPost } from '../types/reddit';

type ShortsFeedProps = {
  posts: NormalizedPost[];
  hasMore: boolean;
  loadingMore: boolean;
  onNearEnd: () => void;
};

export function ShortsFeed({ posts, hasMore, loadingMore, onNearEnd }: ShortsFeedProps) {
  const feedRef = useRef<HTMLDivElement | null>(null);
  const nearEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const feed = feedRef.current;

    if (!feed || !hasMore || loadingMore) {
      return;
    }

    const onScroll = () => {
      const remaining = feed.scrollHeight - (feed.scrollTop + feed.clientHeight);

      if (remaining < 820) {
        onNearEnd();
      }
    };

    feed.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      feed.removeEventListener('scroll', onScroll);
    };
  }, [hasMore, loadingMore, onNearEnd, posts.length]);

  useEffect(() => {
    const feed = feedRef.current;
    const target = nearEndRef.current;

    if (!feed || !target || !hasMore || loadingMore) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            onNearEnd();
            break;
          }
        }
      },
      {
        root: feed,
        threshold: 0,
        rootMargin: '0px 0px 35% 0px',
      },
    );

    observer.observe(target);

    return () => {
      observer.disconnect();
    };
  }, [hasMore, loadingMore, onNearEnd, posts.length]);

  const triggerIndex = Math.max(0, posts.length - 3);

  return (
    <div ref={feedRef} className="shorts-feed shorts-feed-fullscreen" aria-label="Media feed">
      {posts.map((post, index) => (
        <article key={post.name} className="shorts-item">
          {index === triggerIndex && hasMore && <div ref={nearEndRef} className="near-end-trigger" />}
          <div className="shorts-media-wrap">
            <RenderMedia post={post} expanded mode="shorts" />
          </div>
        </article>
      ))}
    </div>
  );
}
