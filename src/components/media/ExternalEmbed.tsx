import { useEffect, useMemo, useRef, useState } from 'react';

const REDGIFS_MODE_KEY = 'redalt.redgifsMode';

type RedgifsResolvedPayload = {
  id: string;
  hlsUrl?: string;
  sdUrl?: string;
  hdUrl?: string;
  posterUrl?: string;
};

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

function extractRedgifsId(embedUrl?: string, outboundUrl?: string): string | null {
  const joined = `${embedUrl ?? ''} ${outboundUrl ?? ''}`;
  const patterns = [
    /redgifs\.com\/(?:watch|ifr|gifs\/detail)\/([a-z0-9]+)/i,
    /redgifs\.com\/([a-z0-9]+)(?:\b|\?)/i,
  ];

  for (const pattern of patterns) {
    const match = joined.match(pattern);

    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
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
  const [resolvedRedgifs, setResolvedRedgifs] = useState<RedgifsResolvedPayload | null>(null);
  const [redgifsMode, setRedgifsMode] = useState<'proxy' | 'embed'>(() => {
    const stored = localStorage.getItem(REDGIFS_MODE_KEY);
    return stored === 'embed' ? 'embed' : 'proxy';
  });
  const providerType = useMemo(
    () => getEmbedProviderType(embedUrl, outboundUrl, provider),
    [embedUrl, outboundUrl, provider],
  );
  const redgifsId = useMemo(
    () => (providerType === 'redgifs' ? extractRedgifsId(embedUrl, outboundUrl) : null),
    [providerType, embedUrl, outboundUrl],
  );
  const resolvedEmbedUrl = useMemo(() => {
    if (!embedUrl) {
      return undefined;
    }

    return providerType === 'youtube' ? withYouTubeApi(embedUrl) : embedUrl;
  }, [embedUrl, providerType]);
  const vertical = isLikelyVerticalEmbed(embedUrl, outboundUrl, provider);
  const canUseProxy = providerType === 'redgifs' && Boolean(resolvedRedgifs);
  const canUseEmbed = providerType === 'redgifs' && Boolean(resolvedEmbedUrl);
  const shouldUseProxy = providerType === 'redgifs' && redgifsMode === 'proxy' && canUseProxy;
  const redgifsVideo = shouldUseProxy ? resolvedRedgifs : null;

  useEffect(() => {
    localStorage.setItem(REDGIFS_MODE_KEY, redgifsMode);
  }, [redgifsMode]);

  useEffect(() => {
    setShowEmbed(true);
  }, [resolvedEmbedUrl]);

  useEffect(() => {
    if (providerType !== 'redgifs' || !redgifsId) {
      setResolvedRedgifs(null);
      return;
    }

    let cancelled = false;

    fetch(`/api/redgifs/resolve/${encodeURIComponent(redgifsId)}`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Unable to resolve RedGIFs media');
        }

        const payload = (await response.json()) as RedgifsResolvedPayload;

        if (!cancelled) {
          setResolvedRedgifs(payload);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedRedgifs(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [providerType, redgifsId]);

  useEffect(() => {
    if (providerType !== 'redgifs') {
      return;
    }

    if (redgifsMode === 'proxy' && !canUseProxy && canUseEmbed) {
      setRedgifsMode('embed');
      return;
    }

    if (redgifsMode === 'embed' && !canUseEmbed && canUseProxy) {
      setRedgifsMode('proxy');
    }
  }, [providerType, redgifsMode, canUseProxy, canUseEmbed]);

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
      {providerType === 'redgifs' && (canUseProxy || canUseEmbed) && (
        <div className="redgifs-mode-toggle" role="group" aria-label="RedGIFs playback mode">
          <button
            type="button"
            className={`redgifs-mode-button${redgifsMode === 'proxy' ? ' is-active' : ''}`}
            onClick={() => setRedgifsMode('proxy')}
            disabled={!canUseProxy}
          >
            Proxy video
          </button>
          <button
            type="button"
            className={`redgifs-mode-button${redgifsMode === 'embed' ? ' is-active' : ''}`}
            onClick={() => setRedgifsMode('embed')}
            disabled={!canUseEmbed}
          >
            Embed iframe
          </button>
        </div>
      )}

      {redgifsVideo && showEmbed ? (
        <video
          className={`post-video${vertical ? ' external-frame-vertical' : ''}`}
          controls
          playsInline
          preload="metadata"
          poster={redgifsVideo.posterUrl}
        >
          {redgifsVideo.hlsUrl && <source src={redgifsVideo.hlsUrl} type="application/x-mpegURL" />}
          {redgifsVideo.hdUrl && <source src={redgifsVideo.hdUrl} type="video/mp4" />}
          {redgifsVideo.sdUrl && <source src={redgifsVideo.sdUrl} type="video/mp4" />}
          Your browser does not support embedded videos.
        </video>
      ) : resolvedEmbedUrl && showEmbed ? (
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
