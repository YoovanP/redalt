import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { MarkdownText } from '../components/MarkdownText';
import { RenderMedia } from '../components/media/RenderMedia';
import { PostActions } from '../components/post/PostActions';
import { PostHeader } from '../components/post/PostHeader';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { StateView } from '../components/StateView';
import { addWatchHistory } from '../lib/localLibrary';
import { normalizePost } from '../lib/normalizePost';
import { fetchPostDetail, fetchPostMediaEnrichment, getRememberedPost, mergePostCandidates } from '../lib/redditApi';
import { useUiSettings } from '../lib/uiSettings';
import type { NormalizedPost, PostDetailResult, RedditComment, RedditPostData } from '../types/reddit';

const TOP_LEVEL_COMMENTS_STEP = 5;

type PostDetailRouteState = {
  fallbackPost?: NormalizedPost;
};

type CommentItemProps = {
  comment: RedditComment;
  depth?: number;
  postAuthor?: string;
};

const CommentItem = memo(function CommentItem({ comment, depth = 0, postAuthor }: CommentItemProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [showReplies, setShowReplies] = useState(depth === 0);
  const isOp = Boolean(postAuthor && comment.author.toLowerCase() === postAuthor.toLowerCase());
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
      <div className="comment-meta">
        {depth === 0 && (
          <button
            type="button"
            className="comment-collapse-control"
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} comment by ${comment.author}`}
            title={collapsed ? 'Expand comment' : 'Collapse comment'}
            onClick={toggleCollapse}
          >
            {collapsed ? '+' : '−'}
          </button>
        )}
        <strong className="comment-author-wrap">
          <Link to={`/u/${comment.author}`} className="comment-author-link">
            u/{comment.author}
          </Link>
          {isOp && <span className="comment-op-badge" title="Original Poster">OP</span>}
        </strong>
        {comment.parentAuthor && (
          <span className="comment-replying-to">
            replying to <Link to={`/u/${comment.parentAuthor}`}>u/{comment.parentAuthor}</Link>
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
                    <CommentItem key={reply.id} comment={reply} depth={depth + 1} postAuthor={postAuthor} />
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </li>
  );
});

export function PostDetailPage() {
  const { name = 'mildlyinfuriating', id = '' } = useParams();
  const location = useLocation();
  const {
    settings: { fallbackMediaSource, redditApiSource },
  } = useUiSettings();
  const [postData, setPostData] = useState<RedditPostData | null>(null);
  const [comments, setComments] = useState<RedditComment[]>([]);
  const [commentsStatus, setCommentsStatus] = useState<PostDetailResult['commentsStatus'] | 'loading'>('loading');
  const [mediaStatus, setMediaStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const historyPostIdRef = useRef<string | null>(null);
  const mediaEnrichmentControllerRef = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const [visibleTopLevelComments, setVisibleTopLevelComments] = useState(TOP_LEVEL_COMMENTS_STEP);
  const rememberedPost = useMemo(() => {
    const post = getRememberedPost(id);
    return post ? normalizePost(post) : null;
  }, [id]);
  const fallbackPost = useMemo(() => {
    const state = location.state as PostDetailRouteState | null;
    const post = state?.fallbackPost;

    if (post && post.id === id) {
      return post;
    }

    return rememberedPost;
  }, [id, location.state, rememberedPost]);

  useEffect(() => {
    const controller = new AbortController();

    setLoading(true);
    setError(null);
    setPostData(null);
    setComments([]);
    setCommentsStatus('loading');
    setMediaStatus('idle');
    setVisibleTopLevelComments(TOP_LEVEL_COMMENTS_STEP);

    fetchPostDetail(name, id, { signal: controller.signal })
      .then((result) => {
        setPostData(result.post);
        setComments(result.comments);
        setCommentsStatus(result.commentsStatus);
        setMediaStatus(result.mediaStatus === 'ready' ? 'ready' : 'idle');
      })
      .catch((err) => {
        if (controller.signal.aborted) return;

        if (fallbackPost) {
          setCommentsStatus('unavailable');
          setMediaStatus('ready');
        } else {
          setError(err instanceof Error ? err.message : 'Unable to load post detail.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [name, id, fallbackPost, fallbackMediaSource, redditApiSource, retryVersion]);

  useEffect(() => {
    return () => mediaEnrichmentControllerRef.current?.abort();
  }, [id, name]);

  const normalized = useMemo(() => {
    if (!postData) {
      return fallbackPost;
    }

    return normalizePost(postData);
  }, [postData, fallbackPost]);
  const visibleComments = comments.slice(0, visibleTopLevelComments);
  const hasMoreComments = comments.length > visibleComments.length;

  const retryComments = async () => {
    setCommentsStatus('loading');

    try {
      const result = await fetchPostDetail(name, id);
      setPostData((current) => current ? mergePostCandidates(current, [result.post]) : result.post);
      setComments(result.comments);
      setCommentsStatus(result.commentsStatus);

      if (result.mediaStatus === 'incomplete') {
        setMediaStatus('idle');
      }
    } catch {
      setCommentsStatus('unavailable');
    }
  };

  const retryPost = () => {
    setRetryVersion((version) => version + 1);
  };

  const improveMedia = () => {
    if (!postData || mediaStatus === 'loading') {
      return;
    }

    mediaEnrichmentControllerRef.current?.abort();
    const controller = new AbortController();
    mediaEnrichmentControllerRef.current = controller;
    setMediaStatus('loading');

    fetchPostMediaEnrichment(postData, { signal: controller.signal })
      .then((enriched) => {
        if (!controller.signal.aborted) {
          setPostData((current) => current ? mergePostCandidates(current, [enriched]) : enriched);
          setMediaStatus('ready');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setMediaStatus('error');
        }
      })
      .finally(() => {
        if (mediaEnrichmentControllerRef.current === controller) {
          mediaEnrichmentControllerRef.current = null;
        }
      });
  };

  useEffect(() => {
    if (!normalized) {
      return;
    }

    if (historyPostIdRef.current !== normalized.id) {
      historyPostIdRef.current = normalized.id;
      addWatchHistory(normalized);
    }
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
    return (
      <StateView
        kind="error"
        message="This post is temporarily unavailable."
        detail={error ?? 'The post could not be recovered from the current Reddit source.'}
        actionLabel="Try again"
        onAction={retryPost}
        alternateActionLabel="Open on Reddit"
        alternateActionHref={`https://www.reddit.com/r/${encodeURIComponent(name)}/comments/${encodeURIComponent(id)}/`}
      />
    );
  }

  return (
    <section className="detail-page">
      <p className="detail-back-row">
        <Link to={`/r/${name}`} className="detail-back-link">
          <span className="back-arrow" aria-hidden="true">←</span>
          <span>Back to /r/{name}</span>
        </Link>
      </p>
      <PostHeader post={normalized} linked={false} showSubreddit />

      <RenderMedia post={normalized} expanded />

      {mediaStatus === 'loading' && <p className="media-status" role="status">Improving media quality...</p>}
      {mediaStatus === 'idle' && normalized.media.type !== 'text' && (
        <div className="media-status" role="status">
          <p>Some media details are missing. The post is still usable; you can request a one-time repair if needed.</p>
          <button type="button" className="load-more" onClick={improveMedia}>
            Improve media
          </button>
        </div>
      )}
      {mediaStatus === 'error' && (
        <div className="media-status" role="status">
          <p>Media details could not be improved right now.</p>
          <button type="button" className="load-more" onClick={improveMedia}>
            Retry media repair
          </button>
        </div>
      )}

      {normalized.media.type !== 'text' && normalized.selfText.trim() && (
        <MarkdownText text={normalized.selfText} className="self-text-markdown self-text" />
      )}

      <PostActions post={normalized} showComments={false} />

      {commentsStatus === 'loading' && (
        <div className="comments-status" role="status">
          <p>Loading comments...</p>
        </div>
      )}

      {commentsStatus === 'unavailable' && (
        <div className="comments-status" role="status">
          <p>The post loaded, but comments are temporarily unavailable.</p>
          <button type="button" className="load-more" onClick={retryComments}>
            Retry comments
          </button>
        </div>
      )}

      {commentsStatus === 'empty' && <p className="comments-status">No comments yet.</p>}

      {comments.length > 0 && (
        <div>
          <h3>Top comments</h3>
          <ul className="comments-root">
            {visibleComments.map((comment) => (
              <CommentItem key={comment.id} comment={comment} postAuthor={normalized.author} />
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
