type PagesFunctionContext = {
  request: Request;
  params: {
    path?: string | string[];
  };
};

const UPSTREAM_HOSTS = ['https://www.reddit.com', 'https://api.reddit.com', 'https://old.reddit.com'];

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
};

function withCors(headers: HeadersInit = {}): Headers {
  const merged = new Headers(headers);

  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    merged.set(key, value);
  }

  return merged;
}

function isJsonContentType(contentType: string | null): boolean {
  return (contentType ?? '').toLowerCase().includes('application/json');
}

async function isBlockedHtmlResponse(response: Response): Promise<boolean> {
  const contentType = response.headers.get('Content-Type');

  if (isJsonContentType(contentType)) {
    return false;
  }

  if (response.status !== 403 && response.status !== 429) {
    return false;
  }

  const body = await response.clone().text();
  const normalized = body.toLowerCase();

  return normalized.includes("you've been blocked by network security") || normalized.includes('blocked by network security');
}

async function fetchViaAllOrigins(upstreamPath: string): Promise<Response> {
  const redditUrl = `https://www.reddit.com${upstreamPath}`;
  const mirrorUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(redditUrl)}`;

  return fetch(mirrorUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'RedAlt/1.0 (Cloudflare Pages proxy)',
    },
  });
}

function buildUpstreamPath(paramsPath: string | string[] | undefined, url: URL): string {
  const path = Array.isArray(paramsPath) ? paramsPath.join('/') : paramsPath ?? '';
  const normalizedPath = path.replace(/^\/+/, '');
  const query = url.search || '';

  return `/${normalizedPath}${query}`;
}

export async function onRequest(context: PagesFunctionContext): Promise<Response> {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: withCors(),
    });
  }

  const incomingUrl = new URL(context.request.url);
  const upstreamPath = buildUpstreamPath(context.params.path, incomingUrl);
  const normalizedPath = upstreamPath.split('?')[0] || '/';

  const allowedPrefix =
    normalizedPath.startsWith('/r/') ||
    normalizedPath.startsWith('/user/') ||
    normalizedPath.startsWith('/search.json') ||
    normalizedPath.startsWith('/subreddits/') ||
    normalizedPath.startsWith('/users/') ||
    normalizedPath.startsWith('/api/search_reddit_names.json');

  if (!allowedPrefix) {
    return new Response('Invalid Reddit path', {
      status: 400,
      headers: withCors({
        'Cache-Control': 'no-store',
      }),
    });
  }

  let fallbackResponse: Response | null = null;

  for (const host of UPSTREAM_HOSTS) {
    const upstreamUrl = `${host}${upstreamPath}`;
    const upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'RedAlt/1.0 (Cloudflare Pages proxy)',
      },
    });

    const blockedHtml = await isBlockedHtmlResponse(upstreamResponse);

    if (upstreamResponse.ok && isJsonContentType(upstreamResponse.headers.get('Content-Type'))) {
      const headers = new Headers();
      headers.set('Content-Type', upstreamResponse.headers.get('Content-Type') ?? 'application/json');
      headers.set('Cache-Control', 'public, max-age=30, s-maxage=120');

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: withCors(headers),
      });
    }

    if (blockedHtml) {
      fallbackResponse = new Response(
        JSON.stringify({
          error: 'blocked',
          message: 'Reddit blocked this request from the current network.',
        }),
        {
          status: 403,
          headers: withCors({
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=15, s-maxage=30',
          }),
        },
      );
      continue;
    }

    if (!fallbackResponse) {
      const headers = new Headers();
      headers.set('Content-Type', upstreamResponse.headers.get('Content-Type') ?? 'application/json');
      headers.set('Cache-Control', 'public, max-age=15, s-maxage=30');

      fallbackResponse = new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers,
      });
    }
  }

  const mirrorResponse = await fetchViaAllOrigins(upstreamPath);

  if (mirrorResponse.ok && isJsonContentType(mirrorResponse.headers.get('Content-Type'))) {
    const headers = new Headers();
    headers.set('Content-Type', mirrorResponse.headers.get('Content-Type') ?? 'application/json');
    headers.set('Cache-Control', 'public, max-age=30, s-maxage=120');

    return new Response(mirrorResponse.body, {
      status: mirrorResponse.status,
      statusText: mirrorResponse.statusText,
        headers: withCors(headers),
    });
  }

  return (
    fallbackResponse ??
    new Response(JSON.stringify({ error: 'upstream_unavailable' }), {
      status: 502,
      headers: withCors({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      }),
    })
  );
}
