import { SkeletonLoader } from './SkeletonLoader';

type StateViewProps = {
  kind: 'loading' | 'empty' | 'error';
  message?: string;
  skeletonCount?: number;
};

export function StateView({ kind, message, skeletonCount = 3 }: StateViewProps) {
  if (kind === 'loading') {
    return (
      <div className="state-view state-loading" aria-busy="true">
        <SkeletonLoader kind="post-card" count={skeletonCount} />
      </div>
    );
  }

  const defaultMessage =
    kind === 'empty'
      ? 'No posts found.'
      : 'Something went wrong.';

  return (
    <div className={`state-view state-${kind}`}>
      <p>{message ?? defaultMessage}</p>
    </div>
  );
}
