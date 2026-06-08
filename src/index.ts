import express, { Request, Response } from 'express';
import { config, isAllowed } from './config';
import { adminRouter } from './routes/admin';
import { parseWebhook } from './services/webhookParser';
import { transcribeAudioBase64 } from './services/transcription';
import { sendText } from './services/evolution';
import { handleMessage } from './agents/central';
import { seedDefaultSubagents } from './services/firebase';
import { DEFAULT_SUBAGENTS } from './agents/subagents/defaults';
import { startScheduler } from './scheduler';

const app = express();
app.use(express.json({ limit: '25mb' }));

// CORS — permite que o painel web (agente-igor-web) consuma a API do navegador.
// Aberto por padrão; restrinja via CORS_ORIGIN (ex: https://painel.seudominio.com).
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Healthcheck
app.get('/', (_req, res) => res.json({ ok: true, name: 'agente-igor' }));
app.get('/health', (_req, res) => res.json({ status: 'up' }));

// Rotas administrativas (CRUD de subagentes e tarefas)
app.use('/admin', adminRouter);

/**
 * Webhook da Evolution API.
 * Responde 200 imediatamente e processa de forma assíncrona para evitar
 * timeouts e reentregas do webhook.
 */
app.post('/webhook', (req: Request, res: Response) => {
  res.sendStatus(200);
  processIncoming(req.body).catch((err) =>
    console.error('[webhook] erro ao processar:', err)
  );
});

async function processIncoming(body: unknown): Promise<void> {
  const msg = await parseWebhook(body);
  if (!msg) return;

  // Trava de segurança: só responde a números autorizados (allowlist + dono).
  if (!isAllowed(msg.from)) {
    console.log(`[webhook] mensagem ignorada de número não autorizado: ${msg.from}`);
    return;
  }

  let text = msg.text || '';

  // Transcreve áudio se necessário
  if (msg.isAudio) {
    if (!msg.audioBase64) {
      await sendText(msg.from, 'Não consegui baixar seu áudio 😕. Pode tentar de novo?');
      return;
    }
    try {
      console.log(
        `[webhook] transcrevendo áudio de ${msg.from} (${msg.audioBase64.length} chars base64)...`
      );
      text = await transcribeAudioBase64(msg.audioBase64);
      console.log(`[webhook] áudio transcrito de ${msg.from}: "${text}"`);
    } catch (err) {
      console.error(
        '[webhook] falha na transcrição:',
        err instanceof Error ? err.message : err
      );
      await sendText(msg.from, 'Tive um problema para transcrever seu áudio. Pode escrever?');
      return;
    }
  }

  if (!text.trim()) return;

  // Roteia pelo agente central e responde
  try {
    const reply = await handleMessage(msg.from, text, msg.isAudio);
    await sendText(msg.from, reply);
  } catch (err) {
    console.error('[webhook] falha ao gerar/enviar resposta:', err);
    await sendText(msg.from, 'Ops, algo deu errado aqui. Tenta de novo em instantes? 🙏');
  }
}

async function bootstrap(): Promise<void> {
  // Garante os subagentes padrão no primeiro boot
  await seedDefaultSubagents(DEFAULT_SUBAGENTS);

  // Inicia jobs proativos (bom dia, lembretes)
  startScheduler();

  app.listen(config.server.port, () => {
    console.log(`🤖 agente-igor rodando na porta ${config.server.port}`);
    console.log(`   Webhook:  POST /webhook`);
    console.log(`   Admin:    /admin/subagents`);
  });
}

bootstrap().catch((err) => {
  console.error('Falha no bootstrap:', err);
  process.exit(1);
});
