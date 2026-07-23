FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/tsconfig.json ./packages/protocol/
COPY apps/client/package.json apps/client/tsconfig.json apps/client/vite.config.ts apps/client/index.html ./apps/client/
RUN npm install --ignore-scripts --no-audit --no-fund
COPY packages/protocol ./packages/protocol
COPY apps/client ./apps/client
RUN npm run build -w @bridge/protocol && npm run build -w @bridge/client

FROM nginx:1.29-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/client/dist /usr/share/nginx/html
EXPOSE 80
