import { loadEnv, type Plugin } from 'vite';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
};

export function viteRedditProxy(): Plugin {
  let proxyModule: typeof import('./api/redditProxy.ts') | null = null;
  let proxyEnv: Record<string, string | undefined> = {};

  return {
    name: 'redalt-api-proxy',
    configResolved(config) {
      // Vite only exposes VITE_* variables to browser code. Load private proxy
      // credentials separately so local OAuth behaves like a real deployment.
      proxyEnv = loadEnv(config.mode, config.envDir, '');
    },
    async configureServer(server) {
      proxyModule = await import('./api/redditProxy.ts');

      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !proxyModule) {
          next();
          return;
        }

        const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

        if (url.pathname === '/api/status') {
          if (req.method === 'OPTIONS') {
            res.writeHead(204, CORS_HEADERS);
            res.end();
            return;
          }

          if (req.method !== 'GET') {
            res.writeHead(405, { ...CORS_HEADERS, Allow: 'GET, OPTIONS', 'Content-Type': 'text/plain' });
            res.end('Method not allowed');
            return;
          }

          res.writeHead(200, {
            ...CORS_HEADERS,
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(proxyModule.getRedditProxyStatus({ ...process.env, ...proxyEnv })));
          return;
        }

        if (!url.pathname.startsWith('/api/reddit')) {
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

        const upstreamPath = url.pathname.replace(/^\/api\/reddit/, '') + url.search;

        if (!proxyModule.isAllowedRedditPath(upstreamPath)) {
          res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'text/plain' });
          res.end('Invalid Reddit path');
          return;
        }

        try {
          const response = await proxyModule.handleRedditProxyRequest(
            upstreamPath,
            { ...process.env, ...proxyEnv },
            { userAgentFallback: proxyModule.REDDIT_PROXY_USER_AGENT },
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
          res.end(JSON.stringify({ error: 'proxy_failure', message: 'The local Reddit gateway failed. Please try again.' }));
        }
      });
    },
  };
}
