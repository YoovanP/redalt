type LoadMoreButtonProps = {
  children: string;
  disabled?: boolean;
  loading: boolean;
  loadingLabel?: string;
  onClick: () => void;
};

export function LoadMoreButton({
  children,
  disabled = false,
  loading,
  loadingLabel = 'Loading...',
  onClick,
}: LoadMoreButtonProps) {
  return (
    <button className="load-more" type="button" onClick={onClick} disabled={disabled || loading}>
      {loading ? loadingLabel : children}
    </button>
  );
}
