type PagesFunctionContext = {
  request: Request;
  params: {
    path?: string | string[];
  };
};

type RedgifsAuthResponse = {
  token?: string;
};

type RedgifsGifResponse = {
  gif?: {
    id?: string;
    urls?: {
      hd?: string;
      sd?: string;
      hls?: string;
      poster?: string;
      thumbnail?: string;
      vthumbnail?: string;
    };
  };
};

function getPathParts(input: string | string[] | undefined): string[] {
  if (Array.isArray(input)) {
    return input.map((part) => part.trim()).filter(Boolean);
  }

  if (typeof input === 'string') {
    return input.split('/').map((part) => part.trim()).filter(Boolean);
  }

  return [];
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60, s-maxage=180',
    },
  });
}

async function fetchRedgifsToken(): Promise<string> {
  const response = await fetch('https://api.redgifs.com/v2/auth/temporary', {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'RedAlt/1.0 (Cloudflare Pages)',
    },
  });

  if (!response.ok) {
    throw new Error(`Unable to authenticate with RedGIFs (${response.status})`);
  }

  const payload = (await response.json()) as RedgifsAuthResponse;

  if (!payload.token) {
    throw new Error('RedGIFs token missing');
  }

  return payload.token;
}

async function resolveRedgifsGif(id: string, origin: string): Promise<Response> {
  const token = await fetchRedgifsToken();
  const response = await fetch(`https://api.redgifs.com/v2/gifs/${encodeURIComponent(id)}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'RedAlt/1.0 (Cloudflare Pages)',
    },
  });

  if (!response.ok) {
    return jsonResponse({ error: 'Unable to fetch RedGIFs metadata.' }, response.status);
  }

  const payload = (await response.json()) as RedgifsGifResponse;
  const urls = payload.gif?.urls;

  if (!urls) {
    return jsonResponse({ error: 'RedGIFs metadata has no stream URLs.' }, 404);
  }

  const toProxy = (value: string | undefined) =>
    value ? `${origin}/api/redgifs/media?u=${encodeURIComponent(value)}` : undefined;

  return jsonResponse({
    id: payload.gif?.id ?? id,
    hlsUrl: toProxy(urls.hls),
    sdUrl: toProxy(urls.sd),
    hdUrl: toProxy(urls.hd),
    posterUrl: toProxy(urls.poster ?? urls.thumbnail ?? urls.vthumbnail),
  });
}

async function streamMedia(requestUrl: URL): Promise<Response> {
  const upstreamRaw = requestUrl.searchParams.get('u')?.trim();

  if (!upstreamRaw) {
    return new Response('Missing media URL', { status: 400 });
  }

  let upstreamUrl: URL;

  try {
    upstreamUrl = new URL(upstreamRaw);
  } catch {
    return new Response('Invalid media URL', { status: 400 });
  }

  const host = upstreamUrl.hostname.toLowerCase();

  if (!host.endsWith('redgifs.com') && !host.endsWith('redgifsusercontent.com')) {
    return new Response('Unsupported media host', { status: 400 });
  }

  const upstreamResponse = await fetch(upstreamUrl.toString(), {
    headers: {
      Accept: '*/*',
      'User-Agent': 'RedAlt/1.0 (Cloudflare Pages)',
    },
  });

  if (!upstreamResponse.ok) {
    return new Response('Unable to load media', { status: upstreamResponse.status });
  }

  const headers = new Headers();
  headers.set('Content-Type', upstreamResponse.headers.get('Content-Type') ?? 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=300, s-maxage=900');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Accept-Ranges', upstreamResponse.headers.get('Accept-Ranges') ?? 'bytes');

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

export async function onRequest(context: PagesFunctionContext): Promise<Response> {
  const requestUrl = new URL(context.request.url);
  const pathParts = getPathParts(context.params.path);

  try {
    if (pathParts[0] === 'resolve' && pathParts[1]) {
      return await resolveRedgifsGif(pathParts[1], requestUrl.origin);
    }

    if (pathParts[0] === 'media') {
      return await streamMedia(requestUrl);
    }

    return jsonResponse({ error: 'Unsupported RedGIFs endpoint.' }, 404);
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : 'Unknown RedGIFs proxy error.',
      },
      500,
    );
  }
}
