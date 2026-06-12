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
- **RAG automático**: as trocas antigas mais similares à mensagem entram no contexto
  de toda resposta, sem depender de o modelo chamar a busca no histórico.

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

Do mais barato ao mais caro — cada degrau só roda se o anterior não decidir:

1. **Regex de agenda:** pedidos claramente de agenda vão direto ao orquestrador.
2. **Keyword match:** a mensagem é comparada com as `keywords` de cada subagente
   (grátis); decide sozinho com match forte (2+ keywords).
3. **Embedding:** a mensagem é comparada por similaridade com o descritor de cada
   subagente (o vetor sai do mesmo cache do RAG — sem chamada extra); decide quando
   a semelhança é forte E com folga sobre o 2º lugar (`EMB_ROUTE_MIN_SIM` /
   `EMB_ROUTE_MARGIN`, calibrados com a API real).
4. **Fallback LLM:** o modelo utilitário escolhe usando a mensagem + contexto recente
   + continuidade da última conversa, com o palpite do embedding como dica.
5. O subagente escolhido responde com seu prompt/personalidade e o histórico do contato.
6. A conversa é salva na **memória** (Firestore) para manter continuidade.

## ⏰ Mensagens proativas

- **Bom dia** todo dia às 07:00 (timezone de `TZ`, padrão `America/Sao_Paulo`).
- **Lembretes** verificados a cada minuto a partir da coleção `tasks`.

## 📦 Coleções no Firestore

- `subagents/{id}` — definições dos subagentes.
- `memory/{contato}/messages/{id}` — histórico de conversa.
- `tasks/{id}` — lembretes/tarefas agendadas.
- `shared_facts/{id}` — fatos de longo prazo (pool compartilhado, com embedding).
- `profiles/{contato}` — perfil vivo destilado da memória (injetado em todo prompt).

## 🧹 Manutenção noturna da memória

Todo dia às **03:30** um job silencioso cuida da memória de longo prazo:

1. **Reflexão diária** — relê as conversas das últimas 24h e extrai o que ficou
   para trás: fatos duradouros que não foram salvos na hora e promessas com ação
   futura ("amanhã ligo pro João") que não viraram lembrete — essas viram
   follow-ups automáticos (respeitando o kill-switch `PROACTIVE_NOTIFICATIONS`).
2. **Consolidação dos fatos** — funde duplicados, aplica correções (um fato
   "Correção: ..." substitui o fato errado) e arquiva fatos pontuais já expirados.
   Arquivar é reversível (flag `archived`); nada é apagado.
3. **Perfil vivo** — destila dos fatos um resumo do Igor (rotina, projetos,
   preferências, decisões vigentes) salvo em `profiles/{contato}` e injetado no
   system prompt de **todos** os subagentes, em toda mensagem.

No boot, se ainda não existir perfil, ele é gerado uma única vez automaticamente.

## 🧪 Evals de regressão

Casos reais que já quebraram (ou quase) viram testes: regex de agenda, atalho
"feito", guarda anti-alucinação, roteamento por keywords e aritmética de datas/fuso.
**Rode antes de qualquer deploy que mexa em prompts, regex ou roteamento:**

```bash
npm run eval            # suítes determinísticas (sem custo de API)
npm run eval -- --live  # + roteador LLM real (algumas chamadas do utility model)
```

Requer o `.env` do projeto. Sai com código 1 se algum caso falhar. Ao mexer em
`DONE_PHRASES`, `AGENDA_REGEX`, `CLAIMS_ACTION_REGEX` ou keywords de subagentes,
adicione o caso novo em `src/eval/run.ts`.

## 🚀 Deploy na VPS (Docker)

O deploy roda o app num container Docker, na porta 3000, com restart automático.

### Na sua VPS (Ubuntu, como root):

```bash
# 1. Crie o arquivo de credenciais (segredos NÃO ficam no Git)
nano /opt/agente-igor.env
#    -> cole o conteúdo baseado no .env.example, com suas chaves reais

# 2. Baixe e rode o script de deploy
curl -fsSL https://raw.githubusercontent.com/Ignickta/agente_igor/main/deploy.sh -o deploy.sh
bash deploy.sh
```

O script instala o Docker (se necessário), clona o repositório, builda a imagem e sobe o container.

### Atualizar depois de um novo commit:

```bash
bash deploy.sh   # faz git pull + rebuild + restart
```

### Comandos úteis:

```bash
docker logs -f agente-igor          # ver logs ao vivo
docker restart agente-igor          # reiniciar
curl http://localhost:3000/health   # checar se está no ar
```

> O `.env` de produção fica em `/opt/agente-igor.env` (fora do repositório). Nunca commite segredos.

## 📝 Licença

MIT
