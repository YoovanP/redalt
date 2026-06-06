type ImageMediaProps = {
  url: string;
  alt: string;
  width?: number;
  height?: number;
};

export function ImageMedia({ url, alt, width, height }: ImageMediaProps) {
  const hasDimensions = typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0;

  return (
    <div className="media-block" style={hasDimensions ? { aspectRatio: `${width} / ${height}`, maxHeight: '80vh' } : { aspectRatio: '16 / 9', maxHeight: '520px' }}>
      <img className="post-image" src={url} alt={alt} loading="lazy" referrerPolicy="no-referrer" />
    </div>
  );
}
