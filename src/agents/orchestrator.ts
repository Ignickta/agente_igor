import { config } from '../config';
import { chat, chatJson, ChatMessage } from '../services/openai';
import { sendText } from '../services/evolution';
import {
  listTasks,
  taskHasReminder,
  listSubagents,
  getAgendaForDay,
  getAgendaInRange,
  createAgendaItem,
  updateAgendaItem,
  getCompletedTasksBetween,
  markTaskDone,
  getTask,
  updateTask,
} from '../services/firebase';
import { AgendaItem, PendingPromptTarget, Task } from '../types';
import { estimateDurationMinutes } from './estimate';
import { rememberAsk, isNudgeSuspended } from './pendingPrompt';
import { calibrationSummary } from './estimate';
import { syncCalendarRange } from './calendarSync';
import {
  dayKey,
  timeKey,
  addDays,
  weekdayOf,
  nextOccurrence,
  dateLabelPt,
} from '../services/datetime';
import { getMaxDailyWorkMinutes, isNotificationEnabled } from '../services/settings';
import { proactiveMuted } from './pause';

// Reexporta para callers que já importavam dayKey/etc. do orchestrator.
export { dayKey, addDays, weekdayOf };

/** Intervalo [segunda, domingo] da semana que contém `ref` (padrão: hoje). */
export function weekRange(ref = dayKey()): { start: string; end: string } {
  const wd = weekdayOf(ref); // 0=dom..6=sáb
  const offsetToMonday = (wd + 6) % 7; // segunda como início
  const start = addDays(ref, -offsetToMonday);
  return { start, end: addDays(start, 6) };
}

