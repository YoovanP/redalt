import { useEffect, useRef, useState } from 'react';
import { usePlaybackSettings } from '../../lib/uiSettings';
import { canClientPlayVideo } from '../../lib/mediaCapabilities';
import { MediaShell } from './MediaShell';
import { useNearViewport } from './useNearViewport';

type VideoMediaProps = {
  sourceUrl: string;
  hlsUrl?: string;
  mimeType?: string;
  posterUrl?: string;
  isGif?: boolean;
  title: string;
  showSourceLink?: boolean;
  inline?: boolean;
  width?: number;
  height?: number;
  active?: boolean;
  nearby?: boolean;
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
  width,
  height,
  active,
  nearby,
}: VideoMediaProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { ref: shellRef, isNear } = useNearViewport(!inline);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [attempt, setAttempt] = useState(0);
  const { autoplayVideos, autoplayWithAudio } = usePlaybackSettings();

  const shouldMute = !autoplayWithAudio;
  const sourceLinkUrl = hlsUrl || sourceUrl;
  const shouldLoad = nearby ?? active ?? (inline || isNear);
  const shouldAutoplay = active ?? isNear;
  const playable = canClientPlayVideo({ sourceUrl, hlsUrl, mimeType });

  useEffect(() => {
    setStatus(shouldLoad ? 'loading' : 'idle');
  }, [attempt, shouldLoad, sourceUrl]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video || !hlsUrl || !shouldLoad) {
      return;
    }

    // Do not trust `canPlayType('application/vnd.apple.mpegurl')`: several
    // Chromium builds report "maybe" without actually playing HLS natively,
    // which silently leaves the video with no usable source. Attach hls.js
    // whenever it is supported; the native <source> children remain as the
    // Safari fallback when MediaSource is unavailable.
    let cancelled = false;
    let hls: import('hls.js').default | null = null;

    import('hls.js')
      .then(({ default: Hls }) => {
        if (cancelled || !Hls.isSupported()) return;
        hls = new Hls();
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) setStatus('error');
        });
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
      })
      .catch(() => setStatus('error'));

    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [attempt, hlsUrl, shouldLoad]);

  const player = (
    <video
      key={attempt}
      ref={videoRef}
      className="post-video"
      controls={!isGif}
      playsInline
      preload={shouldLoad ? 'metadata' : 'none'}
      autoPlay={shouldLoad && shouldAutoplay && (isGif || autoplayVideos)}
      loop={isGif}
      muted={isGif || shouldMute}
      poster={posterUrl}
      onCanPlay={() => setStatus('ready')}
      onError={() => setStatus('error')}
    >
      {shouldLoad && hlsUrl && <source src={hlsUrl} type="application/vnd.apple.mpegurl" />}
      {shouldLoad && hlsUrl && <source src={hlsUrl} type="application/x-mpegURL" />}
      {shouldLoad && sourceUrl !== hlsUrl && playable && <source src={sourceUrl} type={mimeType} />}
      Your browser does not support embedded videos.
    </video>
  );

  return (
    <MediaShell
      width={width}
      height={height}
      status={playable ? status : 'error'}
      sourceUrl={sourceLinkUrl}
      onRetry={() => setAttempt((value) => value + 1)}
      outerRef={shellRef}
      inline={inline}
    >
      {player}
      {showSourceLink && (
        <a href={sourceLinkUrl} target="_blank" rel="noreferrer">
          Open video source: {title}
        </a>
      )}
    </MediaShell>
  );
}
