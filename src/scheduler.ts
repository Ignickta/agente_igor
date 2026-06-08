import cron from 'node-cron';
import { config } from './config';
import { sendText } from './services/evolution';
import { getDueTasks, markTaskDone } from './services/firebase';

/**
 * Inicia os jobs proativos:
 *  - Bom dia diário para o dono.
 *  - Verificação de lembretes/tarefas a cada minuto.
 */
export function startScheduler(): void {
  if (!config.ownerPhone) {
    console.warn('[scheduler] OWNER_PHONE não definido — mensagens proativas desativadas.');
    return;
  }

  const opts = { timezone: config.timezone };

  // Bom dia — todo dia às 07:00
  cron.schedule(
    '0 7 * * *',
    async () => {
      try {
        await sendText(
          config.ownerPhone,
          'Bom dia, Igor! ☀️ Qual o foco de hoje? Posso te ajudar com odonto, arroz, automação, estudos ou o blog.'
        );
        console.log('[scheduler] mensagem de bom dia enviada.');
      } catch (err) {
        console.error('[scheduler] falha ao enviar bom dia:', err);
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
    },
    opts
  );

  console.log(`[scheduler] iniciado (timezone: ${config.timezone}).`);
}