/** Intervalo [dia 1, último dia] do mês que contém `ref` (padrão: hoje). */
export function monthRange(ref = dayKey()): { start: string; end: string } {
  const start = `${ref.slice(0, 7)}-01`;
  const d = new Date(`${start}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1); // 1º do mês seguinte
  d.setUTCDate(0); // volta para o último dia do mês de `ref`
  return { start, end: d.toISOString().slice(0, 10) };
}

const WEEKDAY_PT = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** Rótulo "seg, 09/06" para uma data YYYY-MM-DD. */
function dayLabel(dateKey: string): string {
  const wd = WEEKDAY_PT[weekdayOf(dateKey)].slice(0, 3);
  const [, m, d] = dateKey.split('-');
  return `${wd}, ${d}/${m}`;
}

const PRIORITY_EMOJI: Record<number, string> = {
  1: '🔴',
  2: '🟠',
  3: '🟡',
  4: '🟢',
  5: '🔵',
};

const TYPE_EMOJI: Record<AgendaItem['type'], string> = {
  task: '✅',
  event: '📅',
  research: '🔎',
};

// ===================== Geração do cronograma =====================

// ===================== F10: aprendizado de padrões =====================

/**
 * Analisa o histórico das últimas semanas de tarefas concluídas e detecta
 * padrões do usuário (horários mais produtivos, tipos que costumam atrasar).
 * Retorna um texto curto para injetar no prompt de geração — ou '' se não houver
 * histórico suficiente. Best-effort: nunca lança.
 */
export async function learnUserPatterns(days = 28): Promise<string> {
  try {
    const end = Date.now();
    const start = end - days * 86400000;
    const completed = await getCompletedTasksBetween(start, end);
    if (completed.length < 4) return ''; // amostra pequena demais

    // Distribuição de conclusões por faixa horária local.
    const buckets: Record<string, number> = { manhã: 0, tarde: 0, noite: 0, madrugada: 0 };
    let atrasadas = 0;
    for (const t of completed) {
      const hourStr = new Intl.DateTimeFormat('en-GB', {
        timeZone: config.timezone,
        hour: '2-digit',
        hour12: false,
      }).format(new Date(t.completedAt!));
      const h = parseInt(hourStr, 10);
      if (h >= 5 && h < 12) buckets['manhã']++;
      else if (h >= 12 && h < 18) buckets['tarde']++;
      else if (h >= 18 && h < 24) buckets['noite']++;
      else buckets['madrugada']++;
      // "Atrasada": concluída depois do horário que era para lembrar.
      if (t.completedAt! > new Date(t.remindAt).getTime() + 3600000) atrasadas++;
    }
    const topBucket = Object.entries(buckets).sort((a, b) => b[1] - a[1])[0];
    const taxaAtraso = Math.round((atrasadas / completed.length) * 100);

    const linhas = [
      `- Período mais produtivo (mais conclusões): ${topBucket[0]}.`,
      `- Taxa de tarefas concluídas com atraso: ${taxaAtraso}% (de ${completed.length} tarefas).`,
    ];
    // F7: calibração real×estimado — quando há medições, o cronograma passa a
    // dimensionar blocos pelo ritmo REAL do Igor, não pela estimativa crua.
    const calib = await calibrationSummary();
    if (calib) linhas.push(calib);
    return linhas.join('\n');
  } catch (err) {
    console.error('[orchestrator] falha ao aprender padrões:', err instanceof Error ? err.message : err);
    return '';
  }
}

/** Janela de almoço padrão reservada no planejamento do dia. */
export const DEFAULT_LUNCH_START = process.env.LUNCH_START || '12:00';
export const DEFAULT_LUNCH_END = process.env.LUNCH_END || '13:00';

/** Tarefa que o planejador não conseguiu encaixar, e por quê. */
export interface SkippedTask {
  id: string;
  title: string;
  minutes: number;
  /** 'limite' = estourou o teto de carga do dia; 'expediente' = passou do fim útil. */
  reason: 'limite' | 'expediente';
}

/**
 * Resultado do planejamento. `skipped` existe para o descarte nunca ser
 * silencioso: sem ele, a agenda simplesmente acabava cedo e as tarefas que não
 * couberam sumiam sem aviso.
 */
export interface ScheduleResult {
  items: AgendaItem[];
  skipped: SkippedTask[];
}

/**
 * Gera o cronograma do dia a partir das `tasks` pendentes de hoje + itens já na
 * `agenda`, com prioridade calculada pelo agente.
 *
 * Itens fixos do usuário (priority 1) entram como restrição imutável no prompt;
 * o modelo encaixa os demais (priority 2–5) em volta. INCREMENTAL: chamadas
 * repetidas no mesmo dia encaixam apenas as tarefas que ainda não viraram bloco
 * (antes, uma vez gerado, tarefas novas nunca entravam e o "gera de novo"
 * devolvia o cronograma velho como se fosse novo).
 */
export async function generateDailySchedule(
  date = dayKey(),
  force = false,
  opts: {
    startTime?: string;
    endTime?: string;
    maxMinutes?: number;
    /** Janela de almoço reservada (HH:mm). Vazio desliga a reserva. */
    lunchStart?: string;
    lunchEnd?: string;
    taskIds?: string[];
    tasks?: { id: string; priority?: number; estimatedMinutes?: number }[];
  } = {}
): Promise<ScheduleResult> {
  // F10: traz os eventos do Google Calendar ANTES de planejar — eles entram
  // como itens fixos e o modelo encaixa as tarefas em volta. Best-effort.
  await syncCalendarRange(date, date);

  const existing = await getAgendaForDay(date);

  // Seleção do Igor: quando `taskIds` vem preenchido, só ESSAS tarefas viram
  // bloco (o "escolho tudo ou só alguns"). Sem lista = comportamento antigo:
  // todas as pendentes do dia. Uma lista vazia também cai no "todas" (o front
  // manda undefined quando quer tudo).
  const taskPlans = new Map((opts.tasks || []).map((task) => [task.id, task]));
  const selectedIds = opts.tasks?.length ? opts.tasks.map((task) => task.id) : opts.taskIds;
  const selected = selectedIds && selectedIds.length > 0 ? new Set(selectedIds) : null;

  // Tarefas pendentes cujo lembrete cai no dia alvo (data LOCAL: remindAt é
  // ISO UTC, e cortar a string colocaria lembretes após as 21h no dia seguinte).
  const allDayTasks = (await listTasks()).filter((t) => {
    if (t.done || (selected && !selected.has(t.id))) return false;
    // O planejador explícito pode escolher qualquer tarefa pendente, inclusive
    // as sem prazo. O fluxo legado continua limitado às tarefas do dia.
    return taskPlans.size > 0 || dayKey(new Date(t.remindAt)) === date;
  });

  // Só encaixa o que ainda NÃO está representado na agenda (por taskId ou
  // título igual) — é isso que torna a geração incremental e idempotente.
  const normTitle = (s: string) => s.trim().toLowerCase();
  const linkedTaskIds = new Set(existing.map((i) => i.taskId).filter(Boolean));
  const existingTitleSet = new Set(existing.map((i) => normTitle(i.title)));
  const pendingForDay = allDayTasks.filter(
    (t) => !linkedTaskIds.has(t.id) && !existingTitleSet.has(normTitle(t.text))
  );

  // O horário do lembrete (remindAt) é a hora que o Igor escolheu — não um mero
  // "prazo". Toda task pendente vira um bloco no PRÓPRIO horário do remindAt:
  // o LLM nunca a realoca. Antes, o orquestrador passava o remindAt como
  // "deadline" e o modelo encaixava a tarefa no primeiro bloco livre da manhã,
  // ignorando o horário pedido (ex: pedido p/ 15:00 caía em 08:00). Só as tasks
  // sem horário definido sobrariam para o LLM — mas hoje toda task tem hora, então
  // todas entram como bloco fixo aqui e o modelo só preenche eventuais lacunas.
  const fixedFromTasks: AgendaItem[] = [];

  // No planejador, prioridade/duração vêm da escolha do usuário e os horários
  // são calculados dentro do expediente, contornando blocos já existentes.
  if (taskPlans.size > 0) {
    const toMinutes = (time: string) => {
      const [hour, minute] = time.split(':').map(Number);
      return hour * 60 + minute;
    };
    const toTime = (minutes: number) =>
      `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const dayStart = toMinutes(opts.startTime || '08:00');
    const dayEnd = toMinutes(opts.endTime || '19:00');
    const maxMinutes = opts.maxMinutes || dayEnd - dayStart;
    const occupied = existing
      .filter((item) => item.status !== 'done')
      .map((item) => ({ start: toMinutes(item.startTime), end: toMinutes(item.endTime) }))
      .sort((a, b) => a.start - b.start);

    // Almoço entra como espaço ocupado, não como bloco na agenda: o dia não
    // deve ser planejado por cima dele, mas ele também não é uma tarefa a
    // confirmar. Passar vazio desliga a reserva.
    const lunchStart = opts.lunchStart ?? DEFAULT_LUNCH_START;
    const lunchEnd = opts.lunchEnd ?? DEFAULT_LUNCH_END;
    if (lunchStart && lunchEnd) {
      const ini = toMinutes(lunchStart);
      const fim = toMinutes(lunchEnd);
      if (Number.isFinite(ini) && Number.isFinite(fim) && fim > ini) {
        occupied.push({ start: ini, end: fim });
        occupied.sort((a, b) => a.start - b.start);
      }
    }
    // Tarefa com hora marcada não é realocada: o horário é escolha do Igor.
    // Ela vira bloco fixo e entra como espaço ocupado, para o encaixe das
    // demais desviar dela. Sem isso, um lembrete das 15h era jogado para as
    // 08:00 pelo planejador.
    const comHora = pendingForDay.filter(
      (t) => taskHasReminder(t) && dayKey(new Date(t.remindAt)) === date
    );
    for (const t of comHora) {
      const startTime = timeKey(new Date(t.remindAt));
      const dur = t.estimatedMinutes && t.estimatedMinutes > 0 ? t.estimatedMinutes : 45;
      const startMin = toMinutes(startTime);
      const item = await createAgendaItem({
        title: t.text,
        date,
        startTime,
        endTime: toTime(Math.min(24 * 60 - 1, startMin + dur)),
        priority: 1,
        type: 'task',
        createdBy: 'user',
        ...(t.estimatedMinutes ? { estimatedMinutes: t.estimatedMinutes } : {}),
        ...(t.subagentId ? { subagentId: t.subagentId } : {}),
        taskId: t.id,
      });
      fixedFromTasks.push(item);
      occupied.push({ start: startMin, end: startMin + dur });
    }
    occupied.sort((a, b) => a.start - b.start);

    const comHoraIds = new Set(comHora.map((t) => t.id));
    const sorted = [...pendingForDay].filter((t) => !comHoraIds.has(t.id)).sort((a, b) => {
      const pa = taskPlans.get(a.id)?.priority ?? 3;
      const pb = taskPlans.get(b.id)?.priority ?? 3;
      return pa - pb || a.createdAt - b.createdAt;
    });
    // Estimativas independentes são feitas em paralelo. Fazer uma chamada por
    // vez fazia planejamentos maiores ultrapassarem o timeout do painel.
    const aiEstimates = new Map<string, number | undefined>();
    await Promise.all(
      sorted.map(async (task) => {
        const manual = taskPlans.get(task.id)?.estimatedMinutes;
        if (manual && manual > 0) return;
        aiEstimates.set(
          task.id,
          task.estimatedMinutes || (await estimateDurationMinutes(task.text, 'task'))
        );
      })
    );
    let cursor = dayStart;
    let plannedMinutes = 0;
    const skipped: SkippedTask[] = [];
    // Prioridade a partir da qual o dia já está cheio. `sorted` vem em ordem de
    // prioridade, então continuar tentando aproveita o espaço que sobrou com
    // tarefas curtas — mas só as da MESMA faixa: sem isso, uma "baixa" de 20min
    // furava a fila de uma "alta" de 2h que acabara de ser descartada.
    let blockedPriority: number | null = null;

    for (const task of sorted) {
      const plan = taskPlans.get(task.id);
      const priority = plan?.priority ?? 3;
      // Zero/ausente significa "A definir (IA)". Reaproveita a estimativa já
      // calculada na criação da tarefa e, nas antigas, consulta o estimador.
      const aiEstimate = aiEstimates.get(task.id);
      const duration = Math.min(
        480,
        Math.max(15, plan?.estimatedMinutes && plan.estimatedMinutes > 0 ? plan.estimatedMinutes : aiEstimate || 45)
      );
      if (blockedPriority !== null && priority > blockedPriority) {
        skipped.push({ id: task.id, title: task.text, minutes: duration, reason: 'limite' });
        continue;
      }
      if (plannedMinutes + duration > maxMinutes) {
        blockedPriority = priority;
        skipped.push({ id: task.id, title: task.text, minutes: duration, reason: 'limite' });
        continue;
      }
      let start = cursor;
      for (const block of occupied) {
        if (start + duration <= block.start) break;
        if (start < block.end && start + duration > block.start) start = block.end;
      }
      if (start + duration > dayEnd) {
        blockedPriority = priority;
        skipped.push({ id: task.id, title: task.text, minutes: duration, reason: 'expediente' });
        continue;
      }
      const item = await createAgendaItem({
        title: task.text,
        date,
        startTime: toTime(start),
        endTime: toTime(start + duration),
        priority: Math.min(5, Math.max(2, plan?.priority || 3)),
        type: 'task',
        createdBy: 'agent',
        estimatedMinutes: duration,
        ...(task.subagentId ? { subagentId: task.subagentId } : {}),
        taskId: task.id,
      });
      fixedFromTasks.push(item);
      occupied.push({ start, end: start + duration });
      occupied.sort((a, b) => a.start - b.start);
      cursor = start + duration;
      plannedMinutes += duration;
    }
    return { items: await getAgendaForDay(date), skipped };
  }

  for (const t of pendingForDay) {
    const startTime = timeKey(new Date(t.remindAt));
    const dur = t.estimatedMinutes && t.estimatedMinutes > 0 ? t.estimatedMinutes : 45;
    const [sh, sm] = startTime.split(':').map(Number);
    const endMin = sh * 60 + sm + dur;
    const endTime = `${String(Math.floor(endMin / 60) % 24).padStart(2, '0')}:${String(
      endMin % 60
    ).padStart(2, '0')}`;
    const item = await createAgendaItem({
      title: t.text,
      date,
      startTime,
      endTime,
      // Hora escolhida pelo Igor = bloco fixo (priority 1): o reorganizador nunca move.
      priority: 1,
      type: 'task',
      createdBy: 'user',
      ...(t.estimatedMinutes ? { estimatedMinutes: t.estimatedMinutes } : {}),
      ...(t.subagentId ? { subagentId: t.subagentId } : {}),
      taskId: t.id,
    });
    fixedFromTasks.push(item);
    existingTitleSet.add(normTitle(t.text));
  }

  // Toda task pendente já virou bloco fixo no horário pedido (loop acima): nada
  // sobra para o LLM "encaixar". O cronograma do dia é, então, os lembretes do
  // Igor (cada um na SUA hora) + o que já existia na agenda. Não chamamos mais o
  // modelo para distribuir horários, justamente porque era ele quem realocava as
  // tarefas para a manhã e ignorava o horário pedido.
  void fixedFromTasks;
  return { items: await getAgendaForDay(date), skipped: [] };
}

