FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/tsconfig.json ./packages/protocol/
COPY apps/relay/package.json apps/relay/tsconfig.json ./apps/relay/
RUN npm install --ignore-scripts --no-audit --no-fund
COPY packages/protocol ./packages/protocol
COPY apps/relay ./apps/relay
RUN npm run build -w @bridge/protocol && npm run build -w @bridge/relay

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY apps/relay/package.json ./apps/relay/package.json
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund --workspace @bridge/relay
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/apps/relay/dist ./apps/relay/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8788
CMD ["node", "apps/relay/dist/index.js"]
