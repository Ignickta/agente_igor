import cron from 'node-cron';
import { config } from './config';
import { sendText, ensureConnected } from './services/evolution';
import { getDueTasks, markTaskDone } from './services/firebase';
import { sendDailySchedule, processTimeBasedTransitions } from './agents/orchestrator';

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

  // Lembretes/tarefas — a cada minuto
  cron.schedule(
    '* * * * *',
    async () => {
      try {
        const due = await getDueTasks();
        for (const task of due) {
          await sendText(task.to || config.ownerPhone, `⏰ Lembrete: ${task.text}`);
          await markTaskDone(task.id);
          console.log(`[scheduler] lembrete enviado: ${task.id}`);
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
    },
    opts
  );

  console.log(
    `[scheduler] iniciado (timezone: ${config.timezone}) — reconexão automática a cada 5 min.`
  );
}
