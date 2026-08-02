import { getRedditProxyStatus, type RedditProxyEnv } from './redditProxy';

type VercelRequestLike = {
  method?: string;
};

type VercelResponseLike = {
  setHeader(name: string, value: string): void;
  status(code: number): {
    send(body: string): void;
  };
};

function setCorsHeaders(res: VercelResponseLike): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

export default function handler(req: VercelRequestLike, res: VercelResponseLike): void {
  const method = (req.method ?? 'GET').toUpperCase();
  setCorsHeaders(res);

  if (method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).send('Method not allowed');
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(JSON.stringify(getRedditProxyStatus(process.env as RedditProxyEnv)));
}
