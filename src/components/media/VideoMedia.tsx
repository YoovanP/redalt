import { useEffect, useRef } from 'react';
import { useUiSettings } from '../../lib/uiSettings';

type VideoMediaProps = {
  sourceUrl: string;
  hlsUrl?: string;
  mimeType?: string;
  posterUrl?: string;
  isGif?: boolean;
  title: string;
  showSourceLink?: boolean;
  inline?: boolean;
};

export function VideoMedia({
  sourceUrl,
  hlsUrl,
  mimeType,
  posterUrl,
  isGif = false,
  title,
  showSourceLink = true,
  inline = false,
}: VideoMediaProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const {
    settings: { autoplayVideos, autoplayWithAudio },
  } = useUiSettings();

  const shouldMute = !autoplayWithAudio;
  const sourceLinkUrl = hlsUrl || sourceUrl;

  useEffect(() => {
    const video = videoRef.current;

    if (!video || !hlsUrl) {
      return;
    }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      return;
    }

    let cancelled = false;
    let hls: import('hls.js').default | null = null;

    import('hls.js').then(({ default: Hls }) => {
      if (cancelled || !Hls.isSupported()) {
        return;
      }

      hls = new Hls();
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
    });

    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [hlsUrl]);

  const player = (
    <video
      ref={videoRef}
      className="post-video"
      controls={!isGif}
      playsInline
      preload="metadata"
      autoPlay={isGif || autoplayVideos}
      loop={isGif}
      muted={isGif || shouldMute}
      poster={posterUrl}
    >
      {hlsUrl && <source src={hlsUrl} type="application/vnd.apple.mpegurl" />}
      {hlsUrl && <source src={hlsUrl} type="application/x-mpegURL" />}
      {sourceUrl !== hlsUrl && <source src={sourceUrl} type={mimeType} />}
      Your browser does not support embedded videos.
    </video>
  );

  if (inline) {
    return player;
  }

  return (
    <div className="media-block media-aspect-wrap">
      {player}
      {showSourceLink && (
        <a href={sourceLinkUrl} target="_blank" rel="noreferrer">
          Open video source: {title}
        </a>
      )}
    </div>
  );
}
