# ===== Build stage =====
FROM node:20-alpine AS build
WORKDIR /app

# Instala dependencias (inclui devDependencies para compilar o TypeScript)
COPY package*.json ./
RUN npm ci \
    --fetch-retries=5 \
    --fetch-retry-mintimeout=20000 \
    --fetch-retry-maxtimeout=120000

# Compila o projeto
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ===== Runtime stage =====
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Commit do build, exposto em /health para conferir qual versão está no ar.
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA

# Apenas dependencias de producao
COPY package*.json ./
RUN npm ci --omit=dev \
    --fetch-retries=5 \
    --fetch-retry-mintimeout=20000 \
    --fetch-retry-maxtimeout=120000 \
    && npm cache clean --force

# Copia o JS compilado
COPY --from=build /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/index.js"]