// ===================== F8: detector de procrastinação =====================

/** A partir de quantos adiamentos o agente para de adiar em silêncio. */
export const PROCRASTINATION_THRESHOLD = 3;

/** True se o novo slot (data + hora de início) é mais tarde que o antigo — um adiamento. */
export function isLaterSlot(
  oldDate: string,
  oldStart: string,
  newDate: string,
  newStart: string
): boolean {
  return newDate > oldDate || (newDate === oldDate && newStart > oldStart);
}

/**
 * Aviso anti-procrastinação injetado em tool results: instrui o MODELO a parar
 * de adiar em silêncio e conversar com o Igor sobre o que está travando.
 */
export function procrastinationWarning(title: string, count: number): string {
  return (
    `⚠️ PROCRASTINAÇÃO DETECTADA: "${title}" já foi adiada ${count} vezes. ` +
    `O adiamento foi aplicado, mas NÃO termine a resposta sem tocar nisso: pergunte ao Igor, ` +
    `com leveza, o que está travando, e proponha escolher UMA saída — ` +
    `(1) quebrar em passos menores e agendar só o primeiro; ` +
    `(2) fazer AGORA uma versão de 10 minutos; ` +
    `(3) desistir conscientemente e remover da lista, sem culpa. ` +
    `Aplique a escolha dele usando as ferramentas.`
  );
}

