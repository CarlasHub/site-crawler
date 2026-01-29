FROM node:20-slim AS build
WORKDIR /app

COPY frontend ./frontend
WORKDIR /app/frontend
RUN npm install
RUN npm run build

WORKDIR /app
COPY backend ./backend
WORKDIR /app/backend
RUN npm install

EXPOSE 8080
CMD ["node", "index.js"]
