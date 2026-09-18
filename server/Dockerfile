FROM node:24-alpine AS deps

WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci

FROM node:24-alpine AS build

WORKDIR /app
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY server ./server
COPY shared ./shared
WORKDIR /app/server
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache bash postgresql-client
COPY --from=build /app/server/package*.json ./server/
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/db ./server/db
COPY --from=build /app/server/assets ./server/assets
RUN mkdir -p /app/server/server-data \
    && chown -R node:node /app/server/server-data
WORKDIR /app/server
USER node
EXPOSE 3000
CMD ["npm", "start"]
