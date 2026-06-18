import { useEffect, useRef } from 'react';
import { useUiSettings } from '../../lib/uiSettings';

type VideoMediaProps = {
  sourceUrl: string;
  hlsUrl?: string;
  title: string;
  showSourceLink?: boolean;
};

export function VideoMedia({ sourceUrl, hlsUrl, title, showSourceLink = true }: VideoMediaProps) {
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

  return (
    <div className="media-block media-aspect-wrap">
      <video
        ref={videoRef}
        className="post-video"
        controls
        playsInline
        preload="metadata"
        autoPlay={autoplayVideos}
        muted={shouldMute}
      >
        {hlsUrl && <source src={hlsUrl} type="application/vnd.apple.mpegurl" />}
        {hlsUrl && <source src={hlsUrl} type="application/x-mpegURL" />}
        {sourceUrl !== hlsUrl && <source src={sourceUrl} type="video/mp4" />}
        Your browser does not support embedded videos.
      </video>
      {showSourceLink && (
        <a href={sourceLinkUrl} target="_blank" rel="noreferrer">
          Open video source: {title}
        </a>
      )}
    </div>
  );
}
