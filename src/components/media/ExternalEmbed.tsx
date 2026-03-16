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

export function ExternalEmbed({
  embedUrl,
  thumbnailUrl,
  outboundUrl,
  provider,
  showOutboundLink = true,
}: ExternalEmbedProps) {
  const vertical = isLikelyVerticalEmbed(embedUrl, outboundUrl, provider);

  return (
    <div className="media-block external-media">
      {embedUrl ? (
        <iframe
          className={`external-frame${vertical ? ' external-frame-vertical' : ''}`}
          src={embedUrl}
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
