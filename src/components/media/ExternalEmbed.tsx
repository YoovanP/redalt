import { useEffect, useMemo, useRef, useState } from 'react';

type ExternalEmbedProps = {
  embedUrl?: string;
  embedHtml?: string;
  thumbnailUrl?: string;
  outboundUrl: string;
  provider?: string;
  embedWidth?: number;
  embedHeight?: number;
  showOutboundLink?: boolean;
};

type ProviderType = 'youtube' | 'vimeo' | 'redgifs' | 'other';

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&#(?:x20|32);/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

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
): ProviderType {
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

function pauseEmbed(iframe: HTMLIFrameElement, providerType: ProviderType) {
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

function buildEmbedDocument(html: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <base target="_blank" />
    <style>
      :root {
        color-scheme: dark;
      }

      html,
      body {
        margin: 0;
        padding: 0;
        background: transparent;
        overflow-x: hidden;
      }

      body {
        display: grid;
        place-items: stretch;
      }

      body > * {
        margin-inline: auto !important;
      }

      iframe,
      blockquote,
      twitter-widget,
      .twitter-tweet,
      .instagram-media,
      .tiktok-embed,
      .reddit-embed-bq,
      .speakerdeck-iframe,
      video {
        max-width: 100% !important;
        width: 100% !important;
      }
    </style>
  </head>
  <body>
    ${html}
    <script>
      (function () {
        const postHeight = function () {
          const root = document.documentElement;
          const body = document.body;
          const height = Math.max(
            root.scrollHeight,
            body.scrollHeight,
            root.offsetHeight,
            body.offsetHeight,
            root.clientHeight,
            body.clientHeight,
          );

          parent.postMessage({ type: 'redalt-embed-height', height }, '*');
        };

        if ('ResizeObserver' in window) {
          const observer = new ResizeObserver(postHeight);
          observer.observe(document.documentElement);
          observer.observe(document.body);
        }

        window.addEventListener('load', postHeight);
        document.addEventListener('DOMContentLoaded', postHeight);
        setTimeout(postHeight, 150);
        setTimeout(postHeight, 800);
        setTimeout(postHeight, 2000);
      })();
    </script>
  </body>
</html>`;
}

export function ExternalEmbed({
  embedUrl,
  embedHtml,
  thumbnailUrl,
  outboundUrl,
  provider,
  embedWidth,
  embedHeight,
  showOutboundLink = true,
}: ExternalEmbedProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [showEmbed, setShowEmbed] = useState(true);
  const [htmlEmbedHeight, setHtmlEmbedHeight] = useState<number | null>(null);
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
  const resolvedEmbedHtml = useMemo(() => {
    const normalized = decodeBasicEntities(embedHtml ?? '').trim();
    return normalized || undefined;
  }, [embedHtml]);
  const embedDocument = useMemo(
    () => (resolvedEmbedHtml && !resolvedEmbedUrl ? buildEmbedDocument(resolvedEmbedHtml) : undefined),
    [resolvedEmbedHtml, resolvedEmbedUrl],
  );
  const vertical = isLikelyVerticalEmbed(resolvedEmbedUrl, outboundUrl, provider);

  useEffect(() => {
    setShowEmbed(true);
    setHtmlEmbedHeight(null);
  }, [resolvedEmbedUrl, resolvedEmbedHtml]);

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

  useEffect(() => {
    if (!embedDocument) {
      return;
    }

    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || !event.data || typeof event.data !== 'object') {
        return;
      }

      const payload = event.data as { type?: unknown; height?: unknown };

      if (payload.type !== 'redalt-embed-height') {
        return;
      }

      const nextHeight = Number(payload.height);

      if (!Number.isFinite(nextHeight) || nextHeight <= 0) {
        return;
      }

      setHtmlEmbedHeight(Math.min(Math.max(Math.round(nextHeight), vertical ? 460 : 360), 1600));
    };

    window.addEventListener('message', onMessage);

    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, [embedDocument, vertical]);

  const frameStyle = embedDocument
    ? {
        aspectRatio: 'auto',
        height: `${htmlEmbedHeight ?? embedHeight ?? (vertical ? 560 : 420)}px`,
      }
    : embedWidth && embedHeight
      ? {
          aspectRatio: `${embedWidth} / ${embedHeight}`,
        }
      : undefined;

  return (
    <div className="media-block external-media" ref={containerRef}>
      {showEmbed && resolvedEmbedUrl ? (
        <iframe
          ref={iframeRef}
          className={`external-frame${vertical ? ' external-frame-vertical' : ''}`}
          src={resolvedEmbedUrl}
          title={provider ?? 'External embed'}
          loading="lazy"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture; web-share"
          allowFullScreen
          style={frameStyle}
        />
      ) : showEmbed && embedDocument ? (
        <iframe
          ref={iframeRef}
          className={`external-frame${vertical ? ' external-frame-vertical' : ''}`}
          srcDoc={embedDocument}
          title={provider ?? 'External embed'}
          loading="lazy"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture; web-share"
          allowFullScreen
          sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts"
          style={frameStyle}
        />
      ) : thumbnailUrl ? (
        <a href={outboundUrl} target="_blank" rel="noreferrer">
          <img
            className="post-image"
            src={thumbnailUrl}
            alt={provider ?? 'External media preview'}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
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
