type LoadMoreButtonProps = {
  children: string;
  disabled?: boolean;
  loading: boolean;
  loadingLabel?: string;
  onClick: () => void;
};

export function LoadMoreButton({
  children,
  disabled = false,
  loading,
  loadingLabel = 'Loading...',
  onClick,
}: LoadMoreButtonProps) {
  return (
    <button className="load-more" type="button" onClick={onClick} disabled={disabled || loading}>
      {loading ? loadingLabel : children}
    </button>
  );
}

type LoadMoreRecoveryProps = {
  message: string;
  loading?: boolean;
  onRetry: () => void;
  retryAt?: number | null;
};

function formatRetryCountdown(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function LoadMoreRecovery({ message, loading = false, onRetry, retryAt = null }: LoadMoreRecoveryProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!retryAt || retryAt <= Date.now()) {
      return;
    }

    setNow(Date.now());
    const intervalId = window.setInterval(() => {
      const nextNow = Date.now();
      setNow(nextNow);

      if (nextNow >= retryAt) {
        window.clearInterval(intervalId);
      }
    }, 1_000);
    return () => window.clearInterval(intervalId);
  }, [retryAt]);

  const retryCountdown = retryAt && retryAt > now ? formatRetryCountdown(retryAt - now) : null;

  return (
    <div className="load-more-recovery" role="status" aria-live="polite">
      <p>{message}</p>
      <button type="button" className="load-more-retry" disabled={loading || Boolean(retryCountdown)} onClick={onRetry}>
        {loading ? 'Retrying...' : retryCountdown ? `Retry in ${retryCountdown}` : 'Retry load more'}
      </button>
    </div>
  );
}
import { useEffect, useState } from 'react';
