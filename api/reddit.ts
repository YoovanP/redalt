import { handleRedditProxyRequest, REDDIT_PROXY_USER_AGENT, type RedditProxyEnv } from './redditProxy';

type VercelRequestLike = {
  method?: string;
  url?: string;
  query?: {
    path?: string | string[];
  };
};

type VercelResponseLike = {
  setHeader(name: string, value: string): void;
  status(code: number): {
    send(body: string): void;
  };
};

function buildUpstreamPath(pathParam: string | string[] | undefined, incomingUrl: URL): string {
  const path = Array.isArray(pathParam) ? pathParam.join('/') : pathParam ?? '';
  const normalizedPath = path.replace(/^\/+/, '');
  const params = new URLSearchParams(incomingUrl.search);
  params.delete('path');
  const query = params.toString();

  return `/${normalizedPath}${query ? `?${query}` : ''}`;
}

async function sendResponse(res: VercelResponseLike, response: Response): Promise<void> {
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  res.status(response.status).send(await response.text());
}

export default async function handler(req: VercelRequestLike, res: VercelResponseLike): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).send('Method not allowed');
    return;
  }

  const incomingUrl = new URL(req.url ?? '/', 'http://localhost');
  const upstreamPath = buildUpstreamPath(req.query?.path, incomingUrl);
  try {
    const response = await handleRedditProxyRequest(upstreamPath, process.env as RedditProxyEnv, {
      userAgentFallback: REDDIT_PROXY_USER_AGENT,
    });

    await sendResponse(res, response);
  } catch {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).send(
      JSON.stringify({
        error: 'proxy_failure',
        message: 'The Reddit gateway failed before a response was available. Please try again.',
        retryable: true,
      }),
    );
  }
}
