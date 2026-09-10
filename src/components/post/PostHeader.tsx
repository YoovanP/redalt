import { Link } from 'react-router-dom';
import { prefetchPostDetail } from '../../lib/redditApi';
import type { NormalizedPost } from '../../types/reddit';
import { PostMeta } from './PostMeta';

type PostHeaderProps = {
  post: NormalizedPost;
  headingLevel?: 2 | 3 | 4;
  linked?: boolean;
  showSubreddit?: boolean;
  openInNewTab?: boolean;
  onNavigate?: () => void;
};

export function PostHeader({
  post,
  headingLevel = 2,
  linked = true,
  showSubreddit = false,
  openInNewTab = false,
  onNavigate,
}: PostHeaderProps) {
  const Heading = `h${headingLevel}` as const;
  const path = `/r/${post.subreddit}/comments/${post.id}`;
  // Start the detail request while the pointer/keyboard is on the way to the
  // click. Skipped for the detail page's own header (linked=false) and for
  // new-tab links, whose request is served by the gateway cache instead.
  const prefetch = linked && !openInNewTab ? () => prefetchPostDetail(post.subreddit, post.id) : undefined;

  return (
    <header className="post-header">
      <Heading>
        {linked ? (
          <Link
            to={path}
            state={{ fromSubreddit: post.subreddit, fallbackPost: post }}
            onClick={onNavigate}
            onPointerEnter={prefetch}
            onFocus={prefetch}
            target={openInNewTab ? '_blank' : undefined}
            rel={openInNewTab ? 'noopener noreferrer' : undefined}
          >
            {post.title}
          </Link>
        ) : post.title}
      </Heading>
      {post.flairText && <p className="post-flair">{post.flairText}</p>}
      <PostMeta post={post} showSubreddit={showSubreddit} />
    </header>
  );
}
