import { Link } from 'react-router-dom';
import type { NormalizedPost } from '../../types/reddit';

type PostMetaProps = {
  post: NormalizedPost;
  showSubreddit?: boolean;
  showTimestamp?: boolean;
};

export function PostMeta({ post, showSubreddit = false, showTimestamp = true }: PostMetaProps) {
  return (
    <p className="post-meta">
      {showSubreddit && <><Link to={`/r/${post.subreddit}`}>r/{post.subreddit}</Link><span>·</span></>}
      <Link to={`/u/${post.author}`}>u/{post.author}</Link>
      <span>·</span><span>{post.score} points</span>
      <span>·</span><span>{post.numComments} comments</span>
      {showTimestamp && post.createdUtc > 0 && <><span>·</span><time dateTime={new Date(post.createdUtc * 1000).toISOString()}>{new Date(post.createdUtc * 1000).toLocaleString()}</time></>}
      {post.isNsfw && <><span>·</span><strong>NSFW</strong></>}
    </p>
  );
}
