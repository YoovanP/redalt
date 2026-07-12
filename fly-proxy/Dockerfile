FROM node:22-alpine

WORKDIR /app

COPY api/redditProxy.ts /app/api/redditProxy.ts
COPY fly-proxy/server.mjs /app/fly-proxy/server.mjs

WORKDIR /app/fly-proxy

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.mjs"]
