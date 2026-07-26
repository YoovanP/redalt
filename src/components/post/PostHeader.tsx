import { Link } from 'react-router-dom';
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

  return (
    <header className="post-header">
      <Heading>
        {linked ? (
          <Link
            to={path}
            state={{ fromSubreddit: post.subreddit, fallbackPost: post }}
            onClick={onNavigate}
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
