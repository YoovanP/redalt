import { useState } from 'react';
import type { ResponsiveImageSource } from '../../types/reddit';
import { MediaShell } from './MediaShell';

type ImageMediaProps = {
  url: string;
  alt: string;
  width?: number;
  height?: number;
  sources?: ResponsiveImageSource[];
};

export function ImageMedia({ url, alt, width, height, sources = [] }: ImageMediaProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const srcSet = sources.map((source) => `${source.url} ${source.width}w`).join(', ') || undefined;

  return (
    <MediaShell
      width={width}
      height={height}
      status={status}
      sourceUrl={url}
      onRetry={() => {
        setStatus('loading');
        setAttempt((value) => value + 1);
      }}
    >
      <img
        key={attempt}
        className="post-image"
        src={url}
        srcSet={srcSet}
        sizes="(max-width: 900px) 100vw, (max-width: 1400px) 50vw, 33vw"
        alt={alt}
        width={width}
        height={height}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => setStatus('ready')}
        onError={() => setStatus('error')}
      />
    </MediaShell>
  );
}
