type PagesFunctionContext = {
  request: Request;
  params: {
    path?: string | string[];
  };
};

function buildUpstreamPath(paramsPath: string | string[] | undefined, url: URL): string {
  const path = Array.isArray(paramsPath) ? paramsPath.join('/') : paramsPath ?? '';
  const normalizedPath = path.replace(/^\/+/, '');
  const query = url.search || '';

  return `/${normalizedPath}${query}`;
}

export async function onRequest(context: PagesFunctionContext): Promise<Response> {
  const incomingUrl = new URL(context.request.url);
  const upstreamPath = buildUpstreamPath(context.params.path, incomingUrl);

  if (!upstreamPath.startsWith('/r/')) {
    return new Response('Invalid Reddit path', { status: 400 });
  }

  const upstreamUrl = `https://www.reddit.com${upstreamPath}`;

  const upstreamResponse = await fetch(upstreamUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'RedAlt/1.0 (Cloudflare Pages proxy)',
    },
  });

  const headers = new Headers();
  headers.set('Content-Type', upstreamResponse.headers.get('Content-Type') ?? 'application/json');
  headers.set('Cache-Control', 'public, max-age=30, s-maxage=120');

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}
