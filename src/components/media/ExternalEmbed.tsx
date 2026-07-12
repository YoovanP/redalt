import { useEffect, useMemo, useRef, useState } from 'react';
import { isTrustedEmbedUrl } from '../../lib/normalizePost';

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

function urlHostMatches(value: string | undefined, expectedHost: string): boolean {
  if (!value) {
    return false;
  }

  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.+$/g, '');
    const normalizedExpectedHost = expectedHost.toLowerCase().replace(/^\.+|\.+$/g, '');
    return hostname === normalizedExpectedHost || hostname.endsWith(`.${normalizedExpectedHost}`);
  } catch {
    return false;
  }
}

function hasProviderHost(
  embedUrl: string | undefined,
  outboundUrl: string | undefined,
  expectedHosts: string[],
): boolean {
  return [embedUrl, outboundUrl].some((value) =>
    expectedHosts.some((expectedHost) => urlHostMatches(value, expectedHost)),
  );
}

function providerMatches(provider: string | undefined, expectedProvider: string): boolean {
  return provider?.trim().toLowerCase() === expectedProvider.toLowerCase();
}

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
  return (
    hasProviderHost(embedUrl, outboundUrl, ['tiktok.com']) ||
    hasProviderHost(embedUrl, outboundUrl, ['instagram.com', 'instagr.am']) ||
    hasProviderHost(embedUrl, outboundUrl, ['redgifs.com']) ||
    providerMatches(provider, 'TikTok') ||
    providerMatches(provider, 'Instagram') ||
    providerMatches(provider, 'Redgifs') ||
    [embedUrl, outboundUrl].some(
      (value) =>
        (urlHostMatches(value, 'youtube.com') || urlHostMatches(value, 'youtube-nocookie.com')) &&
        /\/shorts\//i.test(value ?? ''),
    )
  );
}

function getEmbedProviderType(
  embedUrl?: string,
  outboundUrl?: string,
  provider?: string,
): ProviderType {
  if (
    hasProviderHost(embedUrl, outboundUrl, ['youtube.com', 'youtube-nocookie.com', 'youtu.be']) ||
    providerMatches(provider, 'YouTube')
  ) {
    return 'youtube';
  }

  if (hasProviderHost(embedUrl, outboundUrl, ['vimeo.com']) || providerMatches(provider, 'Vimeo')) {
    return 'vimeo';
  }

  if (hasProviderHost(embedUrl, outboundUrl, ['redgifs.com']) || providerMatches(provider, 'Redgifs')) {
    return 'redgifs';
  }

  return 'other';
}

function withYouTubeApi(url: string): string {
  try {
    const parsed = new URL(url);

    if (
      (urlHostMatches(url, 'youtube.com') ||
        urlHostMatches(url, 'youtube-nocookie.com') ||
        urlHostMatches(url, 'youtu.be')) &&
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
  const [htmlEmbedHeight, setHtmlEmbedHeight] = useState<number | null>(null);
  const providerType = useMemo(
    () => getEmbedProviderType(embedUrl, outboundUrl, provider),
    [embedUrl, outboundUrl, provider],
  );
  const resolvedEmbedUrl = useMemo(() => {
    if (!embedUrl) {
      return undefined;
    }

    const candidate = providerType === 'youtube' ? withYouTubeApi(embedUrl) : embedUrl;
    return isTrustedEmbedUrl(candidate) ? candidate : undefined;
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
          if (!entry.isIntersecting && iframeRef.current && providerType !== 'redgifs') {
            pauseEmbed(iframeRef.current, providerType);
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
      {resolvedEmbedUrl ? (
        <iframe
          ref={iframeRef}
          className={`external-frame${vertical ? ' external-frame-vertical' : ''}`}
          src={resolvedEmbedUrl}
          title={provider ?? 'External embed'}
          loading="lazy"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture; web-share"
          sandbox="allow-forms allow-popups allow-presentation allow-same-origin allow-scripts"
          referrerPolicy="strict-origin-when-cross-origin"
          style={frameStyle}
        />
      ) : embedDocument ? (
        <iframe
          ref={iframeRef}
          className={`external-frame${vertical ? ' external-frame-vertical' : ''}`}
          srcDoc={embedDocument}
          title={provider ?? 'External embed'}
          loading="lazy"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture; web-share"
          sandbox="allow-forms allow-popups allow-presentation allow-scripts"
          referrerPolicy="no-referrer"
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
