import type { ReactNode, RefObject } from 'react';

type MediaShellProps = {
  children: ReactNode;
  width?: number;
  height?: number;
  className?: string;
  status?: 'idle' | 'loading' | 'ready' | 'error';
  sourceUrl?: string;
  onRetry?: () => void;
  outerRef?: RefObject<HTMLDivElement | null>;
  inline?: boolean;
};

function getAspectRatio(width?: number, height?: number): number {
  if (!width || !height || width <= 0 || height <= 0) return 16 / 9;
  return Math.min(2, Math.max(9 / 16, width / height));
}

export function MediaShell({
  children,
  width,
  height,
  className = '',
  status = 'ready',
  sourceUrl,
  onRetry,
  outerRef,
  inline = false,
}: MediaShellProps) {
  if (inline) return <>{children}</>;

  return (
    <div
      ref={outerRef}
      className={`media-block media-shell ${className}`.trim()}
      style={{ aspectRatio: String(getAspectRatio(width, height)) }}
      data-media-status={status}
    >
      {children}
      {(status === 'idle' || status === 'loading') && (
        <div className="media-shell-status" role="status">Loading media...</div>
      )}
      {status === 'error' && (
        <div className="media-shell-status media-shell-error" role="alert">
          <span>Media could not be loaded.</span>
          {onRetry && <button type="button" onClick={onRetry}>Retry</button>}
          {sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer">Open source</a>}
        </div>
      )}
    </div>
  );
}
