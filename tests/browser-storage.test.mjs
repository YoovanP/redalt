import assert from 'node:assert/strict';
import test from 'node:test';
import { readStorageItem, removeStorageItem, writeStorageItem } from '../src/lib/browserStorage.ts';

test('storage helpers degrade safely outside a browser', () => {
  const previousWindow = globalThis.window;

  try {
    delete globalThis.window;
    assert.equal(readStorageItem('local', 'key'), null);
    assert.equal(writeStorageItem('local', 'key', 'value'), false);
    assert.equal(removeStorageItem('session', 'key'), false);
  } finally {
    if (previousWindow !== undefined) {
      globalThis.window = previousWindow;
    }
  }
});

test('storage helpers contain blocked getter and quota errors', () => {
  const previousWindow = globalThis.window;
  const blockedWindow = {};

  Object.defineProperty(blockedWindow, 'localStorage', {
    get() {
      throw new DOMException('Blocked', 'SecurityError');
    },
  });

  Object.defineProperty(blockedWindow, 'sessionStorage', {
    value: {
      getItem() {
        return 'remembered';
      },
      setItem() {
        throw new DOMException('Full', 'QuotaExceededError');
      },
      removeItem() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    },
  });

  try {
    globalThis.window = blockedWindow;
    assert.equal(readStorageItem('local', 'key'), null);
    assert.equal(readStorageItem('session', 'key'), 'remembered');
    assert.equal(writeStorageItem('session', 'key', 'value'), false);
    assert.equal(removeStorageItem('session', 'key'), false);
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});
