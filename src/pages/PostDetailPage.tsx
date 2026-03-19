import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MarkdownText } from '../components/MarkdownText';
import { RenderMedia } from '../components/media/RenderMedia';
import { StateView } from '../components/StateView';
import { addWatchHistory, isPostSaved, toggleSavedPost } from '../lib/localLibrary';
import { normalizePost } from '../lib/normalizePost';
import { fetchPostDetail } from '../lib/redditApi';
import type { PostDetailResult, RedditComment } from '../types/reddit';

const TOP_LEVEL_COMMENTS_STEP = 5;

type CommentItemProps = {
  comment: RedditComment;
  depth?: number;
};

function CommentItem({ comment, depth = 0 }: CommentItemProps) {
  const [showReplies, setShowReplies] = useState(true);
  const itemClassName = depth === 0 ? 'comment-item comment-item-root' : 'comment-item comment-item-child';

  return (
    <li className={itemClassName}>
      <div className="comment-meta">
        <strong>
          <Link to={`/u/${comment.author}`}>u/{comment.author}</Link>
        </strong>
        {comment.parentAuthor && (
          <span>
            replying to <Link to={`/u/${comment.parentAuthor}`}>u/{comment.parentAuthor}</Link>
          </span>
        )}
      </div>
      <MarkdownText text={comment.body} className="self-text-markdown comment-body" />

      {comment.replies.length > 0 && (
        <>
          <button
            type="button"
            className="comment-toggle"
            onClick={() => setShowReplies((current) => !current)}
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
    </li>
  );
}

export function PostDetailPage() {
  const { name = 'mildlyinfuriating', id = '' } = useParams();
  const [data, setData] = useState<PostDetailResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shareState, setShareState] = useState<'idle' | 'done' | 'error'>('idle');
  const [saved, setSaved] = useState(false);
  const [visibleTopLevelComments, setVisibleTopLevelComments] = useState(TOP_LEVEL_COMMENTS_STEP);

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
          setError(err instanceof Error ? err.message : 'Unable to load post detail.');
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
  }, [name, id]);

  const normalized = useMemo(() => {
    if (!data) {
      return null;
    }

    return normalizePost(data.post);
  }, [data]);
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

  if (loading) {
    return <StateView kind="loading" />;
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
