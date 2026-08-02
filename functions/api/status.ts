import { getRedditProxyStatus, type RedditProxyEnv } from '../../api/redditProxy';

type PagesFunctionContext = {
  request: Request;
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

export function onRequest(context: PagesFunctionContext): Response {
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

  return new Response(JSON.stringify(getRedditProxyStatus(context.env)), {
    status: 200,
    headers: withCors({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    }),
  });
}