// ===================== F4: detecção de sobrecarga =====================

/** Duração estimada de um item (min): usa estimatedMinutes ou o slot start→end. */
function itemMinutes(i: AgendaItem): number {
  if (i.estimatedMinutes && i.estimatedMinutes > 0) return i.estimatedMinutes;
  const [sh, sm] = i.startTime.split(':').map(Number);
  const [eh, em] = i.endTime.split(':').map(Number);
  const diff = eh * 60 + em - (sh * 60 + sm);
  return diff > 0 ? diff : 30;
}

/**
 * Verifica se a carga do dia ultrapassa o limite (getMaxDailyWorkMinutes) e,
 * se sim, pede ao LLM quais itens NÃO-fixos realocar para amanhã. Retorna um
 * texto de aviso pronto para o WhatsApp, ou null se a carga estiver ok.
 */
export async function detectOverload(date = dayKey()): Promise<string | null> {
  const items = await getAgendaForDay(date);
  const moveable = items.filter((i) => i.priority !== 1 && i.createdBy !== 'user' && i.status !== 'done');
  // Soma apenas o trabalho que ainda RESTA (ignora itens já concluídos), senão
  // à noite o que já foi feito infla a carga e dispara falso aviso de sobrecarga.
  const totalMin = items
    .filter((i) => i.status !== 'done')
    .reduce((acc, i) => acc + itemMinutes(i), 0);
  const cap = getMaxDailyWorkMinutes();
  if (totalMin <= cap || moveable.length === 0) return null;

  const horas = (totalMin / 60).toFixed(1);
  const capH = (cap / 60).toFixed(1);

  const cand = moveable.map((i) => ({
    title: i.title,
    startTime: i.startTime,
    priority: i.priority,
    minutos: itemMinutes(i),
  }));

  const system =
    'Você ajuda a evitar sobrecarga. Dada a lista de tarefas realocáveis do dia (menos ' +
    'prioritárias primeiro), escolha as que devem ir para amanhã até a carga caber no limite. ' +
    'Responda com os títulos EXATOS a realocar no campo "titulos".';
  const user = `Carga do dia: ${totalMin} min (limite ${cap}). Excesso a remover: ${totalMin - cap} min.
Tarefas realocáveis:
${JSON.stringify(cand, null, 2)}
Quais realocar para amanhã?`;

  const result = await chatJson<{ titulos: string[] }>(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    {
      name: 'sobrecarga',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['titulos'],
        properties: { titulos: { type: 'array', items: { type: 'string' } } },
      },
      temperature: 0,
    }
  );
  const toMove = result?.titulos ?? [];
  const lista = (toMove.length ? toMove : cand.slice(0, 1).map((c) => c.title))
    .map((t) => `• ${t}`)
    .join('\n');

  return (
    `⚠️ *Dia sobrecarregado*: ~${horas}h planejadas (limite ${capH}h).\n\n` +
    `Sugiro empurrar para amanhã:\n${lista}\n\n_Quer que eu realoque? É só confirmar._`
  );
}

// ===================== Formatação / envio =====================

/** Formata o cronograma para o WhatsApp. */
export function formatSchedule(items: AgendaItem[], date = dayKey()): string {
  if (items.length === 0) {
    return `📋 Sem itens na agenda de ${dateLabelPt(date)} ainda. Me diga o que você quer encaixar hoje! 🙂`;
  }
  const lines = items.map((i) => {
    const done = i.status === 'done' ? ' ✔️' : i.status === 'in_progress' ? ' ⏳' : '';
    const prio = PRIORITY_EMOJI[i.priority] || '⚪';
    const typ = TYPE_EMOJI[i.type] || '';
    return `${prio} *${i.startTime}–${i.endTime}* ${typ} ${i.title}${done}`;
  });
  return `🗓️ *Cronograma de ${dateLabelPt(date)}*\n\n${lines.join('\n')}\n\n_Quer reorganizar algo? É só me dizer._`;
}

// ===================== Visões consolidadas (semana / mês / próximos) =====================

/** Entrada normalizada para exibição: vem da agenda ou de uma task (lembrete). */
interface ScheduleEntry {
  date: string;
  /** HH:mm; tasks usam o horário do remindAt; ausência vira '--:--'. */
  time: string;
  endTime?: string;
  title: string;
  priority?: number;
  type: AgendaItem['type'] | 'reminder';
  status?: AgendaItem['status'];
  /** Lembrete que JÁ TOCOU mas o Igor ainda não confirmou ter feito. */
  fired?: boolean;
}

const STATUS_EMOJI: Record<AgendaItem['status'], string> = {
  pending: '⬜',
  in_progress: '⏳',
  done: '✔️',
};

/**
 * Reúne, num intervalo [start, end], os itens da `agenda` e as `tasks` pendentes
 * cujo `remindAt` cai no período — normalizados e agrupados por dia.
 */
async function collectEntries(start: string, end: string): Promise<Map<string, ScheduleEntry[]>> {
  // F10: garante que as visões reflitam o Google Calendar (uma listagem só
  // para o intervalo inteiro). Best-effort: sem Google, segue com o local.
  await syncCalendarRange(start, end);

  const [items, tasks] = await Promise.all([getAgendaInRange(start, end), listTasks()]);

  const entries: ScheduleEntry[] = items.map((i) => ({
    date: i.date,
    time: i.startTime,
    endTime: i.endTime,
    title: i.title,
    priority: i.priority,
    type: i.type,
    status: i.status,
  }));

  for (const t of tasks) {
    // CONCLUÍDO de verdade (confirmado) sai da visão; mas lembrete que apenas
    // TOCOU (done sem completedAt) continua aparecendo — antes ele sumia da
    // agenda na hora em que disparava, como se tivesse sido feito.
    if (t.completedAt) continue;
    // Dia LOCAL do lembrete (remindAt é ISO UTC; cortar a string erraria o dia).
    const date = dayKey(new Date(t.remindAt));
    if (date < start || date > end) continue;
    // Horário local do lembrete (HH:mm) a partir do ISO em remindAt.
    const time = timeKey(new Date(t.remindAt));
    entries.push({ date, time, title: t.text, type: 'reminder', fired: t.done });
  }

  const byDay = new Map<string, ScheduleEntry[]>();
  for (const e of entries) {
    const list = byDay.get(e.date) ?? [];
    list.push(e);
    byDay.set(e.date, list);
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => a.time.localeCompare(b.time));
  }
  return byDay;
}

