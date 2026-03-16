import { useUiSettings } from '../../lib/uiSettings';

type VideoMediaProps = {
  sourceUrl: string;
  hlsUrl?: string;
  title: string;
  showSourceLink?: boolean;
};

export function VideoMedia({ sourceUrl, hlsUrl, title, showSourceLink = true }: VideoMediaProps) {
  const {
    settings: { autoplayVideos, autoplayWithAudio },
  } = useUiSettings();

  const shouldMute = !autoplayWithAudio;

  return (
    <div className="media-block">
      <video
        className="post-video"
        controls
        playsInline
        preload="metadata"
        autoPlay={autoplayVideos}
        muted={shouldMute}
      >
        {hlsUrl && <source src={hlsUrl} type="application/x-mpegURL" />}
        <source src={sourceUrl} type="video/mp4" />
        Your browser does not support embedded videos.
      </video>
      {showSourceLink && (
        <a href={sourceUrl} target="_blank" rel="noreferrer">
          Open video source: {title}
        </a>
      )}
    </div>
  );
}
