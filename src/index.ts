import express, { Request, Response } from 'express';
import { config, isAllowed } from './config';
import { adminRouter } from './routes/admin';
import { parseWebhook } from './services/webhookParser';
import { transcribeAudioBase64 } from './services/transcription';
import { extractFromImage, extractFromPdf } from './services/vision';
import { sendText, sendAudio } from './services/evolution';
import { textToSpeechBase64 } from './services/tts';
import { handleMessage } from './agents/central';
import { splitWhatsAppReply, wantsAudioReply } from './agents/replyFormat';
import { isFocusRequest, isCancelFocusRequest, enterFocus, cancelFocus, focusGate } from './agents/focus';
import { isPauseRequest, isResumeRequest, enterPause, leavePause } from './agents/pause';
import { seedDefaultSubagents, ensureSubagent } from './services/firebase';
import { DEFAULT_SUBAGENTS, ORCHESTRATOR_SUBAGENT } from './agents/subagents/defaults';
import { startScheduler } from './scheduler';
import { recordMessageProcessed, recordError } from './services/status';
import { loadSettings } from './services/settings';
import { enqueueMessage } from './services/messageBuffer';

const app = express();
app.use(express.json({ limit: '25mb' }));

// Garante que duas mensagens próximas do mesmo contato não leiam e alterem o
// estado das tarefas em paralelo. Contatos diferentes continuam independentes.
const contactQueues = new Map<string, Promise<void>>();

function processInContactQueue(contact: string, work: () => Promise<void>): Promise<void> {
  const previous = contactQueues.get(contact) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  contactQueues.set(contact, current);
  current.finally(() => {
    if (contactQueues.get(contact) === current) contactQueues.delete(contact);
  });
  return current;
}

// CORS — permite que o painel web (agente-igor-web) consuma a API do navegador.
// Aberto por padrão; restrinja via CORS_ORIGIN (ex: https://painel.seudominio.com).
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Healthcheck — `version` é o commit do build (GIT_SHA via deploy.sh) e
// `startedAt` diz quando o container subiu, para conferir se o deploy pegou.
const startedAt = new Date().toISOString();
app.get('/', (_req, res) => res.json({ ok: true, name: 'agente-igor' }));
app.get('/health', (_req, res) =>
  res.json({ status: 'up', version: process.env.GIT_SHA || 'dev', startedAt })
);

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

  recordMessageProcessed();

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
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(
        '[webhook] falha na transcrição:',
        errMsg
      );
      recordError(`Falha na transcrição de áudio: ${errMsg}`);
      await sendText(msg.from, 'Tive um problema para transcrever seu áudio. Pode escrever?');
      return;
    }
  }

  // Imagem ou documento (PDF): extrai o conteúdo via visão e injeta no fluxo
  // como texto — foto de boleto vira dados de pagamento, print vira pedido.
  if (msg.mediaType) {
    if (!msg.mediaBase64) {
      await sendText(msg.from, 'Não consegui baixar sua mídia 😕. Pode reenviar?');
      return;
    }
    if (msg.mediaType === 'document' && !(msg.mimeType || '').includes('pdf')) {
      await sendText(
        msg.from,
        'Por enquanto só consigo ler documentos em PDF 😕. Pode mandar em PDF ou me contar por texto?'
      );
      return;
    }
    try {
      console.log(`[webhook] lendo ${msg.mediaType} de ${msg.from}...`);
      const extracted =
        msg.mediaType === 'image'
          ? await extractFromImage(msg.mediaBase64, msg.mimeType || 'image/jpeg')
          : await extractFromPdf(msg.mediaBase64, msg.fileName || 'documento.pdf');
      if (!extracted) throw new Error('extração vazia');
      const tipo =
        msg.mediaType === 'image' ? 'uma imagem' : `um documento (${msg.fileName || 'PDF'})`;
      const pedido =
        msg.caption?.trim() ||
        '(sem legenda — interprete o conteúdo, resuma o essencial e sugira a ação mais útil; ' +
          'se for boleto/cobrança, ofereça criar o lembrete de pagamento no vencimento)';
      text =
        `[O Igor enviou ${tipo} pelo WhatsApp. Conteúdo extraído:]\n${extracted}\n\n` +
        `[Pedido do Igor na legenda:] ${pedido}`;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[webhook] falha ao ler mídia:', errMsg);
      recordError(`Falha ao ler mídia (${msg.mediaType}): ${errMsg}`);
      await sendText(
        msg.from,
        'Recebi sua mídia, mas não consegui ler o conteúdo 😕. Pode me dizer por texto?'
      );
      return;
    }
  }

  if (!text.trim()) return;

  // Debounce de rajada: texto simples do usuário é agrupado por contato numa
  // janela curta antes de processar — várias mensagens seguidas viram UMA só,
  // o que evita respostas em dobro com agendas conflitantes. Áudio/mídia e
  // ações de foco/comando seguem direto (chegam como unidade ou são one-shot).
  const isCommand = text.trim().startsWith('/');
  const isFocusAction = isCancelFocusRequest(text) || isFocusRequest(text);
  const debounceable = !msg.isAudio && !msg.mediaType && !isCommand && !isFocusAction;

  if (debounceable) {
    const isAudio = msg.isAudio;
    const quotedText = msg.quotedText;
    enqueueMessage(msg.from, text, (merged) => {
      processInContactQueue(msg.from, () =>
        handleResolvedText(msg.from, merged, isAudio, quotedText)
      ).catch((err) => console.error('[webhook] erro ao processar lote:', err));
    });
    return;
  }

  await processInContactQueue(msg.from, () =>
    handleResolvedText(msg.from, text, msg.isAudio, msg.quotedText)
  );
}