/** Emoji/rótulo de uma entrada (item de agenda ou lembrete). */
function entryLine(e: ScheduleEntry): string {
  if (e.type === 'reminder') {
    const marca = e.fired ? '_(tocou — sem confirmação)_' : '_(lembrete)_';
    return `   ⏰ *${e.time}* ${e.title} ${marca}`;
  }
  const prio = e.priority ? PRIORITY_EMOJI[e.priority] || '⚪' : '⚪';
  const typ = TYPE_EMOJI[e.type as AgendaItem['type']] || '';
  const st = e.status ? STATUS_EMOJI[e.status] : '';
  const horario = e.endTime ? `${e.time}–${e.endTime}` : e.time;
  return `   ${prio} *${horario}* ${typ} ${e.title} ${st}`.trimEnd();
}

/**
 * Formata uma visão por intervalo, agrupada por dia. Dias sem itens são
 * omitidos. `title` é o cabeçalho (ex: "Sua semana").
 */
function formatRangeView(
  title: string,
  start: string,
  end: string,
  byDay: Map<string, ScheduleEntry[]>
): string {
  const days: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const list = byDay.get(d);
    if (!list || list.length === 0) continue;
    days.push(`📌 *${dayLabel(d)}*\n${list.map(entryLine).join('\n')}`);
  }
  if (days.length === 0) {
    return `🗓️ *${title}*\n\nNada agendado nesse período. Quer planejar algo? 🙂`;
  }
  return `🗓️ *${title}* (${dayLabel(start)} – ${dayLabel(end)})\n\n${days.join('\n\n')}`;
}

/** Resumo da semana atual (ou da que contém `ref`), agrupado por dia. */
export async function weeklyView(ref = dayKey()): Promise<string> {
  const { start, end } = weekRange(ref);
  const byDay = await collectEntries(start, end);
  return formatRangeView('Sua semana', start, end, byDay);
}

/** Resumo do mês atual (ou do que contém `ref`), agrupado por dia. */
export async function monthlyView(ref = dayKey()): Promise<string> {
  const { start, end } = monthRange(ref);
  const byDay = await collectEntries(start, end);
  const [, mm] = start.split('-');
  const monthName = new Intl.DateTimeFormat('pt-BR', {
    timeZone: config.timezone,
    month: 'long',
  }).format(new Date(`${start}T12:00:00Z`));
  return formatRangeView(`Seu mês de ${monthName} (${mm})`, start, end, byDay);
}

/**
 * Visão consolidada dos próximos `days` dias (padrão 7, incluindo hoje),
 * agrupada por dia — o "minha agenda / o que tenho agendado".
 */
export async function upcomingView(days = 7, ref = dayKey()): Promise<string> {
  const start = ref;
  const end = addDays(ref, Math.max(1, days) - 1);
  const byDay = await collectEntries(start, end);
  return formatRangeView(`Próximos ${days} dias`, start, end, byDay);
}

/**
 * Tarefas pendentes que não viraram bloco na agenda do dia — nem por vínculo
 * nem por título igual. São as que ficam sem cobrança nenhuma hoje: sem
 * horário, nada as faz tocar. É a lista de pendências ("to-do") do Igor.
 */
export async function openTasksOutsideAgenda(date: string): Promise<Task[]> {
  const agenda = await getAgendaForDay(date);
  const naAgendaIds = new Set(agenda.map((i) => i.taskId).filter(Boolean));
  const naAgendaTitulos = new Set(agenda.map((i) => i.title.trim().toLowerCase()));
  return (await listTasks()).filter(
    (t) =>
      !t.completedAt &&
      !t.done &&
      !naAgendaIds.has(t.id) &&
      !naAgendaTitulos.has(t.text.trim().toLowerCase())
  );
}

/** Quantas pendências o to-do da manhã lista; o resto vira contador. */
const TODO_LIMIT = 10;

/**
 * Segunda mensagem do bom dia: a lista de pendências. A agenda diz o que tem
 * HORA hoje; isto diz o que está em aberto e não entrou em bloco nenhum — antes
 * só aparecia se o Igor perguntasse.
 *
 * Vai em mensagem separada de propósito: no WhatsApp duas listas coladas viram
 * uma só aos olhos, e o Igor deixaria de ver metade.
 */
function formatTodoMessage(pendentes: Task[], date: string): string | null {
  if (pendentes.length === 0) return null;
  const ordenadas = [...pendentes].sort((a, b) => a.createdAt - b.createdAt);
  const linhas = ordenadas
    .slice(0, TODO_LIMIT)
    .map((t) => {
      // Pendência COM horário hoje vai tocar sozinha — mostrar a hora evita que
      // ela pareça só mais um item solto da lista.
      const comHora =
        taskHasReminder(t) && dayKey(new Date(t.remindAt)) === date
          ? ` _(⏰ ${timeKey(new Date(t.remindAt))})_`
          : '';
      return `• ${t.text}${comHora}`;
    })
    .join('\n');
  const resto = ordenadas.length - Math.min(TODO_LIMIT, ordenadas.length);
  const cabecalho =
    ordenadas.length === 1
      ? '🗂️ *Sua lista* — 1 pendência fora da agenda:'
      : `🗂️ *Sua lista* — ${ordenadas.length} pendências fora da agenda:`;
  return (
    `${cabecalho}\n${linhas}` +
    (resto > 0 ? `\n_(+${resto})_` : '') +
    '\n\n_Quer encaixar alguma no dia? É só me dizer qual._'
  );
}

