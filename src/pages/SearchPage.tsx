import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { LoadMoreButton } from '../components/LoadMoreButton';
import { PostCard } from '../components/PostCard';
import { StateView } from '../components/StateView';
import { addCustomFeedSubreddit } from '../lib/customFeed';
import { getValidatedTopTimeRange } from '../lib/feedUtils';
import { normalizePost } from '../lib/normalizePost';
import {
  fetchGlobalSearch,
  type SearchSort,
  type SearchSubredditResult,
  type SearchUserResult,
} from '../lib/redditApi';
import { useUiSettings } from '../lib/uiSettings';
import type { RedditPostData } from '../types/reddit';

type MediaFilter = 'all' | 'text' | 'image' | 'gallery' | 'video' | 'external' | 'link';

const DEFAULT_POST_LIMIT = 16;
const DEFAULT_SUBREDDIT_LIMIT = 12;
const DEFAULT_USER_LIMIT = 12;
const MAX_SEARCH_LIMIT = 60;
const POST_LIMIT_STEP = 16;
const COMMUNITY_LIMIT_STEP = 12;

function getValidatedSearchSort(input: string | null): SearchSort {
  if (input === 'relevance' || input === 'hot' || input === 'new' || input === 'top' || input === 'comments') {
    return input;
  }

  return 'relevance';
}

