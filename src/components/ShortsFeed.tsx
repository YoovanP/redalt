import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { addWatchHistory, toggleSavedPost } from '../lib/localLibrary';
import { RenderMedia } from './media/RenderMedia';
import type { NormalizedPost } from '../types/reddit';

type ShortsFeedProps = {
  posts: NormalizedPost[];
  hasMore: boolean;
  loadingMore: boolean;
  onNearEnd: () => void;
};

export function ShortsFeed({ posts, hasMore, loadingMore, onNearEnd }: ShortsFeedProps) {
  const navigate = useNavigate();
  const feedRef = useRef<HTMLDivElement | null>(null);
  const nearEndRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);
  const gestureRef = useRef<{
    index: number;
    startX: number;
    startY: number;
    moved: boolean;
    longPressTriggered: boolean;
    lastTapAt: number;
    longPressTimer?: number;
  }>({
    index: -1,
    startX: 0,
    startY: 0,
    moved: false,
    longPressTriggered: false,
    lastTapAt: 0,
  });
  const [activeIndex, setActiveIndex] = useState(0);
  const [quickMenuIndex, setQuickMenuIndex] = useState<number | null>(null);
  const [gestureMessage, setGestureMessage] = useState<string | null>(null);
  const [shortsMuted, setShortsMuted] = useState(() => {
    const raw = localStorage.getItem('redalt.shortsMuted');
    return raw === null ? true : raw === 'true';
  });
  const [playbackRate, setPlaybackRate] = useState(() => {
    const raw = Number(localStorage.getItem('redalt.shortsPlaybackRate') ?? '1');
    return raw === 0.75 || raw === 1 || raw === 1.25 || raw === 1.5 || raw === 2 ? raw : 1;
  });
  const [showOverlay, setShowOverlay] = useState(() => {
    const raw = localStorage.getItem('redalt.shortsShowOverlay');
    return raw === null ? true : raw === 'true';
  });

  useEffect(() => {
    localStorage.setItem('redalt.shortsMuted', String(shortsMuted));
  }, [shortsMuted]);

  useEffect(() => {
    localStorage.setItem('redalt.shortsPlaybackRate', String(playbackRate));
  }, [playbackRate]);

  useEffect(() => {
    localStorage.setItem('redalt.shortsShowOverlay', String(showOverlay));
  }, [showOverlay]);

  useEffect(() => {
    const activePost = posts[activeIndex];

    if (activePost) {
      addWatchHistory(activePost);
    }
  }, [activeIndex, posts]);

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

  useEffect(() => {
    const feed = feedRef.current;

    if (!feed) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        let bestIndex = activeIndex;
        let bestRatio = 0;

        for (const entry of entries) {
          const indexValue = Number((entry.target as HTMLElement).dataset.index ?? '-1');

          if (entry.isIntersecting && indexValue >= 0 && entry.intersectionRatio > bestRatio) {
            bestRatio = entry.intersectionRatio;
            bestIndex = indexValue;
          }
        }

        if (bestIndex !== activeIndex) {
          setActiveIndex(bestIndex);
        }
      },
      {
        root: feed,
        threshold: [0.3, 0.55, 0.8],
      },
    );

    for (const item of itemRefs.current) {
      if (item) {
        observer.observe(item);
      }
    }

    return () => {
      observer.disconnect();
    };
  }, [posts.length, activeIndex]);

  useEffect(() => {
    const feed = feedRef.current;

    if (!feed) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(event.key)) {
        return;
      }

      event.preventDefault();
      const delta = event.key === 'ArrowDown' || event.key === 'PageDown' ? 1 : -1;
      const nextIndex = Math.max(0, Math.min(posts.length - 1, activeIndex + delta));
      const target = itemRefs.current[nextIndex];

      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };

    feed.addEventListener('keydown', onKeyDown);

    return () => {
      feed.removeEventListener('keydown', onKeyDown);
    };
  }, [activeIndex, posts.length]);

  useEffect(() => {
    const feed = feedRef.current;

    if (!feed) {
      return;
    }

    const videos = feed.querySelectorAll<HTMLVideoElement>('video.post-video');

    for (const video of videos) {
      video.muted = shortsMuted;
      video.playbackRate = playbackRate;
    }
  }, [shortsMuted, playbackRate, posts.length, activeIndex]);

  const triggerIndex = Math.max(0, posts.length - 3);

  const scrollToIndex = (index: number) => {
    const clamped = Math.max(0, Math.min(posts.length - 1, index));
    const target = itemRefs.current[clamped];

    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const openComments = (index: number) => {
    const post = posts[index];

    if (!post) {
      return;
    }

    navigate(`/r/${post.subreddit}/comments/${post.id}`);
  };

  const onTouchPointerDown = (index: number, event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'touch') {
      return;
    }

    const gesture = gestureRef.current;
    gesture.index = index;
    gesture.startX = event.clientX;
    gesture.startY = event.clientY;
    gesture.moved = false;
    gesture.longPressTriggered = false;

    if (gesture.longPressTimer) {
      window.clearTimeout(gesture.longPressTimer);
    }

    gesture.longPressTimer = window.setTimeout(() => {
      if (!gesture.moved) {
        setQuickMenuIndex(index);
        gesture.longPressTriggered = true;
      }
    }, 520);
  };

  const onTouchPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'touch') {
      return;
    }

    const gesture = gestureRef.current;
    const deltaX = Math.abs(event.clientX - gesture.startX);
    const deltaY = Math.abs(event.clientY - gesture.startY);

    if (deltaX > 12 || deltaY > 12) {
      gesture.moved = true;

      if (gesture.longPressTimer) {
        window.clearTimeout(gesture.longPressTimer);
        gesture.longPressTimer = undefined;
      }
    }
  };

  const onTouchPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'touch') {
      return;
    }

    const gesture = gestureRef.current;

    if (gesture.longPressTimer) {
      window.clearTimeout(gesture.longPressTimer);
      gesture.longPressTimer = undefined;
    }

    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (gesture.longPressTriggered) {
      return;
    }

    if (absDx > 64 && absDx > absDy) {
      if (dx < 0) {
        scrollToIndex(gesture.index + 1);
      } else {
        openComments(gesture.index);
      }
      return;
    }

    if (absDx < 12 && absDy < 12) {
      const now = Date.now();

      if (now - gesture.lastTapAt < 280) {
        const post = posts[gesture.index];

        if (post) {
          const saved = toggleSavedPost(post);
          setGestureMessage(saved ? 'Saved' : 'Unsaved');
          window.setTimeout(() => setGestureMessage(null), 1200);
        }

        gesture.lastTapAt = 0;
      } else {
        gesture.lastTapAt = now;
      }
    }
  };

  const onTouchPointerCancel = () => {
    const gesture = gestureRef.current;

    if (gesture.longPressTimer) {
      window.clearTimeout(gesture.longPressTimer);
      gesture.longPressTimer = undefined;
    }
  };

  return (
    <div
      ref={feedRef}
      className="shorts-feed shorts-feed-fullscreen"
      aria-label="Media feed"
      tabIndex={0}
    >
      <div className="shorts-controls" role="group" aria-label="Media feed controls">
        <button type="button" className="post-action-button" onClick={() => setShortsMuted((value) => !value)}>
          {shortsMuted ? 'Unmute' : 'Mute'}
        </button>
        <label>
          Speed
          <select
            value={playbackRate}
            onChange={(event) => setPlaybackRate(Number(event.target.value))}
          >
            <option value={0.75}>0.75x</option>
            <option value={1}>1x</option>
            <option value={1.25}>1.25x</option>
            <option value={1.5}>1.5x</option>
            <option value={2}>2x</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={showOverlay}
            onChange={(event) => setShowOverlay(event.target.checked)}
          />
          Overlay
        </label>
      </div>

      {posts.map((post, index) => (
        <article
          key={post.name}
          className="shorts-item"
          ref={(element) => {
            itemRefs.current[index] = element;
          }}
          data-index={index}
          onPointerDown={(event) => onTouchPointerDown(index, event)}
          onPointerMove={onTouchPointerMove}
          onPointerUp={onTouchPointerUp}
          onPointerCancel={onTouchPointerCancel}
        >
          {index === triggerIndex && hasMore && <div ref={nearEndRef} className="near-end-trigger" />}
          <div className="shorts-media-wrap">
            <RenderMedia post={post} expanded mode="shorts" />
          </div>
          {showOverlay && (
            <div className="shorts-overlay">
              <h3>{post.title}</h3>
              <p>
                r/{post.subreddit} · u/{post.author} · {post.score} points
              </p>
            </div>
          )}

          {quickMenuIndex === index && (
            <div className="shorts-quick-menu" role="menu" aria-label="Quick actions">
              <button type="button" onClick={() => openComments(index)}>
                Comments
              </button>
              <button
                type="button"
                onClick={() => {
                  const saved = toggleSavedPost(post);
                  setGestureMessage(saved ? 'Saved' : 'Unsaved');
                  setQuickMenuIndex(null);
                  window.setTimeout(() => setGestureMessage(null), 1200);
                }}
              >
                Save / Unsave
              </button>
              <button
                type="button"
                onClick={() => {
                  window.open(`https://www.reddit.com${post.permalink}`, '_blank', 'noopener,noreferrer');
                  setQuickMenuIndex(null);
                }}
              >
                Open on Reddit
              </button>
              <button
                type="button"
                onClick={() => {
                  window.open(post.outboundUrl, '_blank', 'noopener,noreferrer');
                  setQuickMenuIndex(null);
                }}
              >
                Open source
              </button>
              <button type="button" onClick={() => setQuickMenuIndex(null)}>
                Close
              </button>
            </div>
          )}
        </article>
      ))}

      {gestureMessage && <div className="shorts-gesture-message">{gestureMessage}</div>}
    </div>
  );
}