/** Gera (se necessário) e envia o cronograma do dia ao dono via WhatsApp. */
export async function sendDailySchedule(date = dayKey(), carriedOver: Task[] = []): Promise<void> {
  if (!config.ownerPhone) {
    console.warn('[orchestrator] OWNER_PHONE ausente — cronograma não enviado.');
    return;
  }
  if (!isNotificationEnabled('morningSchedule')) {
    console.log('[orchestrator] cronograma do dia desativado nas configurações — não enviado.');
    return;
  }
  if (await proactiveMuted(config.ownerPhone)) {
    console.log('[orchestrator] tudo pausado — cronograma do dia não enviado.');
    return;
  }
  const { items } = await generateDailySchedule(date);

  // O que sobrou de ontem entra como PERGUNTA, não como agenda: soltamos essas
  // tarefas do horário na liberação das 07:00, e é o Igor quem decide se elas
  // voltam hoje. Numeradas, para ele responder "1 e 3".
  const pergunta =
    carriedOver.length > 0
      ? `\n\n📋 Ficaram de antes (sem horário):\n` +
        carriedOver.map((t, i) => `${i + 1}. *${t.text}*`).join('\n') +
        `\n\n_Quer que eu coloque algum hoje? Responda com os números (ex: *1 e 3*), *todos*, ou *nenhum*._`
      : '';

  const base =
    items.length > 0
      ? `Bom dia, Igor! ☀️\n\n${formatSchedule(items, date)}`
      : carriedOver.length > 0
        ? 'Bom dia, Igor! ☀️ Sua agenda de hoje está livre.'
        : 'Bom dia, Igor! ☀️ Sua agenda de hoje está livre. O que você quer planejar?';

  await sendText(config.ownerPhone, base + pergunta);
  console.log(`[orchestrator] cronograma de ${date} enviado (${items.length} itens).`);

  // Mensagem 2: a lista de pendências. O que acabou de ser perguntado como
  // "ficaram de antes" fica de fora — o Igor não pode ver o mesmo item duas
  // vezes na mesma manhã, uma como pergunta e outra como lista.
  try {
    const jaPerguntadas = new Set(carriedOver.map((t) => t.id));
    const pendentes = (await openTasksOutsideAgenda(date)).filter(
      (t) => !jaPerguntadas.has(t.id)
    );
    const todo = formatTodoMessage(pendentes, date);
    if (todo) {
      await sendText(config.ownerPhone, todo);
      console.log(`[orchestrator] lista de pendências enviada (${pendentes.length}).`);
    }
  } catch (err) {
    console.error('[orchestrator] falha ao enviar a lista de pendências:', err);
  }

  // F4: se o dia estiver sobrecarregado, avisa e sugere realocações.
  try {
    const overload = await detectOverload(date);
    if (overload) await sendText(config.ownerPhone, overload);
  } catch (err) {
    console.error('[orchestrator] falha na detecção de sobrecarga:', err);
  }
}

// ===================== Transições de tarefa =====================

/** Marca um item como concluído e propaga para a Task de origem, se houver. */
async function completeItem(item: AgendaItem): Promise<void> {
  if (item.status !== 'done') {
    // completedAt + startedAt = duração REAL, usada para calibrar estimativas.
    await updateAgendaItem(item.id, { status: 'done', completedAt: Date.now() });
  }
  if (item.taskId) {
    // Propaga a conclusão para a Task (lembrete) que originou o item. Se for
    // RECORRENTE, concluir a ocorrência de hoje só reagenda a próxima — não
    // mata a recorrência.
    try {
      const task = await getTask(item.taskId);
      if (task?.recurrence) {
        await updateTask(task.id, {
          remindAt: nextOccurrence(task.remindAt, task.recurrence),
        });
      } else {
        await markTaskDone(item.taskId);
      }
    } catch (err) {
      console.error('[orchestrator] falha ao propagar conclusão para a task:', err);
    }
  }
}

/**
 * Anuncia o estado atual da agenda após uma conclusão: encontra o próximo item
 * a fazer e, se o horário dele já chegou, promove-o a `in_progress`. Caso o
 * próximo só comece mais tarde, anuncia como "a seguir" sem promovê-lo (evita
 * marcar como "agora" algo que só acontece horas depois). Retorna a mensagem.
 */
async function announceNext(date: string, doneTitle: string): Promise<void> {
  if (!config.ownerPhone) return;
  const items = await getAgendaForDay(date);
  const now = timeKey();
  const next = items.find((i) => i.status === 'pending' || i.status === 'in_progress');

  if (!next) {
    await sendText(
      config.ownerPhone,
      `✅ Concluído: *${doneTitle}*\n\n🎉 Era o último item do dia. Mandou bem, Igor!`
    );
    return;
  }

  const slot = `${next.startTime}–${next.endTime}`;
  if (next.startTime <= now) {
    if (next.status !== 'in_progress') {
      // Preserva o primeiro início se o item já tinha startedAt (ex: pós-undo).
      await updateAgendaItem(next.id, {
        status: 'in_progress',
        ...(next.startedAt ? {} : { startedAt: Date.now() }),
      });
    }
    await sendText(
      config.ownerPhone,
      `✅ Concluído: *${doneTitle}*\n\n➡️ Agora: *${next.title}* (${slot})`
    );
  } else {
    await sendText(
      config.ownerPhone,
      `✅ Concluído: *${doneTitle}*\n\n🕒 A seguir: *${next.title}* (${slot}) — começa às ${next.startTime}.`
    );
  }
}

/**
 * Avança a agenda: marca `item` como concluído (propagando para a Task) e avisa
 * o usuário qual é o próximo. Usado pelo atalho "terminei" e pela conclusão
 * manual via tool.
 */
export async function advanceTask(item: AgendaItem): Promise<void> {
  await completeItem(item);
  await announceNext(item.date, item.title);
}

