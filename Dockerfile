ARG NODE_IMAGE=node:22.11.0-bookworm-slim@sha256:8ec2cb286d3aaeedb688ff3c72c2f01b4f42e7a9e3d74edb4a0b48a8cb4be9f8

FROM ${NODE_IMAGE} AS frontend-build
WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/index.html ./index.html
COPY frontend/public ./public
COPY frontend/src ./src
COPY frontend/vite.config.js ./vite.config.js
RUN npm run build

FROM ${NODE_IMAGE} AS backend-deps
WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

FROM ${NODE_IMAGE} AS runtime
WORKDIR /home/node/app
ENV NODE_ENV=production \
    HOME=/home/node

RUN mkdir -p /home/node/app/backend /home/node/app/frontend \
  && chown -R node:node /home/node/app

COPY --chown=node:node backend/package.json backend/package-lock.json ./backend/
COPY --chown=node:node backend/index.js ./backend/index.js
COPY --chown=node:node backend/job-store.js ./backend/job-store.js
COPY --from=backend-deps --chown=node:node /app/backend/node_modules ./backend/node_modules
COPY --from=frontend-build --chown=node:node /app/frontend/dist ./frontend/dist

WORKDIR /home/node/app/backend
USER node:node
EXPOSE 8080
CMD ["node", "index.js"]
