export type PlayableVideoCandidate = {
  sourceUrl?: string;
  hlsUrl?: string;
  mimeType?: string;
};

export function canClientPlayVideo(candidate: PlayableVideoCandidate): boolean {
  if (candidate.hlsUrl) return true;
  if (!candidate.sourceUrl) return false;
  return candidate.mimeType !== 'application/dash+xml' && !/\.mpd(?:$|[?#])/i.test(candidate.sourceUrl);
}
