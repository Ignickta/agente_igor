#!/usr/bin/env bash
#
# deploy.sh — Deploy do agente-igor numa VPS Ubuntu (Docker).
#
# Uso (como root, na VPS):
#   1) Coloque suas credenciais em /opt/agente-igor.env  (modelo: .env.example)
#   2) curl -fsSL https://raw.githubusercontent.com/Ignickta/agente_igor/main/deploy.sh -o deploy.sh
#   3) bash deploy.sh
#
# Reexecutar este script atualiza o app (git pull + rebuild + restart).
#
set -euo pipefail

# ===== Configuracoes =====
REPO_URL="https://github.com/Ignickta/agente_igor.git"
APP_DIR="/opt/agente-igor"
ENV_FILE="/opt/agente-igor.env"   # arquivo com os segredos (NAO versionado)
IMAGE_NAME="agente-igor"
CONTAINER_NAME="agente-igor"
PORT="3000"

log()  { echo -e "\n\033[1;32m==>\033[0m $*"; }
err()  { echo -e "\n\033[1;31mERRO:\033[0m $*" >&2; exit 1; }

# ===== 1. Pre-requisitos =====
[ "$(id -u)" -eq 0 ] || err "Rode como root (use: sudo bash deploy.sh)."

if ! command -v docker >/dev/null 2>&1; then
  log "Docker nao encontrado. Instalando..."
  apt-get update -y
  apt-get install -y ca-certificates curl git
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
  systemctl enable --now docker
else
  log "Docker ja instalado: $(docker --version)"
fi

command -v git >/dev/null 2>&1 || { apt-get update -y && apt-get install -y git; }

# ===== 2. Verifica o arquivo de credenciais =====
if [ ! -f "$ENV_FILE" ]; then
  err "Arquivo de credenciais nao encontrado em $ENV_FILE
  -> Crie-o com base no .env.example (preencha suas chaves) antes de rodar o deploy.
  -> Exemplo: nano $ENV_FILE"
fi
log "Usando credenciais de $ENV_FILE"

# ===== 3. Clona ou atualiza o repositorio =====
if [ -d "$APP_DIR/.git" ]; then
  log "Atualizando repositorio em $APP_DIR..."
  git -C "$APP_DIR" fetch --all --quiet
  git -C "$APP_DIR" reset --hard origin/main --quiet
else
  log "Clonando repositorio em $APP_DIR..."
  rm -rf "$APP_DIR"
  git clone --quiet "$REPO_URL" "$APP_DIR"
fi

# ===== 4. Build da imagem Docker =====
log "Construindo imagem Docker ($IMAGE_NAME)..."
docker build -t "$IMAGE_NAME" "$APP_DIR"

# ===== 5. (Re)sobe o container =====
log "Reiniciando container ($CONTAINER_NAME) na porta $PORT..."
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker run -d \
  --name "$CONTAINER_NAME" \
  --env-file "$ENV_FILE" \
  -p "${PORT}:3000" \
  --restart unless-stopped \
  "$IMAGE_NAME"

# ===== 6. Limpeza de imagens antigas =====
docker image prune -f >/dev/null 2>&1 || true

log "Deploy concluido! Status:"
docker ps --filter "name=$CONTAINER_NAME" --format "  {{.Names}} | {{.Status}} | {{.Ports}}"

echo -e "\nLogs ao vivo:   docker logs -f $CONTAINER_NAME"
echo -e "Healthcheck:    curl http://localhost:${PORT}/health"
