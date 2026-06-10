import cron from 'node-cron';
import { config } from './config';
import { sendText, ensureConnected } from './services/evolution';
import { getDueTasks, markReminderSent, updateTask } from './services/firebase';
import { nextOccurrence } from './services/datetime';
import { sendDailySchedule, processTimeBasedTransitions } from './agents/orchestrator';
import { processFocusExpirations } from './agents/focus';
import {
  sendNightlySummary,
  sendWeeklyReview,
  runProactiveCheck,
  sendSubagentWeeklyReports,
  sendPendingFollowUp,
} from './agents/reports';

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

  // Bom dia + cronograma do dia — todo dia às 07:00.
  // O orquestrador gera a agenda a partir das tarefas pendentes e envia ao dono.
  cron.schedule(
    '0 7 * * *',
    async () => {
      try {
        await sendDailySchedule();
        console.log('[scheduler] cronograma do dia enviado.');
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
      sendPendingFollowUp().catch((err) =>
        console.error('[scheduler] falha no follow-up de pendências:', err)
      );
    },
    opts
  );

  // F1: resumo diário noturno — todo dia às 22:00.
  cron.schedule(
    '0 22 * * *',
    () => {
      sendNightlySummary().catch((err) =>
        console.error('[scheduler] falha no resumo noturno:', err)
      );
    },
    opts
  );

  // F2: revisão semanal — toda sexta-feira às 18:00.
  cron.schedule(
    '0 18 * * 5',
    () => {
      sendWeeklyReview().catch((err) =>
        console.error('[scheduler] falha na revisão semanal:', err)
      );
    },
    opts
  );

  // F9: relatório por subagente — toda segunda-feira às 08:00.
  cron.schedule(
    '0 8 * * 1',
    () => {
      sendSubagentWeeklyReports().catch((err) =>
        console.error('[scheduler] falha nos relatórios por subagente:', err)
      );
    },
    opts
  );

  // F7: proatividade dos subagentes — uma vez por dia, às 09:30.
  cron.schedule(
    '30 9 * * *',
    () => {
      runProactiveCheck().catch((err) =>
        console.error('[scheduler] falha na verificação proativa:', err)
      );
    },
    opts
  );

  // Lembretes/tarefas — a cada minuto
  cron.schedule(
    '* * * * *',
    async () => {
      try {
        const due = await getDueTasks();
        for (const task of due) {
          await sendText(task.to || config.ownerPhone, `⏰ Lembrete: ${task.text}`);
          if (task.recurrence) {
            // Recorrente: reagenda para a próxima ocorrência em vez de morrer.
            const next = nextOccurrence(task.remindAt, task.recurrence);
            await updateTask(task.id, { remindAt: next });
            console.log(`[scheduler] lembrete recorrente reagendado: ${task.id} → ${next}`);
          } else {
            await markReminderSent(task.id);
            console.log(`[scheduler] lembrete enviado: ${task.id}`);
          }
        }
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
