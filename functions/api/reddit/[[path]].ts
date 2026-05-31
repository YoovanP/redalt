type PagesFunctionContext = {
  request: Request;
  params: {
    path?: string | string[];
  };
  env?: Record<string, string | undefined>;
};

const UPSTREAM_HOSTS = ['https://www.reddit.com', 'https://api.reddit.com', 'https://old.reddit.com'];
const OAUTH_HOST = 'https://oauth.reddit.com';
const OAUTH_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';

type OAuthTokenCache = {
  token: string;
  expiresAt: number;
};

let oauthTokenCache: OAuthTokenCache | null = null;

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

async function fetchViaAllOrigins(
  upstreamPath: string,
  env: Record<string, string | undefined> | undefined,
): Promise<Response> {
  const redditUrl = `https://www.reddit.com${upstreamPath}`;
  const mirrorUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(redditUrl)}`;

  return fetch(mirrorUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': getProxyUserAgent(env),
    },
  });
}

function getProxyUserAgent(env: Record<string, string | undefined> | undefined): string {
  return env?.REDDIT_PROXY_USER_AGENT ?? 'RedAlt/1.0 (Cloudflare Pages proxy)';
}

async function getOAuthAccessToken(env: Record<string, string | undefined> | undefined): Promise<string | null> {
  const staticToken = env?.REDDIT_BEARER_TOKEN?.trim();

  if (staticToken) {
    return staticToken;
  }

  const clientId = env?.REDDIT_CLIENT_ID?.trim();
  const clientSecret = env?.REDDIT_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    return null;
  }

  const now = Date.now();

  if (oauthTokenCache && oauthTokenCache.expiresAt > now + 30000) {
    return oauthTokenCache.token;
  }

  try {
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': getProxyUserAgent(env),
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok || !isJsonContentType(response.headers.get('content-type'))) {
      return null;
    }

    const tokenPayload = (await response.json()) as {
      access_token?: unknown;
      expires_in?: unknown;
    };

    if (typeof tokenPayload.access_token !== 'string') {
      return null;
    }

    const expiresIn = typeof tokenPayload.expires_in === 'number' ? tokenPayload.expires_in : 3600;

    oauthTokenCache = {
      token: tokenPayload.access_token,
      expiresAt: now + Math.max(expiresIn - 60, 60) * 1000,
    };

    return oauthTokenCache.token;
  } catch {
    return null;
  }
}

async function fetchViaOAuth(
  upstreamPath: string,
  env: Record<string, string | undefined> | undefined,
): Promise<Response | null> {
  const token = await getOAuthAccessToken(env);

  if (!token) {
    return null;
  }

  try {
    return await fetch(`${OAUTH_HOST}${upstreamPath}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': getProxyUserAgent(env),
      },
    });
  } catch {
    return null;
  }
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

  const oauthResponse = await fetchViaOAuth(upstreamPath, context.env);

  if (oauthResponse?.ok && isJsonContentType(oauthResponse.headers.get('Content-Type'))) {
    const headers = new Headers();
    headers.set('Content-Type', oauthResponse.headers.get('Content-Type') ?? 'application/json');
    headers.set('Cache-Control', 'public, max-age=30, s-maxage=120');

    return new Response(oauthResponse.body, {
      status: oauthResponse.status,
      statusText: oauthResponse.statusText,
      headers: withCors(headers),
    });
  }

  let fallbackResponse: Response | null = null;

  for (const host of UPSTREAM_HOSTS) {
    const upstreamUrl = `${host}${upstreamPath}`;
    const upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': getProxyUserAgent(context.env),
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
          message: 'Reddit blocked this request from the current network. Configure Reddit OAuth credentials on the proxy to use authenticated API access.',
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

  const mirrorResponse = await fetchViaAllOrigins(upstreamPath, context.env);

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
