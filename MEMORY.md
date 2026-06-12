# MEMORY — agente-igor (backend)

> Resumo do que foi construído e decisões técnicas. Documento vivo — atualize ao mudar algo relevante.

## O que é

Agente pessoal de IA que conversa pelo **WhatsApp** (via Evolution API), identifica de qual
projeto o usuário fala, roteia para o **subagente** correto (cada um com personalidade própria),
transcreve áudios, responde em áudio, cria lembretes por linguagem natural e envia mensagens
proativas (bom dia, lembretes). Backend Node.js + TypeScript + Express + Firebase + OpenAI.

## Infraestrutura (produção)

- **VPS**: Hostinger Ubuntu 24, IP `31.97.160.54`, root via SSH.
- **Backend**: container Docker no VPS, porta **3001**, exposto em `https://agente.ntagroupvps.com.br` (via Cloudflare Tunnel no domínio `ntagroupvps.com.br`).
- **Evolution API**: dentro do EasyPanel (porta 3000 do VPS). URL boa: `https://evolution-api-evolution-api.8czacf.easypanel.host`. Instância `agente-igor`, v2.3.7.
  - ⚠️ O domínio `evolution.ntagroupvps.com.br` tem roteamento quebrado — **não usar**.
- **Número conectado na Evolution**: chip do Arroz Predileto/Marrecão `557781220815` (é só o "corpo" do agente).
- **Quem fala com o agente**: número pessoal do Igor `5571999000726` (= `OWNER_PHONE` e única entrada da allowlist).
- **Firebase**: projeto `agente-igor` (Firestore). Coleções: `subagents`, `tasks`, `metrics`, `memory/{contato}/agents/{subagentId}/{messages,facts}`.
- **Frontend**: `agente-igor-web` (Next.js) no Vercel — `https://agente-igor-web.vercel.app`.
- **Deploy**: `.env` de produção em `/opt/agente-igor.env`; rodar `bash deploy.sh` (git pull + docker build + restart, `--restart unless-stopped`).

## Estrutura

```
src/
├── index.ts                 # Express + webhook + CORS; orquestra transcrição→agente→resposta(texto/áudio)
├── config.ts                # env validado; normalizePrivateKey (Firebase); allowlist (isAllowed)
├── types.ts                 # Subagent, MemoryMessage, Task, IncomingMessage
├── scheduler.ts             # cron: reconexão Evolution (5min), bom dia (7h), lembretes (1min)
├── agents/
│   ├── central.ts           # roteamento (keyword → LLM); registra métrica; memória por subagente
│   ├── commands.ts          # comandos /criar /agentes /remover /lembrar ... (só OWNER)
│   └── subagents/
│       ├── index.ts         # runSubagent com FUNCTION CALLING (criar_lembrete, salvar_fato) + fatos no prompt
│       └── defaults.ts      # 6 subagentes padrão (seed no 1º boot)
├── routes/admin.ts          # CRUD subagentes; CRUD tarefas; GET /admin/stats; auth x-admin-token
└── services/
    ├── evolution.ts         # sendText (com delay="digitando"), sendAudio, getBase64, getConnectionState, connectInstance, ensureConnected
    ├── firebase.ts          # subagentes, tarefas, memória/fatos por subagente, métricas (recordMessage/getMetrics)
    ├── openai.ts            # cliente chat (gpt-4o)
    ├── transcription.ts     # Whisper (base64→texto), language=pt, content-type por extensão
    └── tts.ts               # TTS (texto→áudio opus base64)
```

## Decisões técnicas importantes

