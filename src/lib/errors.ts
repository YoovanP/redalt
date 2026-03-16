export class RedditApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'RedditApiError';
    this.status = status;
  }
}

export function getApiErrorMessage(status: number): string {
  if (status === 404) {
    return 'Subreddit or post not found.';
  }

  if (status === 451 || status === 403) {
    return 'This subreddit or content is restricted in your region or behind access controls.';
  }

  if (status === 429) {
    return 'Rate-limited by Reddit. Please wait and try again.';
  }

  if (status >= 500) {
    return 'Reddit is currently unavailable.';
  }

  return 'Failed to load data from Reddit.';
}
