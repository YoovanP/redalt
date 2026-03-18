import { useEffect, useMemo, useRef, useState } from 'react';

type ExternalEmbedProps = {
  embedUrl?: string;
  thumbnailUrl?: string;
  outboundUrl: string;
  provider?: string;
  showOutboundLink?: boolean;
};

function isLikelyVerticalEmbed(embedUrl?: string, outboundUrl?: string, provider?: string): boolean {
  const value = `${embedUrl ?? ''} ${outboundUrl ?? ''} ${provider ?? ''}`.toLowerCase();

  return (
    value.includes('tiktok') ||
    value.includes('instagram') ||
    value.includes('instagr.am') ||
    value.includes('/reel/') ||
    value.includes('/shorts/') ||
    value.includes('redgifs')
  );
}

function getEmbedProviderType(
  embedUrl?: string,
  outboundUrl?: string,
  provider?: string,
): 'youtube' | 'vimeo' | 'redgifs' | 'other' {
  const value = `${embedUrl ?? ''} ${outboundUrl ?? ''} ${provider ?? ''}`.toLowerCase();

  if (value.includes('youtube') || value.includes('youtu.be')) {
    return 'youtube';
  }

  if (value.includes('vimeo')) {
    return 'vimeo';
  }

  if (value.includes('redgifs')) {
    return 'redgifs';
  }

  return 'other';
}

function withYouTubeApi(url: string): string {
  try {
    const parsed = new URL(url);

    if (
      (parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtu.be')) &&
      !parsed.searchParams.has('enablejsapi')
    ) {
      parsed.searchParams.set('enablejsapi', '1');
    }

    return parsed.toString();
  } catch {
    return url;
  }
}

function pauseEmbed(iframe: HTMLIFrameElement, providerType: 'youtube' | 'vimeo' | 'redgifs' | 'other') {
  if (providerType === 'youtube') {
    iframe.contentWindow?.postMessage(
      JSON.stringify({
        event: 'command',
        func: 'pauseVideo',
        args: [],
      }),
      '*',
    );
    return;
  }

  if (providerType === 'vimeo') {
    iframe.contentWindow?.postMessage(
      JSON.stringify({
        method: 'pause',
      }),
      '*',
    );
  }
}

export function ExternalEmbed({
  embedUrl,
  thumbnailUrl,
  outboundUrl,
  provider,
  showOutboundLink = true,
}: ExternalEmbedProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [showEmbed, setShowEmbed] = useState(true);
  const providerType = useMemo(
    () => getEmbedProviderType(embedUrl, outboundUrl, provider),
    [embedUrl, outboundUrl, provider],
  );
  const resolvedEmbedUrl = useMemo(() => {
    if (!embedUrl) {
      return undefined;
    }

    return providerType === 'youtube' ? withYouTubeApi(embedUrl) : embedUrl;
  }, [embedUrl, providerType]);
  const vertical = isLikelyVerticalEmbed(embedUrl, outboundUrl, provider);

  useEffect(() => {
    setShowEmbed(true);
  }, [resolvedEmbedUrl]);

  useEffect(() => {
    const target = containerRef.current;

    if (!target || !resolvedEmbedUrl) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            if (providerType === 'redgifs') {
              setShowEmbed(false);
            } else if (iframeRef.current) {
              pauseEmbed(iframeRef.current, providerType);
            }
          } else if (providerType === 'redgifs') {
            setShowEmbed(true);
          }
        }
      },
      {
        threshold: 0.2,
      },
    );

    observer.observe(target);

    return () => {
      observer.disconnect();
    };
  }, [providerType, resolvedEmbedUrl]);

  return (
    <div className="media-block external-media" ref={containerRef}>
      {resolvedEmbedUrl && showEmbed ? (
        <iframe
          ref={iframeRef}
          className={`external-frame${vertical ? ' external-frame-vertical' : ''}`}
          src={resolvedEmbedUrl}
          title={provider ?? 'External embed'}
          loading="lazy"
          allow="autoplay; fullscreen; picture-in-picture"
          allowFullScreen
        />
      ) : thumbnailUrl ? (
        <a href={outboundUrl} target="_blank" rel="noreferrer">
          <img className="post-image" src={thumbnailUrl} alt={provider ?? 'External media preview'} loading="lazy" />
        </a>
      ) : null}

      {showOutboundLink && (
        <a href={outboundUrl} target="_blank" rel="noreferrer">
          Open on {provider ?? 'external site'}
        </a>
      )}
    </div>
  );
}
