import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { MarkdownText } from '../components/MarkdownText';
import { RenderMedia } from '../components/media/RenderMedia';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { StateView } from '../components/StateView';
import { addWatchHistory, isPostSaved, toggleSavedPost } from '../lib/localLibrary';
import { normalizePost } from '../lib/normalizePost';
import { fetchPostDetail } from '../lib/redditApi';
import { useUiSettings } from '../lib/uiSettings';
import type { NormalizedPost, PostDetailResult, RedditComment } from '../types/reddit';

const TOP_LEVEL_COMMENTS_STEP = 5;

type PostDetailRouteState = {
  fallbackPost?: NormalizedPost;
};

type CommentItemProps = {
  comment: RedditComment;
  depth?: number;
};

function getMediaStrength(post: NormalizedPost | null): number {
  if (!post) {
    return -1;
  }

  switch (post.media.type) {
    case 'video':
    case 'external':
    case 'gallery':
      return 4;
    case 'image':
      return 3;
    case 'text':
      return 1;
    case 'link':
    default:
      return 0;
  }
}

function preferRicherPost(detailPost: NormalizedPost, fallbackPost: NormalizedPost | null): NormalizedPost {
  if (!fallbackPost || fallbackPost.id !== detailPost.id) {
    return detailPost;
  }

  if (getMediaStrength(detailPost) >= getMediaStrength(fallbackPost)) {
    return detailPost;
  }

  return {
    ...detailPost,
    flairText: detailPost.flairText || fallbackPost.flairText,
    isNsfw: detailPost.isNsfw || fallbackPost.isNsfw,
    outboundUrl: fallbackPost.outboundUrl || detailPost.outboundUrl,
    selfText: detailPost.selfText || fallbackPost.selfText,
    media: fallbackPost.media,
  };
}

function CommentItem({ comment, depth = 0 }: CommentItemProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [showReplies, setShowReplies] = useState(true);
  const itemClassName = depth === 0
    ? `comment-item comment-item-root${collapsed ? ' comment-root-collapsed' : ''}`
    : 'comment-item comment-item-child';

  const toggleCollapse = () => {
    if (depth === 0) {
      setCollapsed((c) => !c);
    }
  };

  return (
    <li className={itemClassName}>
      <div className="comment-meta" onClick={toggleCollapse} role={depth === 0 ? 'button' : undefined} tabIndex={depth === 0 ? 0 : undefined} onKeyDown={depth === 0 ? (e) => { if (e.key === 'Enter') toggleCollapse(); } : undefined}>
        <strong>
          <Link to={`/u/${comment.author}`} onClick={(e) => e.stopPropagation()}>u/{comment.author}</Link>
        </strong>
        {comment.parentAuthor && (
          <span>
            replying to <Link to={`/u/${comment.parentAuthor}`} onClick={(e) => e.stopPropagation()}>u/{comment.parentAuthor}</Link>
          </span>
        )}
      </div>

      {!collapsed && (
        <>
          <MarkdownText text={comment.body} className="self-text-markdown comment-body" />

          {comment.replies.length > 0 && (
            <>
              <button
                type="button"
                className="comment-toggle"
                onClick={(e) => { e.stopPropagation(); setShowReplies((current) => !current); }}
              >
                {showReplies ? 'Hide' : 'Show'} replies ({comment.replies.length})
              </button>

              {showReplies && (
                <ul className="comments-children">
                  {comment.replies.map((reply) => (
                    <CommentItem key={reply.id} comment={reply} depth={depth + 1} />
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </li>
  );
}

export function PostDetailPage() {
  const { name = 'mildlyinfuriating', id = '' } = useParams();
  const location = useLocation();
  const {
    settings: { fallbackMediaSource },
  } = useUiSettings();
  const [data, setData] = useState<PostDetailResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shareState, setShareState] = useState<'idle' | 'done' | 'error'>('idle');
  const [saved, setSaved] = useState(false);
  const [visibleTopLevelComments, setVisibleTopLevelComments] = useState(TOP_LEVEL_COMMENTS_STEP);
  const fallbackPost = useMemo(() => {
    const state = location.state as PostDetailRouteState | null;
    const post = state?.fallbackPost;

    if (!post || post.id !== id) {
      return null;
    }

    return post;
  }, [id, location.state]);

  useEffect(() => {
    let ignore = false;

    setLoading(true);
    setError(null);
    setData(null);
    setVisibleTopLevelComments(TOP_LEVEL_COMMENTS_STEP);

    fetchPostDetail(name, id)
      .then((result) => {
        if (!ignore) {
          setData(result);
        }
      })
      .catch((err) => {
        if (!ignore) {
          if (fallbackPost) {
            setError(null);
          } else {
            setError(err instanceof Error ? err.message : 'Unable to load post detail.');
          }
        }
      })
      .finally(() => {
        if (!ignore) {
          setLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [name, id, fallbackPost, fallbackMediaSource]);

  const normalized = useMemo(() => {
    if (!data) {
      return fallbackPost;
    }

    return preferRicherPost(normalizePost(data.post), fallbackPost);
  }, [data, fallbackPost]);
  const comments = data?.comments ?? [];
  const visibleComments = comments.slice(0, visibleTopLevelComments);
  const hasMoreComments = comments.length > visibleComments.length;

  useEffect(() => {
    if (!normalized) {
      return;
    }

    addWatchHistory(normalized);
    setSaved(isPostSaved(normalized.id));
  }, [normalized]);

  if (loading && !normalized) {
    return (
      <section className="detail-page">
        <SkeletonLoader kind="text" count={1} />
        <div style={{ marginTop: '1.5rem' }}>
          <SkeletonLoader kind="comment" count={4} />
        </div>
      </section>
    );
  }

  if (error || !normalized) {
    return <StateView kind="error" message={error ?? 'Post unavailable.'} />;
  }

  const onShare = async () => {
    const shareUrl = `https://www.reddit.com${normalized.permalink}`;

    try {
      if (navigator.share) {
        await navigator.share({
          title: normalized.title,
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
    <section className="detail-page">
      <p>
        <Link to={`/r/${name}`}>← Back to /r/{name}</Link>
      </p>
      <h2>{normalized.title}</h2>
      <p className="meta">
        <Link to={`/u/${normalized.author}`}>u/{normalized.author}</Link> · {normalized.score} points · {normalized.numComments} comments
      </p>

      <RenderMedia post={normalized} expanded />

      {normalized.media.type !== 'text' && normalized.selfText.trim() && (
        <MarkdownText text={normalized.selfText} className="self-text-markdown self-text" />
      )}

      <p className="post-links">
        <a href={`https://www.reddit.com${normalized.permalink}`} target="_blank" rel="noreferrer">
          Open discussion on Reddit
        </a>
        <button type="button" onClick={() => setSaved(toggleSavedPost(normalized))}>
          {saved ? 'Unsave' : 'Save'}
        </button>
        <button type="button" onClick={onShare}>
          {shareState === 'idle' ? 'Share' : shareState === 'done' ? 'Shared' : 'Failed'}
        </button>
      </p>

      {comments.length > 0 && (
        <div>
          <h3>Top comments</h3>
          <ul className="comments-root">
            {visibleComments.map((comment) => (
              <CommentItem key={comment.id} comment={comment} />
            ))}
          </ul>

          {hasMoreComments && (
            <button
              type="button"
              className="load-more"
              onClick={() => setVisibleTopLevelComments((count) => count + TOP_LEVEL_COMMENTS_STEP)}
            >
              Show more comments ({comments.length - visibleComments.length} left)
            </button>
          )}
        </div>
      )}
    </section>
  );
}