/**
 * Transições por horário, pensado para rodar a cada minuto. NÃO conclui nada
 * sozinho — concluir é do Igor (era exatamente o bug: itens viravam "✔️ feito"
 * só porque o horário passou, e a cobrança das 20:30 os ignorava). Em vez
 * disso, quando o slot de um item termina sem confirmação, pergunta UMA única
 * vez (marca `nudgedAt`) se ele foi feito, agrupando os atrasados numa só
 * mensagem — um backlog (ex: app reiniciado no meio do dia) não dispara rajada.
 *
 * SUSPENSÃO: a cobrança é uma pergunta por vez, e o dia inteiro depende dela.
 * Se o Igor não responder à primeira, o agente FICA QUIETO até o fim do dia —
 * nada de cobrar 10:45, 11:45, 14:45 e 15:45 em sequência sobre um dia que
 * claramente não aconteceu. O silêncio é a informação: o dia travou, e quem
 * decide o que fazer com ele é o Igor, no fechamento da noite (20:30). Sem
 * isso, o agente metralhava perguntas sobre blocos posteriores enquanto o
 * primeiro sequer tinha começado.
 *
 * A pergunta cobre TODOS os itens vencidos, inclusive os que nasceram de um
 * lembrete (taskId), numerados. Antes eles eram excluídos por medo de rajada, e
 * o efeito era pior: o Igor recebia uma pergunta sobre 1 de 5 itens e respondia
 * "sim" achando que cobria o dia todo. A lista numerada é registrada como
 * pergunta pendente — a resposta ("sim", "1 e 3", "só a chamada") é lida contra
 * ela em vez de ser classificada por regex sobre o texto solto.
 */
export async function processTimeBasedTransitions(): Promise<void> {
  const date = dayKey();
  const now = timeKey();
  const items = await getAgendaForDay(date);

  const overdue = items.filter((i) => i.status !== 'done' && i.endTime <= now && !i.nudgedAt);
  if (overdue.length === 0) return;

  // Tudo pausado: sai sem enviar E sem marcar `nudgedAt`. Marcar aqui seria
  // engolir o item de vez — ele entraria como "já cobrado" e nunca mais
  // apareceria. Deixando intacto, a agenda volta do jeito que estava no retomar.
  if (config.ownerPhone && (await proactiveMuted(config.ownerPhone))) return;

  // Já perguntamos hoje e o Igor não respondeu? Então a cobrança está suspensa:
  // marca os novos vencidos como "já cobrados" (para não estourarem em rajada
  // quando ele responder) e não manda mensagem nenhuma. Eles entram no
  // fechamento das 20:30, que é onde o dia é decidido de uma vez.
  if (config.ownerPhone && (await isNudgeSuspended(config.ownerPhone, date))) {
    for (const item of overdue) {
      await updateAgendaItem(item.id, { nudgedAt: Date.now() });
    }
    console.log(
      `[orchestrator] cobrança suspensa (pergunta de hoje sem resposta) — ${overdue.length} item(ns) silenciados até o fechamento.`
    );
    return;
  }

  // Marca ANTES de enviar: se o envio falhar, melhor não perguntar do que
  // perguntar em loop a cada minuto.
  for (const item of overdue) {
    await updateAgendaItem(item.id, { nudgedAt: Date.now() });
  }

  if (!config.ownerPhone) return;

  const toAsk = [...overdue].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const targets: PendingPromptTarget[] = toAsk.map((i, idx) => ({
    ...(i.taskId ? { taskId: i.taskId } : {}),
    agendaItemId: i.id,
    title: i.title,
    index: idx + 1,
  }));

  const linhas = toAsk
    .map((i, idx) => `${idx + 1}. *${i.title}* (${i.startTime}–${i.endTime})`)
    .join('\n');
  const plural = toAsk.length > 1;

  // Registra a pergunta ANTES de enviar: se o Igor responder num piscar de
  // olhos, o estado já existe para a resposta casar.
  await rememberAsk(config.ownerPhone, targets);

  await sendText(
    config.ownerPhone,
    `⏰ Terminou o horário ${plural ? 'destes itens' : 'deste item'}:\n${linhas}\n\n` +
      (plural
        ? `Quais você fez? Responda com os números (ex: *1 e 3*), *todos*, ou *nenhum*.`
        : `Você fez? Responda *sim* ou *não*.`) +
      `\n\n_O que ficar sem resposta continua pendente e eu te lembro à noite._`
  );
}

/**
 * Liberação diária (07:00): tarefa que ficou para trás SOLTA do horário e vira
 * pendente sem prazo (`hasReminder: false`). Ela NÃO entra na agenda de hoje
 * sozinha — o bom dia pergunta se o Igor quer trazê-la, e só a resposta dele
 * agenda.
 *
 * Antes isso era uma rolagem automática: a tarefa era reescrita para hoje no
 * mesmo horário, todo dia, indefinidamente. O efeito era duplamente ruim. Um
 * sábado que não aconteceu virava um domingo idêntico, depois uma segunda
 * idêntica, sem ninguém nunca ter decidido isso. E como cada rolagem
 * incrementava `postponedCount`, no terceiro dia o detector de procrastinação
 * acusava o Igor de ter adiado 3x algo que só o cron havia empurrado — o
 * sistema cobrava pelo adiamento que ele mesmo fez.
 *
 * Soltar o horário mantém a tarefa viva (ela continua pendente e aparece na
 * lista), mas devolve a decisão para quem é dela. `postponedCount` fica
 * intocado: passar do dia não é adiar, é só não ter feito.
 *
 * Recorrentes ficam de fora (reagendam sozinhas) e concluídas também.
 * Retorna as tarefas soltas, para o bom dia poder perguntar sobre elas.
 */
export async function rollOverPendingTasks(): Promise<Task[]> {
  const today = dayKey();
  const stale = (await listTasks()).filter(
    (t) =>
      !t.recurrence &&
      !t.completedAt &&
      t.hasReminder !== false &&
      dayKey(new Date(t.remindAt)) < today
  );
  for (const t of stale) {
    await updateTask(t.id, {
      // Sem prazo: não dispara, não fica "atrasada", não é cobrada.
      hasReminder: false,
      done: false,
      firedAt: null,
      lastNudgeAt: null,
    });
  }
  if (stale.length > 0) {
    console.log(
      `[orchestrator] liberação diária: ${stale.length} tarefa(s) solta(s) do horário — aguardando decisão do Igor.`
    );
  }
  return stale;
}

