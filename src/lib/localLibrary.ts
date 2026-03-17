import type { NormalizedPost } from '../types/reddit';

export type LibraryItem = {
  id: string;
  name: string;
  title: string;
  subreddit: string;
  author: string;
  permalink: string;
  outboundUrl: string;
  createdUtc: number;
  score: number;
  numComments: number;
  isNsfw: boolean;
  mediaType: string;
  savedAt?: number;
  viewedAt?: number;
};

const SAVED_KEY = 'redalt.savedPosts';
const HISTORY_KEY = 'redalt.watchHistory';
const HISTORY_LIMIT = 250;

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function mapPostToItem(post: NormalizedPost): LibraryItem {
  return {
    id: post.id,
    name: post.name,
    title: post.title,
    subreddit: post.subreddit,
    author: post.author,
    permalink: post.permalink,
    outboundUrl: post.outboundUrl,
    createdUtc: post.createdUtc,
    score: post.score,
    numComments: post.numComments,
    isNsfw: post.isNsfw,
    mediaType: post.media.type,
  };
}

function parseItems(raw: string | null): LibraryItem[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((item): item is LibraryItem => {
      return (
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as LibraryItem).id === 'string' &&
        typeof (item as LibraryItem).title === 'string' &&
        typeof (item as LibraryItem).subreddit === 'string' &&
        typeof (item as LibraryItem).author === 'string' &&
        typeof (item as LibraryItem).permalink === 'string'
      );
    });
  } catch {
    return [];
  }
}

function readItems(key: string): LibraryItem[] {
  if (!isBrowser()) {
    return [];
  }

  return parseItems(window.localStorage.getItem(key));
}

function writeItems(key: string, items: LibraryItem[]): void {
  if (!isBrowser()) {
    return;
  }

  window.localStorage.setItem(key, JSON.stringify(items));
}

export function getSavedPosts(): LibraryItem[] {
  return readItems(SAVED_KEY).sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
}

export function isPostSaved(postId: string): boolean {
  return getSavedPosts().some((item) => item.id === postId);
}

export function toggleSavedPost(post: NormalizedPost): boolean {
  const current = readItems(SAVED_KEY);
  const index = current.findIndex((item) => item.id === post.id);

  if (index >= 0) {
    current.splice(index, 1);
    writeItems(SAVED_KEY, current);
    return false;
  }

  const item = mapPostToItem(post);
  item.savedAt = Date.now();
  current.unshift(item);
  writeItems(SAVED_KEY, current);
  return true;
}

export function clearSavedPosts(): void {
  writeItems(SAVED_KEY, []);
}

export function removeSavedPost(postId: string): void {
  const current = readItems(SAVED_KEY).filter((item) => item.id !== postId);
  writeItems(SAVED_KEY, current);
}

export function getWatchHistory(): LibraryItem[] {
  return readItems(HISTORY_KEY).sort((a, b) => (b.viewedAt ?? 0) - (a.viewedAt ?? 0));
}

export function addWatchHistory(post: NormalizedPost): void {
  const current = readItems(HISTORY_KEY).filter((item) => item.id !== post.id);
  const item = mapPostToItem(post);
  item.viewedAt = Date.now();
  current.unshift(item);
  writeItems(HISTORY_KEY, current.slice(0, HISTORY_LIMIT));
}

export function clearWatchHistory(): void {
  writeItems(HISTORY_KEY, []);
}
