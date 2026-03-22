const UPSTREAM_HOSTS = ['https://www.reddit.com', 'https://api.reddit.com', 'https://old.reddit.com'];

function isJsonContentType(contentType: string | null): boolean {
  return (contentType ?? '').toLowerCase().includes('application/json');
}

async function isBlockedHtmlResponse(response: Response): Promise<boolean> {
  const contentType = response.headers.get('content-type');

  if (isJsonContentType(contentType)) {
    return false;
  }

  if (response.status !== 403 && response.status !== 429) {
    return false;
  }

  const body = await response.clone().text();
  const normalized = body.toLowerCase();

  return (
    normalized.includes("you've been blocked by network security") ||
    normalized.includes('blocked by network security')
  );
}

function buildUpstreamPath(pathParam: string | string[] | undefined, incomingUrl: URL): string {
  const path = Array.isArray(pathParam) ? pathParam.join('/') : pathParam ?? '';
  const normalizedPath = path.replace(/^\/+/, '');
  const params = new URLSearchParams(incomingUrl.search);
  params.delete('path');
  const query = params.toString();

  return `/${normalizedPath}${query ? `?${query}` : ''}`;
}

async function fetchViaAllOrigins(upstreamPath: string): Promise<Response> {
  const redditUrl = `https://www.reddit.com${upstreamPath}`;
  const mirrorUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(redditUrl)}`;

  return fetch(mirrorUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'RedAlt/1.0 (Vercel proxy)',
    },
  });
}

export default async function handler(req: any, res: any): Promise<void> {
  const incomingUrl = new URL(req.url ?? '/', 'http://localhost');
  const upstreamPath = buildUpstreamPath(req.query?.path, incomingUrl);
  const normalizedPath = upstreamPath.split('?')[0] || '/';

  const allowedPrefix =
    normalizedPath.startsWith('/r/') ||
    normalizedPath.startsWith('/user/') ||
    normalizedPath.startsWith('/search.json') ||
    normalizedPath.startsWith('/subreddits/') ||
    normalizedPath.startsWith('/users/') ||
    normalizedPath.startsWith('/api/search_reddit_names.json');

  if (!allowedPrefix) {
    res.status(400).setHeader('Content-Type', 'text/plain; charset=utf-8').send('Invalid Reddit path');
    return;
  }

  let fallback: {
    status: number;
    contentType: string;
    cacheControl: string;
    body: string;
  } | null = null;

  for (const host of UPSTREAM_HOSTS) {
    const upstreamUrl = `${host}${upstreamPath}`;
    const upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'RedAlt/1.0 (Vercel proxy)',
      },
    });

    const blockedHtml = await isBlockedHtmlResponse(upstreamResponse);

    if (upstreamResponse.ok && isJsonContentType(upstreamResponse.headers.get('content-type'))) {
      const body = await upstreamResponse.text();

      res
        .status(upstreamResponse.status)
        .setHeader('Content-Type', upstreamResponse.headers.get('content-type') ?? 'application/json')
        .setHeader('Cache-Control', 'public, max-age=30, s-maxage=120')
        .send(body);
      return;
    }

    if (blockedHtml) {
      fallback = {
        status: 403,
        contentType: 'application/json; charset=utf-8',
        cacheControl: 'public, max-age=15, s-maxage=30',
        body: JSON.stringify({
          error: 'blocked',
          message: 'Reddit blocked this request from the current network.',
        }),
      };
      continue;
    }

    if (!fallback) {
      fallback = {
        status: upstreamResponse.status,
        contentType: upstreamResponse.headers.get('content-type') ?? 'application/json',
        cacheControl: 'public, max-age=15, s-maxage=30',
        body: await upstreamResponse.text(),
      };
    }
  }

  const mirrorResponse = await fetchViaAllOrigins(upstreamPath);

  if (mirrorResponse.ok && isJsonContentType(mirrorResponse.headers.get('content-type'))) {
    const body = await mirrorResponse.text();

    res
      .status(mirrorResponse.status)
      .setHeader('Content-Type', mirrorResponse.headers.get('content-type') ?? 'application/json')
      .setHeader('Cache-Control', 'public, max-age=30, s-maxage=120')
      .send(body);
    return;
  }

  if (fallback) {
    res
      .status(fallback.status)
      .setHeader('Content-Type', fallback.contentType)
      .setHeader('Cache-Control', fallback.cacheControl)
      .send(fallback.body);
    return;
  }

  res
    .status(502)
    .setHeader('Content-Type', 'application/json; charset=utf-8')
    .setHeader('Cache-Control', 'no-store')
    .send(JSON.stringify({ error: 'upstream_unavailable' }));
}
