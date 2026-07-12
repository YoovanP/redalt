import { readStorageItem, writeStorageItem } from './browserStorage';

const STORAGE_KEY = 'redalt.customFeed';
export const CUSTOM_FEED_UPDATE_EVENT = 'redalt-custom-feed-update';

export function sanitizeSubreddit(input: string): string {
  return input
    .trim()
    .replace(/^\/?r\//i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

export function readCustomFeedSubreddits(): string[] {
  try {
    const raw = readStorageItem('local', STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];

    if (!Array.isArray(parsed)) {
      return [];
    }

    return Array.from(
      new Set(
        parsed
          .map((entry) => (typeof entry === 'string' ? sanitizeSubreddit(entry) : ''))
          .filter(Boolean),
      ),
    );
  } catch {
    return [];
  }
}

export function writeCustomFeedSubreddits(subreddits: string[]): void {
  const sanitized = Array.from(new Set(subreddits.map(sanitizeSubreddit).filter(Boolean)));
  writeStorageItem('local', STORAGE_KEY, JSON.stringify(sanitized));
}

export function notifyCustomFeedUpdate(): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new CustomEvent(CUSTOM_FEED_UPDATE_EVENT));
}

export function addCustomFeedSubreddit(input: string): boolean {
  const subreddit = sanitizeSubreddit(input);

  if (!subreddit) {
    return false;
  }

  const current = readCustomFeedSubreddits();

  if (current.includes(subreddit)) {
    return false;
  }

  writeCustomFeedSubreddits([...current, subreddit]);
  notifyCustomFeedUpdate();
  return true;
}
