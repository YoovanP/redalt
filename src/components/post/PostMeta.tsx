import { Link } from 'react-router-dom';
import type { NormalizedPost } from '../../types/reddit';

type PostMetaProps = {
  post: NormalizedPost;
  showSubreddit?: boolean;
  showTimestamp?: boolean;
};

function formatRelativeTime(secondsUtc: number): string {
  if (!secondsUtc) return '';
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - secondsUtc);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 31536000) return `${Math.floor(diff / 2592000)}mo ago`;
  return `${Math.floor(diff / 31536000)}y ago`;
}

function formatScore(score: number): string {
  if (Math.abs(score) >= 1_000_000) {
    return `${(score / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (Math.abs(score) >= 10_000) {
    return `${(score / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return score.toLocaleString();
}

export function PostMeta({ post, showSubreddit = false, showTimestamp = true }: PostMetaProps) {
  const fullDate = post.createdUtc > 0 ? new Date(post.createdUtc * 1000).toLocaleString() : '';
  const relativeDate = post.createdUtc > 0 ? formatRelativeTime(post.createdUtc) : '';

  return (
    <p className="post-meta">
      {showSubreddit && (
        <>
          <Link to={`/r/${post.subreddit}`} className="post-meta-sub">
            r/{post.subreddit}
          </Link>
          <span className="post-meta-dot">·</span>
        </>
      )}
      <Link to={`/u/${post.author}`} className="post-meta-author">
        u/{post.author}
      </Link>
      <span className="post-meta-dot">·</span>
      <span className="post-meta-score" title={`${post.score} points`}>
        {formatScore(post.score)} points
      </span>
      <span className="post-meta-dot">·</span>
      <span className="post-meta-comments">
        {post.numComments.toLocaleString()} comments
      </span>
      {showTimestamp && post.createdUtc > 0 && (
        <>
          <span className="post-meta-dot">·</span>
          <time dateTime={new Date(post.createdUtc * 1000).toISOString()} title={fullDate}>
            {relativeDate}
          </time>
        </>
      )}
      {post.isNsfw && (
        <>
          <span className="post-meta-dot">·</span>
          <strong className="post-nsfw-badge">NSFW</strong>
        </>
      )}
    </p>
  );
}
