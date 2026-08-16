import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { invalidateSavedPostsCache, isPostSaved, LIBRARY_UPDATE_EVENT, toggleSavedPost, type LibraryUpdateDetail } from '../../lib/localLibrary';
import type { NormalizedPost } from '../../types/reddit';

type PostActionsProps = {
  post: NormalizedPost;
  showComments?: boolean;
  openInNewTab?: boolean;
  onNavigate?: () => void;
};

export function PostActions({ post, showComments = true, openInNewTab = false, onNavigate }: PostActionsProps) {
  const [shareState, setShareState] = useState<'idle' | 'done' | 'error'>('idle');
  const [saved, setSaved] = useState(() => isPostSaved(post.id));
  const path = `/r/${post.subreddit}/comments/${post.id}`;

  useEffect(() => {
    const refresh = () => setSaved(isPostSaved(post.id));
    const onLibraryUpdate = (event: Event) => {
      if ((event as CustomEvent<LibraryUpdateDetail>).detail?.kind === 'saved') refresh();
    };
    const onStorage = () => {
      invalidateSavedPostsCache();
      refresh();
    };
    window.addEventListener(LIBRARY_UPDATE_EVENT, onLibraryUpdate);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(LIBRARY_UPDATE_EVENT, onLibraryUpdate);
      window.removeEventListener('storage', onStorage);
    };
  }, [post.id]);

  const share = async () => {
    const url = `https://www.reddit.com${post.permalink}`;
    try {
      if (navigator.share) await navigator.share({ title: post.title, url });
      else await navigator.clipboard.writeText(url);
      setShareState('done');
    } catch {
      setShareState('error');
    }
    window.setTimeout(() => setShareState('idle'), 1_400);
  };

  return (
    <footer className="post-actions">
      {showComments && (
        <Link
          className="post-action-button post-action-comments"
          to={path}
          state={{ fromSubreddit: post.subreddit, fallbackPost: post }}
          onClick={onNavigate}
          target={openInNewTab ? '_blank' : undefined}
          rel={openInNewTab ? 'noopener noreferrer' : undefined}
        >
          <svg className="action-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          Comments
        </Link>
      )}
      <button
        type="button"
        className={`post-action-button post-action-share${shareState === 'done' ? ' post-action-active' : ''}`}
        onClick={share}
      >
        <svg className="action-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {shareState === 'done' ? (
            <polyline points="20 6 9 17 4 12" />
          ) : (
            <>
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
            </>
          )}
        </svg>
        {shareState === 'idle' ? 'Share' : shareState === 'done' ? 'Shared' : 'Failed'}
      </button>
      <button
        type="button"
        className={`post-action-button post-action-save${saved ? ' post-action-active' : ''}`}
        onClick={() => setSaved(toggleSavedPost(post))}
      >
        <svg className="action-icon" viewBox="0 0 24 24" width="15" height="15" fill={saved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
        {saved ? 'Unsave' : 'Save'}
      </button>
      <a
        className="post-action-button post-action-reddit"
        href={`https://www.reddit.com${post.permalink}`}
        target="_blank"
        rel="noreferrer"
      >
        <svg className="action-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
        Open on Reddit
      </a>
      {post.outboundUrl !== `https://www.reddit.com${post.permalink}` && (
        <a
          className="post-action-button post-action-source"
          href={post.outboundUrl}
          target="_blank"
          rel="noreferrer"
        >
          <svg className="action-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          Open source
        </a>
      )}
    </footer>
  );
}
