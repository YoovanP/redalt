type BrowserStorageArea = 'local' | 'session';

function getBrowserStorage(area: BrowserStorageArea): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return area === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStorageItem(area: BrowserStorageArea, key: string): string | null {
  try {
    return getBrowserStorage(area)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStorageItem(area: BrowserStorageArea, key: string, value: string): boolean {
  try {
    const storage = getBrowserStorage(area);

    if (!storage) {
      return false;
    }

    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeStorageItem(area: BrowserStorageArea, key: string): boolean {
  try {
    const storage = getBrowserStorage(area);

    if (!storage) {
      return false;
    }

    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
