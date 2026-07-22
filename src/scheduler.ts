import cron from 'node-cron';
import { config } from './config';
import { sendText, ensureConnected } from './services/evolution';
import {
  getDueTasks,
  claimDueTask,
  getFiredUnconfirmed,
  updateTask,
  acquireJobLock,
  cleanupJobLocks,
} from './services/firebase';
import { dayKey, timeKey, addDays } from './services/datetime';
import {
  sendDailySchedule,
  processTimeBasedTransitions,
  rollOverPendingTasks,
} from './agents/orchestrator';
import { Task } from './types';
import { processFocusExpirations } from './agents/focus';
import {
  sendNightlySummary,
  sendWeeklyReview,
  runProactiveCheck,
  sendSubagentWeeklyReports,
  sendPendingFollowUp,
} from './agents/reports';
import { runMemoryMaintenance, bootstrapProfile } from './agents/maintenance';
import { runSmartProactiveCheck } from './agents/proactiveInsights';
import { sendRouteLearningReport } from './agents/routeLearning';
import { syncCalendarRange } from './agents/calendarSync';
import { calendarEnabled } from './services/googleCalendar';

/**
 * Executa `fn` somente se esta instância vencer a trava distribuída do job no
 * período — proteção contra mensagens duplicadas quando há mais de uma
 * instância do app rodando contra o mesmo Firestore (ex: container antigo que
 * não morreu no deploy).
 */
async function withJobLock(job: string, periodKey: string, fn: () => Promise<void>): Promise<void> {
  if (!(await acquireJobLock(job, periodKey))) {
    console.log(`[scheduler] job "${job}" (${periodKey}) já executado por outra instância — pulando.`);
    return;
  }
  await fn();
}

// ===================== Fila sequencial de lembretes =====================

/**
 * Turno do dia (no fuso do usuário) para um instante em epoch ms. Madrugada
 * (23h–6h) devolve null: a fila não cobra ninguém nesse horário.
 */
function turnoOf(ms: number): 'manhã' | 'tarde' | 'noite' | null {
  const h = parseInt(timeKey(new Date(ms)).slice(0, 2), 10);
  if (h < 6) return null;
  if (h < 12) return 'manhã';
  if (h < 18) return 'tarde';
  if (h < 23) return 'noite';
  return null;
}

/** Instrução padrão de resposta que acompanha toda cobrança de lembrete. */
function replyHint(text: string): string {
  return `Responda com: *feito*, *adiar 1h*, *amanhã* ou *apagar ${text}*.`;
}

/** Sufixo "o que está esperando na fila", quando houver. */
function queueSuffix(held: Task[]): string {
  if (held.length === 0) return '';
  const linhas = held.map((t, i) => `${i + 1}. _${t.text}_`).join('\n');
  return `\n\n📋 Na fila esperando você confirmar:\n${linhas}`;
}

/**
 * Re-cobra o lembrete ativo (disparado e sem confirmação) no máximo UMA vez por
 * turno (manhã/tarde/noite). Marca `lastNudgeAt` antes de enviar para nunca
 * repetir a cobrança em loop se o envio falhar no meio.
 */
async function maybeNudgeActive(active: Task, held: Task[]): Promise<void> {
  const now = Date.now();
  const turnoAtual = turnoOf(now);
  if (!turnoAtual) return; // madrugada: silêncio
  const last = active.lastNudgeAt ?? active.firedAt ?? new Date(active.remindAt).getTime();
  const mesmoTurno = dayKey(new Date(last)) === dayKey() && turnoOf(last) === turnoAtual;
  if (mesmoTurno) return; // já cobramos neste turno
  await updateTask(active.id, { lastNudgeAt: now });
  await sendText(
    active.to || config.ownerPhone,
    `⏰ Ainda pendente: *${active.text}*\n\nConseguiu fazer? ${replyHint(active.text)}` +
      queueSuffix(held)
  );
  console.log(`[scheduler] re-cobrança de turno enviada: ${active.id}`);
}

/**
 * Fila SEQUENCIAL de lembretes, por contato — mas o PRIMEIRO disparo de um
 * lembrete no seu horário NUNCA é segurado.
 *
 * Um lembrete que o Igor agendou com hora marcada (as 20:00) é um compromisso,
 * não spam: quando dá a hora, ele TOCA — mesmo que outro lembrete já disparado
 * ainda esteja sem confirmação. O que a fila segura é só a RE-cobrança
 * ("ainda pendente: X"), limitada a uma vez por turno, para não metralhar.
 *
 * Ordem por contato a cada tick:
 *  1) Se há lembrete vencido que ainda não disparou (`due`), dispara o mais
 *     próximo do horário. É o compromisso do usuário — tem prioridade.
 *  2) Só quando não há nada novo a disparar, re-cobra o lembrete ativo (o mais
 *     antigo disparado e sem confirmação), no máximo uma vez por turno.
 */
