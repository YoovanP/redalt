type StateViewProps = {
  kind: 'loading' | 'empty' | 'error';
  message?: string;
};

export function StateView({ kind, message }: StateViewProps) {
  const defaultMessage =
    kind === 'loading'
      ? 'Loading from Reddit…'
      : kind === 'empty'
        ? 'No posts found.'
        : 'Something went wrong.';

  return (
    <div className={`state-view state-${kind}`}>
      <p>{message ?? defaultMessage}</p>
    </div>
  );
}
