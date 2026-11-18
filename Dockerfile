# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
# Prisma detecta la versión de OpenSSL al generar el cliente: debe existir aquí también.
RUN apk add --no-cache openssl
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
# `prisma` está en dependencies: sobrevive al prune y permite migrar al arrancar.
RUN npm run build && npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
USER node
EXPOSE 3000
# Aplica migraciones pendientes (usa DATABASE_URL_UNPOOLED) y arranca.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node dist/server.js"]
