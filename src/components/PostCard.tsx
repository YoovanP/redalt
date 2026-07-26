import { memo, useState } from 'react';
import { writeStorageItem } from '../lib/browserStorage';
import { MarkdownText } from './MarkdownText';
import { RenderMedia } from './media/RenderMedia';
import { PostActions } from './post/PostActions';
import { PostHeader } from './post/PostHeader';
import { useOpenInNewTab, type CardMode } from '../lib/uiSettings';
import type { NormalizedPost } from '../types/reddit';

type PostCardProps = {
  post: NormalizedPost;
  cardMode?: CardMode;
};

const PREVIEW_TEXT_LIMIT = 320;

export const PostCard = memo(function PostCard({ post, cardMode = 'default' }: PostCardProps) {
  const openInNewTab = useOpenInNewTab();
  const [showFullText, setShowFullText] = useState(false);
  const [showContentInfo, setShowContentInfo] = useState(false);
  const isContentOnly = cardMode === 'content-only';
  const showInfoBlock = !isContentOnly || showContentInfo;

  const trimmedSelfText = post.selfText.trim();
  const isLongText = trimmedSelfText.length > PREVIEW_TEXT_LIMIT;
  const textClassName =
    isLongText && !showFullText
      ? 'self-text-markdown self-text-collapsed self-text-preview'
      : 'self-text-markdown self-text-preview';

  const rememberSubredditScroll = () => {
    if (openInNewTab) {
      return;
    }

    writeStorageItem('session', `redalt.subreddit.scroll.${post.subreddit}`, String(window.scrollY));
    writeStorageItem('session', `redalt.subreddit.restore.${post.subreddit}`, '1');
  };

  return (
    <article className={`post-card post-card-${cardMode}`}>
      {showInfoBlock && (
        <PostHeader post={post} openInNewTab={openInNewTab} onNavigate={rememberSubredditScroll} />
      )}

      <RenderMedia post={post} />

      {trimmedSelfText && post.media.type !== 'text' && (
        <div>
          <MarkdownText
            text={trimmedSelfText}
            className={textClassName}
            maxSourceLength={!showFullText && isLongText ? PREVIEW_TEXT_LIMIT : undefined}
          />
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
        <>
          <PostActions post={post} openInNewTab={openInNewTab} onNavigate={rememberSubredditScroll} />
          {isContentOnly && (
            <button
              type="button"
              className="post-action-button"
              onClick={() => setShowContentInfo(false)}
            >
              Hide info
            </button>
          )}
        </>
      )}
    </article>
  );
});