- **Roteamento 2 estágios**: keyword match (barato) → fallback LLM. Roteia ANTES de carregar memória (memória é por subagente).
- **Memória por subagente**: `memory/{contato}/agents/{id}/messages` — não mistura assuntos (arroz ≠ estudos). A estrutura antiga (global) foi descontinuada.
- **Function calling**: o agente cria lembretes ("me lembra amanhã 14h") e salva fatos sozinho. Loop de até 4 passos de tool-calling.
- **TTS só quando entrada é áudio**: responde em áudio + texto (texto sempre, como fallback/registro). Controla custo.
- **"Digitando..."**: a Evolution 2.3.7 NÃO tem endpoint de presença (`sendPresence` dá 404); usamos o `delay` do `sendText` (mesmo efeito visual).
- **Métricas sem índice composto**: `metrics/{YYYY-MM-DD}` com contadores incrementais por subagente; leitura por `getAll` de ids de dia (lição do bug de índice do Firestore).
- **getDueTasks** evita índice composto (filtra `done` no servidor, horário em memória).
- **FIREBASE_PRIVATE_KEY** normalizada (aspas, `\n`, CRLF) p/ funcionar com `docker --env-file`.
- **CORS** habilitado (`CORS_ORIGIN`, default `*`) para o painel Vercel consumir a API.
- **Allowlist**: só `OWNER_PHONE` + `ALLOWED_NUMBERS` falam com o agente; resto é ignorado.
- **Reconexão automática**: `ensureConnected` a cada 5min — se estado ≠ `open`, chama `GET /instance/connect`.

## Variáveis de ambiente

`EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`, `OPENAI_API_KEY`,
`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `PORT`,
`OWNER_PHONE`, `TZ` (America/Bahia), `ADMIN_TOKEN`, `ALLOWED_NUMBERS`, `CORS_ORIGIN`.
Opcionais: `OPENAI_MODEL`, `OPENAI_TTS_MODEL`, `OPENAI_TTS_VOICE`.

## Endpoints (todos sob /admin exigem x-admin-token)

- `GET /health`
- `GET|POST /admin/subagents`, `GET|PUT|DELETE /admin/subagents/:id`
- `GET /admin/tasks` (filtros `?subagent=` e `?upcoming=true`), `POST /admin/tasks`, `PUT|DELETE /admin/tasks/:id`
- `GET /admin/stats?days=N` (mensagens hoje, total e uso por projeto)

## Status (2026-06-08)

Fases 1, 2 e 3 implementadas, testadas e em produção (deploy feito). Backend e frontend no ar.

## Próximos passos / pendências

- [ ] **Ativar o Google Calendar (F10)** — o código está em produção desde 2026-06-12, mas
  DESLIGADO (sem `GOOGLE_CALENDAR_ID` tudo é no-op). Para ativar (~5 min):
  1. Habilitar a **Google Calendar API** no projeto Google Cloud do Firebase:
     https://console.cloud.google.com/apis/library/calendar-json.googleapis.com (selecionar o projeto `agente-igor`).
  2. No https://calendar.google.com → Configurações → agenda principal → *Compartilhar com
     pessoas específicas* → adicionar o e-mail da service account (o `FIREBASE_CLIENT_EMAIL`
     do `/opt/agente-igor.env`) com permissão **"Fazer alterações nos eventos"**.
  3. Na VPS: adicionar `GOOGLE_CALENDAR_ID=igor.nta@gmail.com` em `/opt/agente-igor.env` e
     rodar `docker restart agente-igor`. Conferir nos logs o `[calendarSync]` após o boot.
  Detalhes na seção "📆 Google Calendar" do README.
- [ ] **Segurança**: trocar `ADMIN_TOKEN` (estava `troque-este-token` em algum momento) e revogar a chave OpenAI antiga exposta no chat, gerando nova.
- [ ] **Validar no WhatsApp** o fluxo real ponta a ponta: áudio→transcrição→resposta em áudio; lembrete por linguagem natural; reconexão após queda real do Baileys.
- [ ] **Confirmar rota de áudio** (`sendWhatsAppAudio`) na Evolution — não foi possível validar com instância offline.
- [ ] **Ideias futuras**: histórico de conversas no painel; resumo de memória longa; responder clientes do Arroz (se desejar); testes automatizados + CI.
```
