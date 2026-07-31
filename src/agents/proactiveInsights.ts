import { config } from '../config';
import { Task } from '../types';
import { getPendingTasks } from '../services/firebase';
import { effectiveSettings } from '../services/settings';
import { sendText } from '../services/evolution';
import { dayKey } from '../services/datetime';
import { PROCRASTINATION_THRESHOLD } from './orchestrator';
import { proactiveMuted } from './pause';

/**
 * Proatividade ESPERTA: avisos derivados de sinais que o sistema já coleta
 * (postponedCount, estimatedMinutes, createdAt) mas que a proatividade genérica
 * não usava. São três detectores puros (fáceis de testar) + um montador de
 * mensagem. Tudo "avisa/sugere", nunca promete ação — quem decide é o Igor.
 */

/** Dias sem conclusão para uma tarefa pendente contar como "esquecida". */
const STALE_DAYS = parseInt(process.env.STALE_TASK_DAYS || '7', 10);

/** Acima desta % do tempo útil do dia, o dia está sobrecarregado. */
const OVERLOAD_RATIO = parseFloat(process.env.OVERLOAD_RATIO || '1.0');

export interface ProactiveInsights {
  /** Tarefas adiadas vezes demais (procrastinação). */
  procrastinated: Task[];
  /** Tarefas pendentes paradas há muito tempo, sem adiamento explícito. */
  forgotten: Task[];
  /** Sobrecarga do dia: minutos estimados das tarefas de hoje vs. limite. */
  overload: { scheduledMinutes: number; limitMinutes: number; todayTasks: Task[] } | null;
}

/**
 * Tarefas adiadas N+ vezes. `postponedCount` já é incrementado quando o Igor
 * empurra um lembrete para mais tarde (orchestrator/editar_lembrete).
 */
export function detectProcrastinated(
  tasks: Task[],
  threshold = PROCRASTINATION_THRESHOLD
): Task[] {
  return tasks
    .filter((t) => !t.done && (t.postponedCount ?? 0) >= threshold)
    .sort((a, b) => (b.postponedCount ?? 0) - (a.postponedCount ?? 0));
}

/**
 * Tarefas pendentes "esquecidas": criadas há mais de STALE_DAYS, com horário de
 * lembrete já vencido, e SEM adiamento explícito (adiar é decisão consciente; o
 * que queremos resgatar é o que foi abandonado em silêncio).
 */
export function detectForgotten(tasks: Task[], now = Date.now(), staleDays = STALE_DAYS): Task[] {
  const cutoff = now - staleDays * 24 * 60 * 60 * 1000;
  const nowIso = new Date(now).toISOString();
  return tasks
    .filter(
      (t) =>
        !t.done &&
        !t.postponedCount &&
        t.createdAt < cutoff &&
        t.remindAt < nowIso
    )
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Sobrecarga do dia: soma os minutos estimados das tarefas que vencem HOJE e
 * compara com o limite diário. Retorna null se não há estimativas ou se está
 * dentro do limite (nada a avisar).
 */
export function detectOverload(
  tasks: Task[],
  limitMinutes: number,
  now = Date.now()
): ProactiveInsights['overload'] {
  const today = dayKey(new Date(now));
  const todayTasks = tasks.filter(
    (t) => !t.done && dayKey(new Date(t.remindAt)) === today
  );
  const scheduledMinutes = todayTasks.reduce((sum, t) => sum + (t.estimatedMinutes ?? 0), 0);
  if (scheduledMinutes <= limitMinutes * OVERLOAD_RATIO) return null;
  return { scheduledMinutes, limitMinutes, todayTasks };
}

/** Reúne os três sinais a partir das tarefas pendentes e das configurações. */
export async function gatherInsights(now = Date.now()): Promise<ProactiveInsights> {
  const pending = await getPendingTasks();
  const limit = effectiveSettings().maxDailyWorkMinutes;
  return {
    procrastinated: detectProcrastinated(pending),
    forgotten: detectForgotten(pending, now),
    overload: detectOverload(pending, limit, now),
  };
}

const fmtH = (min: number): string => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h${m ? m + 'min' : ''}` : `${m}min`;
};

/**
 * Monta a(s) mensagem(ns) de WhatsApp a partir dos insights. Direto e
 * consultivo: aponta o problema e oferece uma saída concreta, sem prometer
 * ação. Retorna [] quando não há nada que valha interromper o Igor.
 */
export function buildInsightMessages(insights: ProactiveInsights): string[] {
  const msgs: string[] = [];

  // Sobrecarga: o aviso mais urgente (afeta o dia inteiro) — vem primeiro.
  if (insights.overload) {
    const { scheduledMinutes, limitMinutes } = insights.overload;
    msgs.push(
      `⚠️ Seu dia está apertado: ${fmtH(scheduledMinutes)} de tarefa estimada para ${fmtH(
        limitMinutes
      )} úteis. Algo precisa sair ou ser adiado — quer que eu sugira o que cortar?`
    );
  }

  if (insights.procrastinated.length) {
    const t = insights.procrastinated[0];
    const n = t.postponedCount ?? 0;
    const extra =
      insights.procrastinated.length > 1
        ? ` (e mais ${insights.procrastinated.length - 1} na mesma situação)`
        : '';
    msgs.push(
      `🔁 "${t.text}" já foi adiada ${n}x${extra}. Quando algo trava tanto, costuma ser sinal de que ` +
        `está grande ou sem clareza. Quer quebrar em um primeiro passo de 15 min, delegar, ou tirar da lista?`
    );
  }

  if (insights.forgotten.length) {
    const t = insights.forgotten[0];
    const dias = Math.floor((Date.now() - t.createdAt) / (24 * 60 * 60 * 1000));
    const extra =
      insights.forgotten.length > 1 ? ` Há outras ${insights.forgotten.length - 1} paradas também.` : '';
    msgs.push(
      `🕸️ "${t.text}" está parada há ${dias} dias sem você mexer.${extra} Ainda faz sentido? ` +
        `Se sim, bora marcar um horário; se não, melhor descartar do que deixar pesando na lista.`
    );
  }

  return msgs;
}

/**
 * Job proativo: junta os sinais e envia os avisos espertos ao Igor. Best-effort
 * e silencioso quando não há nada — melhor não interromper do que enviar ruído.
 * Respeita as flags de notificação (config.proactiveNotifications + ownerPhone).
 */
export async function runSmartProactiveCheck(): Promise<void> {
  if (!config.proactiveNotifications || !config.ownerPhone) return;
  if (await proactiveMuted(config.ownerPhone)) return;
  const insights = await gatherInsights();
  const messages = buildInsightMessages(insights);
  for (const msg of messages) {
    await sendText(config.ownerPhone, msg);
  }
  if (messages.length) {
    console.log(`[proactiveInsights] ${messages.length} aviso(s) enviado(s).`);
  }
}
