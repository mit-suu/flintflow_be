# Image production của BE (T24).
#
# Ba stage: deps (đủ devDependencies để build) → build (tsc) → runtime (chỉ dependencies).
# Tách runtime vì `mongodb-memory-server` là devDependency và postinstall của nó tải một bản mongod
# ~70 MB — thứ không có việc gì trong image chạy thật.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# assets/ nằm NGOÀI rootDir và `tsc` không emit .md/.json, nên phải copy tường minh — đây là lý do
# prompt asset từng không tồn tại trong image production (xem src/config/paths.ts).
COPY assets ./assets
# fixtures/ dùng cho `npm run seed:fixture` và cho smoke test sau deploy.
COPY fixtures ./fixtures
COPY scripts ./scripts

# Không chạy bằng root. `node` là user có sẵn trong image chính thức (uid 1000).
USER node

EXPOSE 5000
CMD ["node", "dist/server.js"]
