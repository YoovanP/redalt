import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

test('clones network responses before scheduling asynchronous cache writes', () => {
  const assetHandler = source.slice(source.indexOf("return fetch(request).then((response) =>"));
  const apiHandler = source.slice(source.indexOf("if (url.pathname === '/api/reddit'"));

  assert.match(assetHandler, /const cacheResponse = response\.clone\(\);\s*event\.waitUntil\(storeAsset\(request, cacheResponse\)\.catch/);
  assert.match(apiHandler, /const cacheResponse = response\.clone\(\);\s*event\.waitUntil\(storeApiResponse\(request, cacheResponse\)\.catch/);
  assert.doesNotMatch(source, /cache\.put\(request, response\.clone\(\)\)/);
});

test('activates new workers without waiting for existing tabs to close', () => {
  assert.match(source, /self\.skipWaiting\(\)/);
  assert.match(source, /self\.addEventListener\('message'/);
});
