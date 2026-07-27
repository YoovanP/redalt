import type { Plugin } from 'vite';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
};

export function viteRedditProxy(): Plugin {
  let proxyModule: typeof import('./api/redditProxy.ts') | null = null;

  return {
    name: 'redalt-api-proxy',
    async configureServer(server) {
      proxyModule = await import('./api/redditProxy.ts');

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/reddit') || !proxyModule) {
          next();
          return;
        }

        if (req.method === 'OPTIONS') {
          res.writeHead(204, CORS_HEADERS);
          res.end();
          return;
        }

        if (req.method !== 'GET') {
          res.writeHead(405, { ...CORS_HEADERS, 'Content-Type': 'text/plain' });
          res.end('Method not allowed');
          return;
        }

        const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
        const upstreamPath = url.pathname.replace(/^\/api\/reddit/, '') + url.search;

        if (!proxyModule.isAllowedRedditPath(upstreamPath)) {
          res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'text/plain' });
          res.end('Invalid Reddit path');
          return;
        }

        try {
          const response = await proxyModule.handleRedditProxyRequest(
            upstreamPath,
            process.env as Record<string, string | undefined>,
            { userAgentFallback: proxyModule.REDDIT_MOBILE_USER_AGENT },
          );

          const headers: Record<string, string> = { ...CORS_HEADERS };
          response.headers.forEach((value: string, key: string) => {
            if (key.toLowerCase() !== 'access-control-allow-origin') {
              headers[key] = value;
            }
          });

          res.writeHead(response.status, headers);

          if (response.body) {
            const reader = (response.body as ReadableStream<Uint8Array>).getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
          }

          res.end();
        } catch {
          res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'proxy_failure' }));
        }
      });
    },
  };
}
