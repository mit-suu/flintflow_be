FROM node:22-alpine AS base
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# assets/ nằm NGOÀI rootDir và `tsc` không emit file .md/.json,
# nên phải copy tường minh — đây là lý do prompt asset từng không tồn tại
# trong image production (xem src/config/paths.ts).
COPY assets ./assets
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000

COPY --from=base /app/package*.json ./
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/dist ./dist
# Bắt buộc: prompt-registry đọc asset từ <cwd>/assets/prompts lúc chạy.
COPY --from=base /app/assets ./assets

EXPOSE 5000
CMD ["node", "dist/server.js"]