async function processReminderQueue(): Promise<void> {
  const [due, blockers] = await Promise.all([getDueTasks(), getFiredUnconfirmed(dayKey())]);
  if (due.length === 0 && blockers.length === 0) return;

  const owner = config.ownerPhone;
  const contactOf = (t: Task) => t.to || owner;
  const contacts = new Set([...due, ...blockers].map(contactOf));

  for (const contact of contacts) {
    const myDue = due.filter((t) => contactOf(t) === contact);
    myDue.sort((a, b) => a.remindAt.localeCompare(b.remindAt));
    const myBlockers = blockers.filter((t) => contactOf(t) === contact);

    const next = myDue[0];
    if (next) {
      // PRIMEIRO disparo do lembrete no horário: sempre acontece. Reivindica
      // ANTES de enviar (marca como enviado, ou reagenda se recorrente) de
      // forma atômica — se outra instância chegou primeiro, não envia; é isso
      // que evita o lembrete em dobro. Os já-disparados sem confirmação (e os
      // demais vencidos) aparecem como "na fila", sem nova mensagem própria.
      if (!(await claimDueTask(next))) continue;
      await sendText(
        contact,
        `⏰ Lembrete: ${next.text}\n\n${replyHint(next.text)}` +
          queueSuffix([...myDue.slice(1), ...myBlockers])
      );
      console.log(
        `[scheduler] lembrete enviado: ${next.id}${next.recurrence ? ' (recorrente, reagendado)' : ''}` +
          (myDue.length + myBlockers.length > 1
            ? ` — ${myDue.length + myBlockers.length - 1} na fila aguardando confirmação`
            : '')
      );
      continue;
    }

    // Nada novo para tocar: só então re-cobra o ativo (uma vez por turno).
    if (myBlockers.length > 0) {
      const [active, ...restBlockers] = myBlockers;
      await maybeNudgeActive(active, restBlockers);
    }
  }
}

/**
 * Inicia os jobs proativos:
 *  - Reconexão automática da instância Evolution a cada 5 minutos.
 *  - Bom dia diário para o dono.
 *  - Verificação de lembretes/tarefas a cada minuto.
 */
