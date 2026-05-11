# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# ffmpeg is needed at build time only if the build process invokes it;
# it is definitely needed at runtime for audio conversion.
RUN apk add --no-cache ffmpeg python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Stage 2: Run ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

RUN apk add --no-cache ffmpeg

WORKDIR /app

# Production dependencies only (no devDeps, no tsx, no vite)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the compiled server + client assets from the builder stage
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=5001

EXPOSE 5001

CMD ["node", "dist/index.js"]