/**
 * Item atualmente em andamento no dia. Prioriza o que está `in_progress`; se
 * nenhum estiver, considera ativo um item `pending` cujo horário de início já
 * passou (em andamento de fato). NÃO retorna itens futuros — assim "concluir a
 * tarefa atual" nunca marca como feita uma tarefa que ainda não começou.
 */
export async function getActiveItem(date = dayKey()): Promise<AgendaItem | null> {
  const items = await getAgendaForDay(date);
  const now = timeKey();
  return (
    items.find((i) => i.status === 'in_progress') ||
    items.find((i) => i.status === 'pending' && i.startTime <= now) ||
    null
  );
}

// ===================== Realocação por linguagem natural =====================

/**
 * Aplica uma instrução de realocação em linguagem natural ("adia o dentista pra
 * depois do almoço"). Itens fixos (priority 1) nunca são movidos. Retorna o
 * texto de confirmação com o novo cronograma.
 */
export async function reorganize(
  instruction: string,
  date = dayKey(),
  forceAll = false
): Promise<string> {
  const items = await getAgendaForDay(date);
  if (items.length === 0) {
    // A agenda (blocos de cronograma) pode estar vazia e ainda assim haver
    // LEMBRETES no dia — caso comum: "muda o compromisso das 8h30", que é uma
    // task. Devolve a lista com ids para o modelo agir via editar_lembrete,
    // em vez de dizer (errado) que não há nada no dia.
    const dayTasks = (await listTasks()).filter(
      (t) => !t.done && dayKey(new Date(t.remindAt)) === date
    );
    if (dayTasks.length > 0) {
      const linhas = dayTasks
        .map((t) => `- id: ${t.id} | ${timeKey(new Date(t.remindAt))} | ${t.text}`)
        .join('\n');
      return (
        `A agenda de ${dateLabelPt(date)} não tem blocos de cronograma, mas existem LEMBRETES no dia:\n` +
        `${linhas}\n\n` +
        `Para alterar horário ou texto de um deles, use a ferramenta editar_lembrete com o id. ` +
        `Para apagar, remover_lembrete.`
      );
    }
    return 'Sua agenda de hoje está vazia — não há o que reorganizar. Quer que eu gere o cronograma?';
  }

  const current = items.map((i) => ({
    id: i.id,
    title: i.title,
    startTime: i.startTime,
    endTime: i.endTime,
    priority: i.priority,
    // forceAll: o Igor pediu pra readaptar o dia inteiro — nada é intocável.
    fixed: forceAll ? false : i.priority === 1 || i.createdBy === 'user',
  }));

  const regraFixos = forceAll
    ? '- O Igor pediu para READAPTAR O DIA TODO: você PODE mover qualquer item, inclusive os fixos.'
    : '- Itens com "fixed": true (priority 1) NUNCA podem mudar de horário. Mantenha-os iguais.';

  const system = `Você reorganiza a agenda do Igor conforme um pedido em linguagem natural.

Regras:
${regraFixos}
- Reencaixe os itens sem sobreposição, respeitando o pedido do usuário.
- Não invente itens novos nem remova existentes; apenas ajuste startTime/endTime.

Responda com TODOS os itens (mesmo os que não mudaram) no campo "itens".`;

  const user = `Agenda atual:
${JSON.stringify(current, null, 2)}

Pedido do usuário: "${instruction}"

Novo cronograma:`;

  const result = await chatJson<{ itens: { id: string; startTime: string; endTime: string }[] }>(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    {
      name: 'reorganizacao',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['itens'],
        properties: {
          itens: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'startTime', 'endTime'],
              properties: {
                id: { type: 'string' },
                startTime: { type: 'string', description: 'HH:mm' },
                endTime: { type: 'string', description: 'HH:mm' },
              },
            },
          },
        },
      },
      temperature: 0,
    }
  );

  const updates = result?.itens ?? [];

  // Honestidade antes de tudo: se o modelo não devolveu um plano utilizável,
  // NADA mudou — dizer "reorganizei" aqui seria mentira (mesma classe do bug
  // de prometer agendamento sem criar).
  if (updates.length === 0) {
    return (
      'Não consegui montar a reorganização a partir desse pedido — *nada foi alterado* na agenda. ' +
      'Pode repetir dizendo qual item e para que horário? (ex: "joga o boleto pra 16h")'
    );
  }

  const byId = new Map(items.map((i) => [i.id, i]));
  let applied = 0;
  const procrastinados: string[] = [];

  for (const u of updates) {
    const item = byId.get(u.id);
    if (!item) continue;
    // Trava de segurança: nunca move item fixo, mesmo que o modelo tente —
    // EXCETO quando o Igor pediu para readaptar o dia inteiro (forceAll).
    if (!forceAll && (item.priority === 1 || item.createdBy === 'user')) continue;
    if (!u.startTime || !u.endTime) continue;
    if (u.startTime === item.startTime && u.endTime === item.endTime) continue;
    // F8: mover para MAIS TARDE conta como adiamento; antecipar zera nada.
    const adiou = isLaterSlot(item.date, item.startTime, item.date, u.startTime);
    const novoCount = adiou ? (item.postponedCount ?? 0) + 1 : item.postponedCount ?? 0;
    await updateAgendaItem(item.id, {
      startTime: u.startTime,
      endTime: u.endTime,
      ...(adiou ? { postponedCount: novoCount } : {}),
    });
    if (adiou && novoCount >= PROCRASTINATION_THRESHOLD) {
      procrastinados.push(procrastinationWarning(item.title, novoCount));
    }
    applied++;
  }

  const updated = await getAgendaForDay(date);
  if (applied === 0) {
    const motivo = forceAll
      ? 'os itens já estavam nos horários pedidos'
      : 'os itens envolvidos são fixos (compromissos com hora marcada) ou já estavam nos horários pedidos';
    return `Nenhum horário foi alterado — ${motivo}.\n\n${formatSchedule(updated, date)}`;
  }
  const aviso = procrastinados.length ? `\n\n${procrastinados.join('\n\n')}` : '';
  return `Pronto, reorganizei (${applied} ${applied === 1 ? 'item' : 'itens'})! ✨\n\n${formatSchedule(updated, date)}${aviso}`;
}
