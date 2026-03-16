import { useState } from 'react';
import { Link } from 'react-router-dom';
import { RenderMedia } from './media/RenderMedia';
import type { NormalizedPost } from '../types/reddit';

type PostCardProps = {
  post: NormalizedPost;
};

const PREVIEW_TEXT_LIMIT = 320;

function formatTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString();
}

export function PostCard({ post }: PostCardProps) {
  const [shareState, setShareState] = useState<'idle' | 'done' | 'error'>('idle');
  const [showFullText, setShowFullText] = useState(false);

  const trimmedSelfText = post.selfText.trim();
  const isLongText = trimmedSelfText.length > PREVIEW_TEXT_LIMIT;
  const shownText =
    isLongText && !showFullText
      ? `${trimmedSelfText.slice(0, PREVIEW_TEXT_LIMIT).trimEnd()}…`
      : trimmedSelfText;

  const onShare = async () => {
    const shareUrl = `https://www.reddit.com${post.permalink}`;

    try {
      if (navigator.share) {
        await navigator.share({
          title: post.title,
          url: shareUrl,
        });
      } else {
        await navigator.clipboard.writeText(shareUrl);
      }

      setShareState('done');
      window.setTimeout(() => setShareState('idle'), 1400);
    } catch {
      setShareState('error');
      window.setTimeout(() => setShareState('idle'), 1400);
    }
  };

  return (
    <article className="post-card">
      <header>
        <h2>
          <Link to={`/r/${post.subreddit}/comments/${post.id}`}>{post.title}</Link>
        </h2>
        {post.flairText && <p className="post-flair">{post.flairText}</p>}
        <p className="meta">
          u/{post.author} · {post.score} points · {post.numComments} comments · {formatTimestamp(post.createdUtc)}
          {post.isNsfw ? ' · NSFW' : ''}
        </p>
        <p className="post-links post-links-inline">
          <Link to={`/r/${post.subreddit}/comments/${post.id}`}>View comments</Link>
        </p>
      </header>

      <RenderMedia post={post} />

      {trimmedSelfText && post.media.type !== 'text' && (
        <div>
          <p className="self-text self-text-preview">{shownText}</p>
          {isLongText && (
            <button
              type="button"
              className="text-toggle"
              onClick={() => setShowFullText((current) => !current)}
            >
              {showFullText ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}

      <footer className="post-links">
        <a href={`https://www.reddit.com${post.permalink}`} target="_blank" rel="noreferrer">
          Open on Reddit
        </a>
        <a href={post.outboundUrl} target="_blank" rel="noreferrer">
          Open source
        </a>
        <button type="button" onClick={onShare}>
          {shareState === 'idle' ? 'Share' : shareState === 'done' ? 'Shared' : 'Failed'}
        </button>
      </footer>
    </article>
  );
}
