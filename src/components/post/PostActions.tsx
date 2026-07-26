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
          className="post-action-button"
          to={path}
          state={{ fromSubreddit: post.subreddit, fallbackPost: post }}
          onClick={onNavigate}
          target={openInNewTab ? '_blank' : undefined}
          rel={openInNewTab ? 'noopener noreferrer' : undefined}
        >Comments</Link>
      )}
      <button type="button" className="post-action-button" onClick={share}>
        {shareState === 'idle' ? 'Share' : shareState === 'done' ? 'Shared' : 'Failed'}
      </button>
      <button type="button" className="post-action-button" onClick={() => setSaved(toggleSavedPost(post))}>
        {saved ? 'Unsave' : 'Save'}
      </button>
      <a className="post-action-button" href={`https://www.reddit.com${post.permalink}`} target="_blank" rel="noreferrer">Open on Reddit</a>
      {post.outboundUrl !== `https://www.reddit.com${post.permalink}` && (
        <a className="post-action-button" href={post.outboundUrl} target="_blank" rel="noreferrer">Open source</a>
      )}
    </footer>
  );
}
