FROM node:22-alpine
RUN apk add --no-cache poppler-utils python3 py3-pillow tesseract-ocr tesseract-ocr-data-ara
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY server.js db.js llm.js admin-api.js admin-db.js ./
COPY migrations ./migrations
COPY site ./site
ENV NODE_ENV=production
ENV FRAME_ANCESTORS="'self' https://*.manus.computer https://*.manus.space"
EXPOSE 3000
CMD ["node", "server.js"]
