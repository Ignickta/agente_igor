# 🤖 agente-igor

Agente pessoal de IA que conversa pelo **WhatsApp** (via Evolution API), entende de qual
projeto você está falando e roteia para o **subagente** certo — cada um com contexto e
personalidade própria. Também transcreve áudios automaticamente (Whisper) e envia mensagens
proativas (bom dia, lembretes).

## ✨ Funcionalidades

- Recebe mensagens **e áudios** via WhatsApp (Evolution API).
- **Agente central** identifica o projeto e roteia para o subagente correto (keyword + LLM).
- Cada **subagente** tem prompt/personalidade própria, carregados dinamicamente do Firebase.
- **Transcrição de áudio** automática via OpenAI Whisper.
- **Mensagens proativas** agendadas (node-cron): bom dia e lembretes.
- Subagentes **criados/removidos dinamicamente** via API admin (e, no futuro, pelo próprio WhatsApp).
- **Memória** de conversa por contato no Firestore.

### Subagentes iniciais

| Subagente | Tema |
|---|---|
| SaaS Odontológico | gestão de clínicas, dev Next.js/Firebase |
| Vendas de Arroz | Predileto / Marrecão, pedidos, distribuidores |
| Automação / n8n | workflows, integrações, propostas |
| Pessoal / Particular | rotina, saúde, casa, lembretes |
| Estudos / Aprendizado | tutor, resumos, planos de estudo |
| Blog de Finanças | pautas, artigos, SEO |

## 🧱 Stack

Node.js + TypeScript · Express · OpenAI SDK (GPT-4o + Whisper) · Firebase Admin SDK · Axios · node-cron

## 📁 Estrutura

```
agente-igor/
├── src/
│   ├── index.ts                 # Servidor Express + webhook
│   ├── config.ts                # Carrega e valida variáveis de ambiente
│   ├── types.ts                 # Tipos compartilhados
│   ├── scheduler.ts             # Mensagens proativas (cron)
│   ├── agents/
│   │   ├── central.ts           # Agente central (roteamento)
│   │   └── subagents/
│   │       ├── index.ts         # Execução de um subagente
│   │       └── defaults.ts      # Subagentes padrão (seed)
│   ├── routes/
│   │   └── admin.ts             # CRUD de subagentes e tarefas
│   └── services/
│       ├── evolution.ts         # Envio de mensagens (Evolution API)
│       ├── firebase.ts          # Memória, tarefas e subagentes
│       ├── openai.ts            # Cliente de chat (GPT-4o)
│       ├── transcription.ts     # Transcrição de áudio (Whisper)
│       └── webhookParser.ts     # Normaliza o payload da Evolution
├── .env.example
├── package.json
└── tsconfig.json
```

## 🚀 Setup

### 1. Instalar dependências

```bash
npm install
```

### 2. Configurar variáveis de ambiente

```bash
cp .env.example .env
```

Preencha o `.env`:

| Variável | Descrição |
|---|---|
| `EVOLUTION_API_URL` | URL da sua Evolution API |
| `EVOLUTION_API_KEY` | API key global da Evolution |
| `EVOLUTION_INSTANCE` | Nome da instância conectada ao WhatsApp |
| `OPENAI_API_KEY` | Chave da OpenAI (GPT-4o + Whisper) |
| `FIREBASE_PROJECT_ID` | ID do projeto Firebase |
| `FIREBASE_CLIENT_EMAIL` | E-mail da service account |
| `FIREBASE_PRIVATE_KEY` | Private key da service account (entre aspas, com `\n`) |
| `PORT` | Porta do servidor (padrão 3000) |
| `OWNER_PHONE` *(opcional)* | Seu número para mensagens proativas (ex: `5511999999999`) |
| `ADMIN_TOKEN` *(opcional)* | Token para proteger as rotas `/admin` |
| `ALLOWED_NUMBERS` *(opcional)* | Números autorizados a falar com o agente (só dígitos, separados por vírgula). O dono já entra automático. |

> 🔒 **Segurança:** o agente só responde a números na allowlist (`ALLOWED_NUMBERS` + `OWNER_PHONE`). Mensagens de qualquer outro número são ignoradas. Mensagens proativas (bom dia/lembretes) vão **apenas** para o dono.

> **Firebase:** baixe a service account em *Configurações do projeto → Contas de serviço → Gerar nova chave privada* e copie `project_id`, `client_email` e `private_key`.

### 3. Rodar em desenvolvimento

```bash
npm run dev
```

No primeiro boot, os subagentes padrão são gravados no Firestore automaticamente.

### 4. Build e produção

```bash
npm run build
npm start
```

## 🔗 Configurar o webhook na Evolution API

Aponte o webhook da sua instância para `https://SEU_HOST/webhook`, habilitando o evento
**`messages.upsert`**. Em desenvolvimento, exponha sua porta local com algo como `ngrok http 3000`.

## 🛠️ API Admin

Todas as rotas exigem o header `x-admin-token: <ADMIN_TOKEN>` (se configurado).

```bash
# Listar subagentes
curl http://localhost:3000/admin/subagents -H "x-admin-token: SEU_TOKEN"

# Criar subagente
curl -X POST http://localhost:3000/admin/subagents \
  -H "x-admin-token: SEU_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Novo Projeto","keywords":["foo","bar"],"prompt":"Você é ..."}'

# Editar subagente
curl -X PUT http://localhost:3000/admin/subagents/ID \
  -H "x-admin-token: SEU_TOKEN" -H "Content-Type: application/json" \
  -d '{"active":false}'

# Remover subagente
curl -X DELETE http://localhost:3000/admin/subagents/ID -H "x-admin-token: SEU_TOKEN"

# Criar lembrete
curl -X POST http://localhost:3000/admin/tasks \
  -H "x-admin-token: SEU_TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"Ligar para o fornecedor","remindAt":"2026-06-09T13:00:00.000Z"}'
```

## 💬 Comandos pelo WhatsApp

Mensagens que começam com `/` são comandos administrativos — **só o dono** (`OWNER_PHONE`) pode usá-los:

| Comando | O que faz |
|---|---|
| `/ajuda` | Lista os comandos |
| `/agentes` | Lista seus subagentes (com id e status) |
| `/criar Nome \| palavra1, palavra2 \| prompt` | Cria um subagente |
| `/remover <id>` | Remove um subagente |
| `/ativar <id>` / `/desativar <id>` | Liga/desliga um subagente |
| `/lembrar 2026-06-09T13:00 \| texto` | Agenda um lembrete |

Exemplo:

```
/criar Academia | treino, dieta, academia | Você é meu personal trainer pessoal.
```

## 🧠 Como funciona o roteamento

1. **Keyword match:** a mensagem é comparada com as `keywords` de cada subagente (barato, sem LLM).
2. **Fallback LLM:** se nenhuma keyword bater, o GPT-4o escolhe o subagente usando a mensagem + contexto recente.
3. O subagente escolhido responde com seu prompt/personalidade e o histórico do contato.
4. A conversa é salva na **memória** (Firestore) para manter continuidade.

## ⏰ Mensagens proativas

- **Bom dia** todo dia às 07:00 (timezone de `TZ`, padrão `America/Sao_Paulo`).
- **Lembretes** verificados a cada minuto a partir da coleção `tasks`.

## 📦 Coleções no Firestore

- `subagents/{id}` — definições dos subagentes.
- `memory/{contato}/messages/{id}` — histórico de conversa.
- `tasks/{id}` — lembretes/tarefas agendadas.

## 📝 Licença

MIT
