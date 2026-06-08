# ===== Build stage =====
FROM node:20-alpine AS build
WORKDIR /app

# Instala dependencias (inclui devDependencies para compilar o TypeScript)
COPY package*.json ./
RUN npm ci

# Compila o projeto
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ===== Runtime stage =====
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Apenas dependencias de producao
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copia o JS compilado
COPY --from=build /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/index.js"]
