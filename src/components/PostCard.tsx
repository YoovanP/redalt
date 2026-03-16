import { useState } from 'react';
import { Link } from 'react-router-dom';
import { RenderMedia } from './media/RenderMedia';
import type { CardMode } from '../lib/uiSettings';
import type { NormalizedPost } from '../types/reddit';

type PostCardProps = {
  post: NormalizedPost;
  cardMode?: CardMode;
};

const PREVIEW_TEXT_LIMIT = 320;

function formatTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString();
}

export function PostCard({ post, cardMode = 'default' }: PostCardProps) {
  const [shareState, setShareState] = useState<'idle' | 'done' | 'error'>('idle');
  const [showFullText, setShowFullText] = useState(false);
  const [showContentInfo, setShowContentInfo] = useState(false);
  const isContentOnly = cardMode === 'content-only';
  const showInfoBlock = !isContentOnly || showContentInfo;

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
    <article className={`post-card post-card-${cardMode}`}>
      {showInfoBlock && (
        <header>
          <h2>
            <Link to={`/r/${post.subreddit}/comments/${post.id}`}>{post.title}</Link>
          </h2>
          {post.flairText && <p className="post-flair">{post.flairText}</p>}
          <p className="meta">
            u/{post.author} · {post.score} points · {post.numComments} comments · {formatTimestamp(post.createdUtc)}
            {post.isNsfw ? ' · NSFW' : ''}
          </p>
        </header>
      )}

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

      {isContentOnly && !showContentInfo && (
        <button
          type="button"
          className="content-info-toggle"
          onClick={() => setShowContentInfo(true)}
        >
          Tap to show info
        </button>
      )}

      {showInfoBlock && (
        <footer className="post-actions">
          <Link className="post-action-button" to={`/r/${post.subreddit}/comments/${post.id}`}>
            Comments
          </Link>
          <button type="button" className="post-action-button" onClick={onShare}>
            {shareState === 'idle' ? 'Share' : shareState === 'done' ? 'Shared' : 'Failed'}
          </button>
          <a className="post-action-button" href={`https://www.reddit.com${post.permalink}`} target="_blank" rel="noreferrer">
            Open on Reddit
          </a>
          <a className="post-action-button" href={post.outboundUrl} target="_blank" rel="noreferrer">
            Open source
          </a>

          {isContentOnly && (
            <button
              type="button"
              className="post-action-button"
              onClick={() => setShowContentInfo(false)}
            >
              Hide info
            </button>
          )}
        </footer>
      )}
    </article>
  );
}