/**
 * Processa um texto já resolvido (transcrito/extraído e, quando aplicável,
 * agrupado pela rajada): modo foco → roteamento pelo agente → resposta.
 */
async function handleResolvedText(
  from: string,
  text: string,
  isAudio: boolean,
  quotedText?: string
): Promise<void> {
  // Pausa das proativas ("segura tudo aí" / "pode voltar"). Vem ANTES do foco
  // de propósito: são coisas diferentes (a pausa barra o que o agente ENVIA
  // sozinho, o foco barra o que CHEGA), e quem está em foco precisa conseguir
  // pausar do mesmo jeito. Falha aqui não pode derrubar o atendimento.
  try {
    if (isResumeRequest(text)) {
      const reply = await leavePause(from);
      await sendText(from, reply, 800);
      return;
    }
    if (isPauseRequest(text)) {
      const reply = await enterPause(from, text);
      await sendText(from, reply, 800);
      return;
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[webhook] erro na pausa (seguindo fluxo normal):', errMsg);
    recordError(`Erro na pausa: ${errMsg}`);
  }

  // F3: modo foco. Pedido de foco entra direto; pedido de SAIR encerra; durante
  // o foco, mensagens não urgentes são seguradas com um aviso curto. Comandos
  // administrativos ("/...") e mensagens urgentes NUNCA são bloqueados — o
  // usuário precisa poder se administrar mesmo em foco.
  try {
    if (isCancelFocusRequest(text)) {
      const reply = await cancelFocus(from);
      await sendText(from, reply, 800);
      return;
    }
    if (isFocusRequest(text)) {
      const reply = await enterFocus(from, text);
      await sendText(from, reply, 800);
      return;
    }
    const isCommand = text.trim().startsWith('/');
    if (!isCommand) {
      const gate = await focusGate(from, text);
      if (gate.active && gate.reply) {
        await sendText(from, gate.reply, 800);
        return;
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[webhook] erro no modo foco (seguindo fluxo normal):', errMsg);
    recordError(`Erro no modo foco: ${errMsg}`);
  }

  // Pedido pontual de resposta em áudio (ex: "responde em áudio"). One-shot:
  // vale só para esta mensagem; o padrão volta a ser texto na próxima.
  const audioRequested = wantsAudioReply(text);

  // Roteia pelo agente central e responde
  try {
    const { reply } = await handleMessage(from, text, isAudio, quotedText);
    if (!reply) return;
    // Uma mensagem no caso normal; várias quando a resposta é uma listagem que
    // não cabe no limite — assim nenhum item chega cortado pela metade.
    const parts = splitWhatsAppReply(reply);

    // Por padrão respondemos em TEXTO, inclusive para mensagens de áudio (que
    // são transcritas na entrada). Só geramos áudio (TTS) quando o usuário pediu
    // explicitamente nesta mensagem; nesse caso o texto vai junto como registro.
    if (audioRequested) {
      try {
        const audioBase64 = await textToSpeechBase64(parts.join('\n'));
        await sendAudio(from, audioBase64);
      } catch (ttsErr) {
        console.error('[webhook] TTS falhou, enviando só texto:', ttsErr);
      }
    }
    // Texto com pequeno "delay" para exibir "digitando..." de forma natural. Os
    // blocos seguintes usam delay curto: já está claro que é a mesma resposta.
    for (let i = 0; i < parts.length; i += 1) {
      await sendText(from, parts[i], i === 0 ? 1200 : 400);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[webhook] falha ao gerar/enviar resposta:', errMsg);
    recordError(`Falha ao gerar/enviar resposta: ${errMsg}`, 'Orquestrador Geral');
    await sendText(from, 'Ops, algo deu errado aqui. Tenta de novo em instantes? 🙏');
  }
}

async function bootstrap(): Promise<void> {
  // Garante os subagentes padrão no primeiro boot
  await seedDefaultSubagents(DEFAULT_SUBAGENTS);

  // Garante o subagente orquestrador mesmo em bancos já populados (idempotente).
  await ensureSubagent(ORCHESTRATOR_SUBAGENT);

  // Carrega as configurações de proatividade do painel (Firestore) para o
  // overlay em runtime. Sem isso, urgentKeywords/carga/flags caem nos defaults.
  await loadSettings();

  // Inicia jobs proativos (cronograma do dia, lembretes, transições).
  // Em dev local, defina DISABLE_SCHEDULER=1 para não disparar mensagens reais.
  if (process.env.DISABLE_SCHEDULER === '1') {
    console.log('⏸️  Scheduler desativado (DISABLE_SCHEDULER=1)');
  } else {
    startScheduler();
  }

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
