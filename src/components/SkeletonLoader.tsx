type SkeletonProps = {
  kind: 'post-card' | 'comment' | 'text';
  count?: number;
};

function SkeletonPostCard() {
  return (
    <div className="skeleton-card">
      <div className="skeleton-line skeleton-heading" />
      <div className="skeleton-line skeleton-meta" />
      <div className="skeleton-media" />
      <div className="skeleton-line skeleton-text-short" />
      <div className="skeleton-actions">
        <div className="skeleton-btn" />
        <div className="skeleton-btn" />
        <div className="skeleton-btn" />
      </div>
    </div>
  );
}

function SkeletonComment() {
  return (
    <div className="skeleton-comment">
      <div className="skeleton-line skeleton-meta" />
      <div className="skeleton-line skeleton-text" />
      <div className="skeleton-line skeleton-text-short" />
    </div>
  );
}

function SkeletonText() {
  return (
    <div className="skeleton-text-block">
      <div className="skeleton-line skeleton-heading" />
      <div className="skeleton-line skeleton-text" />
      <div className="skeleton-line skeleton-text" />
      <div className="skeleton-line skeleton-text-short" />
    </div>
  );
}

export function SkeletonLoader({ kind, count = 1 }: SkeletonProps) {
  const items = Array.from({ length: count }, (_, i) => i);

  return (
    <>
      {items.map((i) => {
        switch (kind) {
          case 'post-card':
            return <SkeletonPostCard key={i} />;
          case 'comment':
            return <SkeletonComment key={i} />;
          case 'text':
            return <SkeletonText key={i} />;
        }
      })}
    </>
  );
}