function getValidatedMediaFilter(input: string | null): MediaFilter {
  if (
    input === 'all' ||
    input === 'text' ||
    input === 'image' ||
    input === 'gallery' ||
    input === 'video' ||
    input === 'external' ||
    input === 'link'
  ) {
    return input;
  }

  return 'all';
}

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = (searchParams.get('q') ?? '').trim();
  const sort = getValidatedSearchSort(searchParams.get('sort'));
  const topTimeRange = getValidatedTopTimeRange(searchParams.get('t'));
  const subredditScope = (searchParams.get('subreddit') ?? '').trim().replace(/^\/?r\//i, '');
  const includeNsfw = searchParams.get('nsfw') !== '0';
  const mediaFilter = getValidatedMediaFilter(searchParams.get('media'));
  const {
    settings: { cardMode, fallbackMediaSource, redditApiSource },
  } = useUiSettings();

  const [posts, setPosts] = useState<RedditPostData[]>([]);
  const [subreddits, setSubreddits] = useState<SearchSubredditResult[]>([]);
  const [users, setUsers] = useState<SearchUserResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState<null | 'posts' | 'subreddits' | 'users'>(null);
  const [error, setError] = useState<string | null>(null);
  const [postLimit, setPostLimit] = useState(DEFAULT_POST_LIMIT);
  const [subredditLimit, setSubredditLimit] = useState(DEFAULT_SUBREDDIT_LIMIT);
  const [userLimit, setUserLimit] = useState(DEFAULT_USER_LIMIT);
  const prevSearchKeyRef = useRef<string | null>(null);
  const searchKey = `${query}|${sort}|${topTimeRange}|${subredditScope}|${includeNsfw}|${fallbackMediaSource}|${redditApiSource}`;

  useEffect(() => {
    let ignore = false;
    const isNewSearch = prevSearchKeyRef.current !== searchKey;

    if (query.length < 2) {
      setPosts([]);
      setSubreddits([]);
      setUsers([]);
      setError(null);
      setLoading(false);
      setLoadingMore(null);
      if (
        postLimit !== DEFAULT_POST_LIMIT ||
        subredditLimit !== DEFAULT_SUBREDDIT_LIMIT ||
        userLimit !== DEFAULT_USER_LIMIT
      ) {
        setPostLimit(DEFAULT_POST_LIMIT);
        setSubredditLimit(DEFAULT_SUBREDDIT_LIMIT);
        setUserLimit(DEFAULT_USER_LIMIT);
      }
      prevSearchKeyRef.current = searchKey;
      return () => {
        ignore = true;
      };
    }

    if (
      isNewSearch &&
      (postLimit !== DEFAULT_POST_LIMIT ||
        subredditLimit !== DEFAULT_SUBREDDIT_LIMIT ||
        userLimit !== DEFAULT_USER_LIMIT)
    ) {
      setPostLimit(DEFAULT_POST_LIMIT);
      setSubredditLimit(DEFAULT_SUBREDDIT_LIMIT);
      setUserLimit(DEFAULT_USER_LIMIT);
      setLoading(false);
      setLoadingMore(null);
      return () => {
        ignore = true;
      };
    }

    if (isNewSearch) {
      setLoading(true);
      setLoadingMore(null);
    }
    setError(null);

    fetchGlobalSearch(query, {
      sort,
      topTimeRange,
      subredditScope,
      includeNsfw,
      postLimit,
      subredditLimit,
      userLimit,
    })
      .then((result) => {
        if (ignore) {
          return;
        }

        setPosts(result.posts);
        setSubreddits(result.subreddits);
        setUsers(result.users);
      })
      .catch((err: unknown) => {
        if (ignore) {
          return;
        }

        setError(err instanceof Error ? err.message : 'Unable to search right now.');
      })
      .finally(() => {
        if (!ignore) {
          setLoading(false);
          setLoadingMore(null);
          prevSearchKeyRef.current = searchKey;
        }
      });

    return () => {
      ignore = true;
    };
  }, [
    query,
    sort,
    topTimeRange,
    subredditScope,
    includeNsfw,
    postLimit,
    subredditLimit,
    userLimit,
    searchKey,
    fallbackMediaSource,
    redditApiSource,
  ]);

  const normalizedPosts = useMemo(
    () =>
      posts
        .map(normalizePost)
        .filter((post) => {
          if (mediaFilter === 'all') {
            return true;
          }

          return post.media.type === mediaFilter;
        }),
    [posts, mediaFilter],
  );
  const hasResults = normalizedPosts.length > 0 || subreddits.length > 0 || users.length > 0;
  const canLoadMorePosts = posts.length >= postLimit && postLimit < MAX_SEARCH_LIMIT;
  const canLoadMoreSubreddits = subreddits.length >= subredditLimit && subredditLimit < MAX_SEARCH_LIMIT;
  const canLoadMoreUsers = users.length >= userLimit && userLimit < MAX_SEARCH_LIMIT;

  const setFilterParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);

    if (value === null || value.length === 0) {
      next.delete(key);
    } else {
      next.set(key, value);
    }

    setSearchParams(next);
  };

  if (loading) {
    return <StateView kind="loading" message={`Searching for "${query}"...`} />;
  }

  if (error) {
    return <StateView kind="error" message={error} />;
  }

  if (query.length < 2) {
    return <StateView kind="empty" message="Type at least 2 characters to search posts, subreddits, and users." />;
  }

  if (!hasResults) {
    return <StateView kind="empty" message={`No results found for "${query}".`} />;
  }

  return (
    <section className="search-page">
      <h2>Search results for "{query}"</h2>

      <div className="sort-controls" role="group" aria-label="Search filters">
        <label>
          Sort
          <select value={sort} onChange={(event) => setFilterParam('sort', event.target.value)}>
            <option value="relevance">relevance</option>
            <option value="hot">hot</option>
            <option value="new">new</option>
            <option value="top">top</option>
            <option value="comments">comments</option>
          </select>
        </label>

        <label>
          Top range
          <select value={topTimeRange} onChange={(event) => setFilterParam('t', event.target.value)}>
            <option value="hour">hour</option>
            <option value="day">day</option>
            <option value="week">week</option>
            <option value="month">month</option>
            <option value="year">year</option>
            <option value="all">all</option>
          </select>
        </label>

        <label>
          Subreddit
          <input
            value={subredditScope}
            onChange={(event) => setFilterParam('subreddit', event.target.value.trim())}
            placeholder="all"
          />
        </label>

        <label>
          Media
          <select value={mediaFilter} onChange={(event) => setFilterParam('media', event.target.value)}>
            <option value="all">all</option>
            <option value="text">text</option>
            <option value="image">image</option>
            <option value="gallery">gallery</option>
            <option value="video">video</option>
            <option value="external">external</option>
            <option value="link">link</option>
          </select>
        </label>

        <label>
          <input
            type="checkbox"
            checked={includeNsfw}
            onChange={(event) => setFilterParam('nsfw', event.target.checked ? '1' : '0')}
          />
          Include NSFW
        </label>
      </div>

      {subreddits.length > 0 && (
        <section className="search-section">
          <h3>Subreddits</h3>
          <div className="search-chip-list">
            {subreddits.map((subreddit) => (
              <article key={subreddit.name} className="search-chip-card">
                {subreddit.iconUrl && <img src={subreddit.iconUrl} alt="" loading="lazy" />}
                <div className="search-chip-content">
                  <strong><Link to={`/r/${subreddit.name}`}>r/{subreddit.name}</Link></strong>
                  <p>{subreddit.title}</p>
                  <span>{subreddit.subscribers.toLocaleString()} members{` ${subreddit.isNsfw ? '· NSFW' : ''}`}</span>
                </div>
                <button
                  type="button"
                  aria-label={`Add r/${subreddit.name} to custom feed`}
                  title="Add to custom feed"
                  className="search-chip-add"
                  onClick={() => addCustomFeedSubreddit(subreddit.name)}
                >
                  +
                </button>
              </article>
            ))}
          </div>
          {canLoadMoreSubreddits && (
            <LoadMoreButton
              loading={loadingMore === 'subreddits'}
              disabled={loading || loadingMore !== null}
              onClick={() => {
                setLoadingMore('subreddits');
                setSubredditLimit((limit) => Math.min(limit + COMMUNITY_LIMIT_STEP, MAX_SEARCH_LIMIT));
              }}
            >
              View more subreddits
            </LoadMoreButton>
          )}
        </section>
      )}

      {users.length > 0 && (
        <section className="search-section">
          <h3>Users</h3>
          <div className="search-chip-list">
            {users.map((user) => (
              <Link key={user.name} to={`/u/${user.name}`} className="search-chip-card">
                {user.iconUrl && <img src={user.iconUrl} alt="" loading="lazy" />}
                <div>
                  <strong>u/{user.name}</strong>
                  <span>{user.totalKarma.toLocaleString()} karma</span>
                </div>
              </Link>
            ))}
          </div>
          {canLoadMoreUsers && (
            <LoadMoreButton
              loading={loadingMore === 'users'}
              disabled={loading || loadingMore !== null}
              onClick={() => {
                setLoadingMore('users');
                setUserLimit((limit) => Math.min(limit + COMMUNITY_LIMIT_STEP, MAX_SEARCH_LIMIT));
              }}
            >
              View more users
            </LoadMoreButton>
          )}
        </section>
      )}

      {normalizedPosts.length > 0 && (
        <section className="search-section">
          <h3>Posts</h3>
          <div className="post-list" style={{ '--post-columns': 1 } as CSSProperties}>
            {normalizedPosts.map((post) => (
              <article key={post.name}>
                <PostCard post={post} cardMode={cardMode} />
              </article>
            ))}
          </div>
          {canLoadMorePosts && (
            <LoadMoreButton
              loading={loadingMore === 'posts'}
              disabled={loading || loadingMore !== null}
              onClick={() => {
                setLoadingMore('posts');
                setPostLimit((limit) => Math.min(limit + POST_LIMIT_STEP, MAX_SEARCH_LIMIT));
              }}
            >
              View more posts
            </LoadMoreButton>
          )}
        </section>
      )}
    </section>
  );
}
