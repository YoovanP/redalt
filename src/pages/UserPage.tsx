import { type CSSProperties, useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { LoadMoreButton } from '../components/LoadMoreButton';
import { SortControls } from '../components/SortControls';
import { PostCard } from '../components/PostCard';
import { ShortsFeed } from '../components/ShortsFeed';
import { StateView } from '../components/StateView';
import { getValidatedListingSort, getValidatedTopTimeRange, isMediaPost } from '../lib/feedUtils';
import { fetchUserListing, type FetchListingOptions, type ListingSort, type TopTimeRange } from '../lib/redditApi';
import { useUiSettings } from '../lib/uiSettings';
import { useNearEndLoadMore, usePostListingFeed } from '../lib/usePostListingFeed';

export function UserPage() {
  const {
    settings: { columns, videoFeedMode, cardMode, loadMoreMode, fallbackMediaSource, redditApiSource },
  } = useUiSettings();
  const { username = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const sort = getValidatedListingSort(searchParams.get('sort'));
  const topTimeRange = getValidatedTopTimeRange(searchParams.get('t'));
  const fetchPage = useCallback(
    (options: FetchListingOptions) =>
      fetchUserListing(username, {
        ...options,
        sort,
        topTimeRange,
      }),
    [username, sort, topTimeRange],
  );

  const onSortChange = (nextSort: ListingSort) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('sort', nextSort);

    if (nextSort !== 'top') {
      nextParams.delete('t');
    } else if (!nextParams.get('t')) {
      nextParams.set('t', 'day');
    }

    setSearchParams(nextParams);
  };

  const onTopTimeRangeChange = (nextRange: TopTimeRange) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('sort', 'top');
    nextParams.set('t', nextRange);
    setSearchParams(nextParams);
  };

  const {
    normalizedPosts,
    after,
    loading,
    loadingMore,
    error,
    loadMoreError,
    loadMore,
  } = usePostListingFeed({
    sourceKey: `${username}:${sort}:${topTimeRange}:${fallbackMediaSource}:${redditApiSource}`,
    fetchPage,
    videoFeedMode,
    initialErrorMessage: 'Unable to load user feed.',
  });

  const visiblePosts = useMemo(() => {
    if (!videoFeedMode) {
      return normalizedPosts;
    }

    return normalizedPosts.filter((post) => isMediaPost(post.media.type));
  }, [normalizedPosts, videoFeedMode]);
  const { nearEndRef, triggerIndex } = useNearEndLoadMore({
    after,
    loadingMore,
    disabled: videoFeedMode || loadMoreMode === 'button',
    itemCount: visiblePosts.length,
    loadMore,
  });

  if (loading) {
    return <StateView kind="loading" />;
  }

  if (error) {
    return <StateView kind="error" message={error} />;
  }

  if (visiblePosts.length === 0) {
    return (
      <section>
        <StateView
          kind="empty"
          message={videoFeedMode ? 'No media posts found in the pages checked for this user.' : 'This user has no visible posts.'}
        />
        {after && (
          <div>
            <LoadMoreButton loading={loadingMore} onClick={loadMore}>
              Check more posts
            </LoadMoreButton>
            {loadMoreError && <p className="meta">{loadMoreError}</p>}
          </div>
        )}
      </section>
    );
  }

  return (
    <section>
      {!videoFeedMode && (
        <>
          <h2>/u/{username}</h2>
          <div className="feed-toolbar">
            <SortControls
              sort={sort}
              topTimeRange={topTimeRange}
              onSortChange={onSortChange}
              onTopTimeRangeChange={onTopTimeRangeChange}
            />
          </div>
        </>
      )}

      {videoFeedMode ? (
        <ShortsFeed
          posts={visiblePosts}
          hasMore={Boolean(after)}
          loadingMore={loadingMore}
          onNearEnd={loadMore}
        />
      ) : (
        <div className="post-list" style={{ '--post-columns': columns } as CSSProperties}>
          {visiblePosts.map((post, index) => (
            <article key={post.name}>
              {index === triggerIndex && after && <div ref={nearEndRef} className="near-end-trigger" />}
              <PostCard post={post} cardMode={cardMode} />
            </article>
          ))}
        </div>
      )}

      {after && !videoFeedMode && (
        <div>
          <LoadMoreButton loading={loadingMore} onClick={loadMore}>
            Load more
          </LoadMoreButton>
          {loadMoreError && <p className="meta">{loadMoreError}</p>}
        </div>
      )}
    </section>
  );
}
