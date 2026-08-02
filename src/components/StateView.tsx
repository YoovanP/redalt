import { SkeletonLoader } from './SkeletonLoader';

type StateViewProps = {
  kind: 'loading' | 'empty' | 'error';
  message?: string;
  detail?: string;
  skeletonCount?: number;
  actionLabel?: string;
  onAction?: () => void;
  alternateActionLabel?: string;
  alternateActionHref?: string;
};

export function StateView({
  kind,
  message,
  detail,
  skeletonCount = 3,
  actionLabel,
  onAction,
  alternateActionLabel,
  alternateActionHref,
}: StateViewProps) {
  if (kind === 'loading') {
    return (
      <div className="state-view state-loading" aria-busy="true" aria-live="polite">
        <div className="state-copy">
          <span className="state-label">LIVE FEED</span>
          <p className="state-message">{message ?? 'Connecting to Reddit…'}</p>
          <p className="state-detail">We’ll keep this short and leave you a clear retry if the source is unavailable.</p>
        </div>
        <div aria-hidden="true">
          <SkeletonLoader kind="post-card" count={skeletonCount} />
        </div>
      </div>
    );
  }

  const defaultMessage = kind === 'empty' ? 'No posts found.' : 'Something went wrong.';

  return (
    <div className={`state-view state-${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      <div className="state-copy">
        <span className="state-label">{kind === 'empty' ? 'NOTHING HERE YET' : 'FEED PAUSED'}</span>
        <p className="state-message">{message ?? defaultMessage}</p>
        {detail && <p className="state-detail">{detail}</p>}
      </div>
      {(onAction || alternateActionHref) && (
        <div className="state-actions">
          {onAction && actionLabel && (
            <button type="button" className="state-action state-action-primary" onClick={onAction}>
              {actionLabel}
            </button>
          )}
          {alternateActionHref && alternateActionLabel && (
            <a
              className="state-action state-action-secondary"
              href={alternateActionHref}
              target="_blank"
              rel="noreferrer"
            >
              {alternateActionLabel}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
