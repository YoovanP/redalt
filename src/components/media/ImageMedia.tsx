type ImageMediaProps = {
  url: string;
  alt: string;
};

export function ImageMedia({ url, alt }: ImageMediaProps) {
  return (
    <div className="media-block media-aspect-wrap">
      <img className="post-image" src={url} alt={alt} loading="lazy" />
    </div>
  );
}
