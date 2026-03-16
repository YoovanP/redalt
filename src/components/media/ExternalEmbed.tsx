type ExternalEmbedProps = {
  embedUrl?: string;
  thumbnailUrl?: string;
  outboundUrl: string;
  provider?: string;
  showOutboundLink?: boolean;
};

export function ExternalEmbed({
  embedUrl,
  thumbnailUrl,
  outboundUrl,
  provider,
  showOutboundLink = true,
}: ExternalEmbedProps) {
  return (
    <div className="media-block external-media">
      {embedUrl ? (
        <iframe
          className="external-frame"
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