export function startScheduler(): void {
  const opts = { timezone: config.timezone };

  // Reconexão automática — a cada 5 minutos (independe de OWNER_PHONE).
  cron.schedule(
    '*/5 * * * *',
    () => {
      ensureConnected().catch((err) =>
        console.error('[scheduler] erro na verificação de conexão:', err)
      );
    },
    opts
  );
  // Roda uma vez no boot também, sem esperar 5 minutos.
  ensureConnected().catch((err) =>
    console.error('[scheduler] erro na verificação inicial de conexão:', err)
  );

  if (!config.ownerPhone) {
    console.warn('[scheduler] OWNER_PHONE não definido — mensagens proativas desativadas.');
    console.log('[scheduler] reconexão automática ativa (a cada 5 min).');
    return;
  }

  // Manutenção da memória — todo dia às 03:30 (madrugada, sem mensagens):
  // consolida fatos (duplicados, correções, expirados) e reconstrói o perfil
  // vivo do Igor que entra no system prompt de todos os subagentes.
  cron.schedule(
    '30 3 * * *',
    () => {
      withJobLock('memory_maintenance', dayKey(), runMemoryMaintenance).catch((err) =>
        console.error('[scheduler] falha na manutenção da memória:', err)
      );
    },
    opts
  );

  // Primeiro perfil: se o dono ainda não tem um, gera no boot sem esperar as
  // 03:30. Checa a existência antes de gastar LLM — re-deploys não custam nada.
  bootstrapProfile().catch((err) =>
    console.error('[scheduler] falha no bootstrap do perfil:', err)
  );

  // F10: sync com o Google Calendar a cada 30 min (hoje + amanhã) — pega
  // eventos criados/movidos direto no celular entre os horários dos outros
  // jobs. Uma listagem por execução; só agendado com GOOGLE_CALENDAR_ID.
  if (calendarEnabled()) {
    cron.schedule(
      '*/30 * * * *',
      () => {
        const periodKey = `${dayKey()}T${timeKey()}`;
        withJobLock('gcal_sync', periodKey, () =>
          syncCalendarRange(dayKey(), addDays(dayKey(), 1))
        ).catch((err) => console.error('[scheduler] falha no sync do calendário:', err));
      },
      opts
    );
    // Uma vez no boot também, para a agenda já acordar espelhada. Com trava
    // em janela de 10 min: num deploy, o container velho e o novo não rodam
    // a reconciliação ao mesmo tempo (criaria espelhos duplicados).
    const bootKey = `${dayKey()}T${timeKey().slice(0, 4)}0`;
    withJobLock('gcal_sync_boot', bootKey, () =>
      syncCalendarRange(dayKey(), addDays(dayKey(), 7))
    ).catch((err) => console.error('[scheduler] falha no sync inicial do calendário:', err));
  }

  // Bom dia + cronograma do dia — todo dia às 07:00.
  // O orquestrador gera a agenda a partir das tarefas pendentes e envia ao dono.
  cron.schedule(
    '0 7 * * *',
    async () => {
      try {
        await withJobLock('daily_schedule', dayKey(), async () => {
          // O que ficou de ontem sem confirmação rola para hoje ANTES de gerar
          // o cronograma — assim os blocos do dia já nascem com as pendências.
          await rollOverPendingTasks();
          await sendDailySchedule();
          console.log('[scheduler] cronograma do dia enviado.');
        });
      } catch (err) {
        console.error('[scheduler] falha ao enviar cronograma do dia:', err);
      }
    },
    opts
  );

  // Follow-up de pendências — todo dia às 20:30 (antes do resumo noturno):
  // cobra com gentileza os lembretes que tocaram e não foram confirmados.
  cron.schedule(
    '30 20 * * *',
    () => {
      withJobLock('pending_followup', dayKey(), sendPendingFollowUp).catch((err) =>
        console.error('[scheduler] falha no follow-up de pendências:', err)
      );
    },
    opts
  );

  // F1: resumo diário noturno — todo dia às 22:00.
  cron.schedule(
    '0 22 * * *',
    () => {
      withJobLock('nightly_summary', dayKey(), sendNightlySummary).catch((err) =>
        console.error('[scheduler] falha no resumo noturno:', err)
      );
      // Aproveita o job noturno para limpar travas antigas (best-effort).
      cleanupJobLocks().catch((err) =>
        console.error('[scheduler] falha na limpeza de travas:', err)
      );
    },
    opts
  );

  // F2: revisão semanal — toda sexta-feira às 18:00.
  cron.schedule(
    '0 18 * * 5',
    () => {
      withJobLock('weekly_review', dayKey(), sendWeeklyReview).catch((err) =>
        console.error('[scheduler] falha na revisão semanal:', err)
      );
    },
    opts
  );

  // Aprendizado de roteamento — todo domingo às 19:00: analisa as correções
  // da semana, separa rota errada de correção de conteúdo e sugere keywords
  // (aplicação só com confirmação do Igor). Silencioso quando não há nada.
  cron.schedule(
    '0 19 * * 0',
    () => {
      withJobLock('route_learning', dayKey(), sendRouteLearningReport).catch((err) =>
        console.error('[scheduler] falha no aprendizado de roteamento:', err)
      );
    },
    opts
  );

  // F9: relatório por subagente — toda segunda-feira às 08:00.
  cron.schedule(
    '0 8 * * 1',
    () => {
      withJobLock('subagent_reports', dayKey(), sendSubagentWeeklyReports).catch((err) =>
        console.error('[scheduler] falha nos relatórios por subagente:', err)
      );
    },
    opts
  );

  // Proatividade ESPERTA — uma vez por dia, às 08:00 (cedo: a sobrecarga do dia
  // precisa avisar ANTES de o dia começar). Procrastinação, sobrecarga e tarefas
  // esquecidas, derivadas de sinais já coletados (postponedCount, estimativas).
  cron.schedule(
    '0 8 * * *',
    () => {
      withJobLock('smart_proactive', dayKey(), runSmartProactiveCheck).catch((err) =>
        console.error('[scheduler] falha na proatividade esperta:', err)
      );
    },
    opts
  );

  // F7: proatividade dos subagentes — uma vez por dia, às 09:30.
  cron.schedule(
    '30 9 * * *',
    () => {
      withJobLock('proactive_check', dayKey(), runProactiveCheck).catch((err) =>
        console.error('[scheduler] falha na verificação proativa:', err)
      );
    },
    opts
  );

  // Lembretes/tarefas — a cada minuto. A trava por minuto garante que só uma
  // instância processe o tick (lembretes, transições e fim de foco enviam
  // mensagens); o claim por tarefa é a segunda camada contra duplicatas.
  cron.schedule(
    '* * * * *',
    async () => {
      const minuteKey = `${dayKey()}T${timeKey()}`;
      if (!(await acquireJobLock('minute_tick', minuteKey))) return;

      try {
        await processReminderQueue();
      } catch (err) {
        console.error('[scheduler] falha ao processar lembretes:', err);
      }

      // Transições da agenda por horário (modo horário do híbrido): avança itens
      // cujo endTime já passou e avisa a próxima tarefa.
      try {
        await processTimeBasedTransitions();
      } catch (err) {
        console.error('[scheduler] falha nas transições da agenda:', err);
      }

      // F3: encerra sessões de modo foco expiradas e avisa o usuário.
      try {
        await processFocusExpirations();
      } catch (err) {
        console.error('[scheduler] falha ao processar fim de foco:', err);
      }
    },
    opts
  );

  console.log(
    `[scheduler] iniciado (timezone: ${config.timezone}) — reconexão automática a cada 5 min.`
  );
}
