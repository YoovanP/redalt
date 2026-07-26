import { handleRedditProxyRequest, REDDIT_MOBILE_USER_AGENT, type RedditProxyEnv } from '../../../api/redditProxy';

type PagesFunctionContext = {
  request: Request;
  params: {
    path?: string | string[];
  };
  env?: RedditProxyEnv;
};

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

function buildUpstreamPath(paramsPath: string | string[] | undefined, url: URL): string {
  const path = Array.isArray(paramsPath) ? paramsPath.join('/') : paramsPath ?? '';
  const normalizedPath = path.replace(/^\/+/, '');

  return `/${normalizedPath}${url.search}`;
}

export async function onRequest(context: PagesFunctionContext): Promise<Response> {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: withCors(),
    });
  }

  if (context.request.method !== 'GET') {
    return new Response('Method not allowed', {
      status: 405,
      headers: withCors({
        Allow: 'GET, OPTIONS',
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      }),
    });
  }

  const incomingUrl = new URL(context.request.url);
  const upstreamPath = buildUpstreamPath(context.params.path, incomingUrl);
  const response = await handleRedditProxyRequest(upstreamPath, context.env, {
    userAgentFallback: REDDIT_MOBILE_USER_AGENT,
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: withCors(response.headers),
  });
}
