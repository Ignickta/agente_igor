import { config } from '../config';
import { chat, ChatMessage } from '../services/openai';
import { sendText } from '../services/evolution';
import {
  listTasks,
  listSubagents,
  getFacts,
  getAgendaForDay,
  getAgendaInRange,
  createAgendaItem,
  updateAgendaItem,
  getCompletedTasksBetween,
  markTaskDone,
} from '../services/firebase';
import { AgendaItem } from '../types';
import { dayKey, timeKey, addDays, weekdayOf } from '../services/datetime';

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

/** Resultado bruto que o LLM deve devolver para cada item planejado. */
interface PlannedItem {
  title: string;
  startTime: string;
  endTime: string;
  priority: number;
  type: AgendaItem['type'];
  estimatedMinutes?: number;
  notes?: string;
  subagentId?: string;
}

/**
 * Extrai um array JSON da resposta do modelo, tolerando cercas de código
 * (```json ... ```) e texto ao redor.
 */
function parseJsonArray<T>(raw: string): T[] {
  const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

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
    return linhas.join('\n');
  } catch (err) {
    console.error('[orchestrator] falha ao aprender padrões:', err instanceof Error ? err.message : err);
    return '';
  }
}

/**
 * Gera o cronograma do dia a partir das `tasks` pendentes de hoje + itens já na
 * `agenda`, com prioridade calculada pelo agente.
 *
 * Itens fixos do usuário (priority 1) entram como restrição imutável no prompt;
 * o modelo encaixa os demais (priority 2–5) em volta. Idempotente: se já houver
 * itens gerados pelo agente para o dia, não regenera (a menos que `force`).
 */
export async function generateDailySchedule(
  date = dayKey(),
  force = false
): Promise<AgendaItem[]> {
  const existing = await getAgendaForDay(date);
  const agentGenerated = existing.filter((i) => i.createdBy === 'agent');
  if (agentGenerated.length > 0 && !force) {
    return existing;
  }

  // Tarefas pendentes cujo lembrete cai no dia alvo (data LOCAL: remindAt é
  // ISO UTC, e cortar a string colocaria lembretes após as 21h no dia seguinte).
  const tasks = (await listTasks()).filter(
    (t) => !t.done && dayKey(new Date(t.remindAt)) === date
  );

  // Itens fixos do usuário (não serão movidos).
  const fixed = existing.filter((i) => i.priority === 1 || i.createdBy === 'user');

  if (tasks.length === 0 && existing.length === 0) {
    return [];
  }

  // Contexto da memória: fatos do subagente "Pessoal", se existir.
  let memoryContext = '';
  try {
    const subs = await listSubagents(true);
    const pessoal = subs.find((s) => /pessoal/i.test(s.name));
    if (pessoal && config.ownerPhone) {
      const facts = await getFacts(config.ownerPhone, pessoal.id, 15);
      if (facts.length) memoryContext = facts.map((f) => `- ${f}`).join('\n');
    }
  } catch (err) {
    console.error('[orchestrator] falha ao carregar contexto de memória:', err);
  }

  const candidates = tasks.map((t) => ({
    title: t.text,
    deadline: t.remindAt,
    subagentId: t.subagentId,
    estimatedMinutes: t.estimatedMinutes,
  }));

  // F10: padrões aprendidos do histórico, para otimizar ordem/horários.
  const patterns = await learnUserPatterns();

  const fixedDesc = fixed.length
    ? fixed
        .map((i) => `- ${i.startTime}–${i.endTime} "${i.title}" (FIXO, priority 1)`)
        .join('\n')
    : '(nenhum item fixo)';

  const system = `Você é o orquestrador do dia do Igor. Monte um cronograma realista para ${date}.

Regras de prioridade:
- priority 1 = item fixo do usuário com horário definido; NUNCA mova nem altere esses.
- priority 2 a 5 = você calcula com base em deadline, tipo de tarefa e contexto do usuário
  (2 = mais urgente/importante, 5 = menos).

Encaixe as tarefas pendentes em volta dos itens fixos, sem sobreposição de horários,
respeitando horário comercial (08:00–19:00) e deixando intervalos curtos quando fizer sentido.
Se a tarefa trouxer "estimatedMinutes", use-o para dimensionar o bloco (start→end). Quando o
histórico indicar um período mais produtivo, prefira alocar as tarefas mais importantes nele.

Classifique cada item em type: "task", "event" ou "research".

Responda APENAS com um array JSON, sem texto fora dele. Cada elemento:
{ "title": string, "startTime": "HH:mm", "endTime": "HH:mm", "priority": number (2-5),
  "type": "task"|"event"|"research", "estimatedMinutes"?: number, "notes"?: string, "subagentId"?: string }`;

  const user = `Itens FIXOS (não mexer):
${fixedDesc}

Tarefas pendentes a encaixar:
${candidates.length ? JSON.stringify(candidates, null, 2) : '(nenhuma)'}

Contexto do usuário (memória):
${memoryContext || '(sem contexto adicional)'}

Padrões aprendidos do histórico:
${patterns || '(sem histórico suficiente)'}

Gere o cronograma dos itens NÃO-fixos em JSON:`;

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const answer = await chat(messages, { temperature: 0 });
  const planned = parseJsonArray<PlannedItem>(answer);

  // Defesa: o modelo pode reemitir um item fixo (que foi passado só como
  // contexto). Não persistimos planejados que dupliquem um fixo — por título
  // normalizado ou pelo mesmo slot de horário — para não criar cópias.
  const norm = (s: string) => s.trim().toLowerCase();
  const fixedTitles = new Set(fixed.map((i) => norm(i.title)));
  const fixedSlots = new Set(fixed.map((i) => `${i.startTime}-${i.endTime}`));

  // Mapa título→taskId para vincular o item de agenda à Task de origem, de modo
  // que concluir o item depois propague para a Task (markTaskDone).
  const taskByTitle = new Map(tasks.map((t) => [norm(t.text), t.id]));

  // Persiste os itens gerados pelo agente.
  const created: AgendaItem[] = [];
  for (const p of planned) {
    if (!p.title || !p.startTime || !p.endTime) continue;
    if (fixedTitles.has(norm(p.title)) || fixedSlots.has(`${p.startTime}-${p.endTime}`)) {
      continue;
    }
    const taskId = taskByTitle.get(norm(p.title));
    const item = await createAgendaItem({
      title: p.title,
      date,
      startTime: p.startTime,
      endTime: p.endTime,
      priority: Math.min(5, Math.max(2, Number(p.priority) || 3)),
      type: (['task', 'event', 'research'] as const).includes(p.type) ? p.type : 'task',
      createdBy: 'agent',
      ...(p.estimatedMinutes ? { estimatedMinutes: Math.round(Number(p.estimatedMinutes)) } : {}),
      ...(p.notes ? { notes: p.notes } : {}),
      ...(p.subagentId ? { subagentId: p.subagentId } : {}),
      ...(taskId ? { taskId } : {}),
    });
    created.push(item);
  }

  return getAgendaForDay(date);
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
 * Verifica se a carga do dia ultrapassa o limite (config.maxDailyWorkMinutes) e,
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
  const cap = config.maxDailyWorkMinutes;
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
    'Responda APENAS com um array JSON de títulos exatos a realocar: ["título 1", "título 2"].';
  const user = `Carga do dia: ${totalMin} min (limite ${cap}). Excesso a remover: ${totalMin - cap} min.
Tarefas realocáveis:
${JSON.stringify(cand, null, 2)}
Quais realocar para amanhã (JSON)?`;

  const answer = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 0 }
  );
  const toMove = parseJsonArray<string>(answer);
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
    return `📋 Sem itens na agenda de ${date} ainda. Me diga o que você quer encaixar hoje! 🙂`;
  }
  const lines = items.map((i) => {
    const done = i.status === 'done' ? ' ✔️' : i.status === 'in_progress' ? ' ⏳' : '';
    const prio = PRIORITY_EMOJI[i.priority] || '⚪';
    const typ = TYPE_EMOJI[i.type] || '';
    return `${prio} *${i.startTime}–${i.endTime}* ${typ} ${i.title}${done}`;
  });
  return `🗓️ *Cronograma de ${date}*\n\n${lines.join('\n')}\n\n_Quer reorganizar algo? É só me dizer._`;
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
    if (t.done) continue;
    // Dia LOCAL do lembrete (remindAt é ISO UTC; cortar a string erraria o dia).
    const date = dayKey(new Date(t.remindAt));
    if (date < start || date > end) continue;
    // Horário local do lembrete (HH:mm) a partir do ISO em remindAt.
    const time = timeKey(new Date(t.remindAt));
    entries.push({ date, time, title: t.text, type: 'reminder' });
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
    return `   ⏰ *${e.time}* ${e.title} _(lembrete)_`;
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

/** Gera (se necessário) e envia o cronograma do dia ao dono via WhatsApp. */
export async function sendDailySchedule(date = dayKey()): Promise<void> {
  if (!config.ownerPhone) {
    console.warn('[orchestrator] OWNER_PHONE ausente — cronograma não enviado.');
    return;
  }
  const items = await generateDailySchedule(date);
  const text =
    items.length > 0
      ? `Bom dia, Igor! ☀️\n\n${formatSchedule(items, date)}`
      : 'Bom dia, Igor! ☀️ Sua agenda de hoje está livre. O que você quer planejar?';
  await sendText(config.ownerPhone, text);
  console.log(`[orchestrator] cronograma de ${date} enviado (${items.length} itens).`);

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
    await updateAgendaItem(item.id, { status: 'done' });
  }
  if (item.taskId) {
    // Propaga a conclusão para a Task (lembrete) que originou o item, para que
    // os relatórios não a contem como pendente para sempre.
    await markTaskDone(item.taskId).catch((err) =>
      console.error('[orchestrator] falha ao propagar conclusão para a task:', err)
    );
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
      await updateAgendaItem(next.id, { status: 'in_progress' });
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
 * Transições por horário (modo horário do híbrido), pensado para rodar a cada
 * minuto. Conclui silenciosamente TODOS os itens cujo `endTime` já passou (sem
 * uma mensagem por item) e, no fim, faz UM único anúncio do item atual — assim
 * um backlog (ex: app reiniciado no meio do dia) não dispara uma rajada de
 * mensagens nem promove itens fora de ordem.
 */
export async function processTimeBasedTransitions(): Promise<void> {
  const date = dayKey();
  const now = timeKey();
  const items = await getAgendaForDay(date);

  const overdue = items.filter((i) => i.status !== 'done' && i.endTime <= now);
  if (overdue.length === 0) return;

  for (const item of overdue) {
    await completeItem(item);
  }

  // Um único anúncio, citando o último item concluído por horário.
  const lastDone = overdue.sort((a, b) => a.endTime.localeCompare(b.endTime)).pop()!;
  await announceNext(date, lastDone.title);
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
export async function reorganize(instruction: string, date = dayKey()): Promise<string> {
  const items = await getAgendaForDay(date);
  if (items.length === 0) {
    return 'Sua agenda de hoje está vazia — não há o que reorganizar. Quer que eu gere o cronograma?';
  }

  const current = items.map((i) => ({
    id: i.id,
    title: i.title,
    startTime: i.startTime,
    endTime: i.endTime,
    priority: i.priority,
    fixed: i.priority === 1 || i.createdBy === 'user',
  }));

  const system = `Você reorganiza a agenda do Igor conforme um pedido em linguagem natural.

Regras:
- Itens com "fixed": true (priority 1) NUNCA podem mudar de horário. Mantenha-os iguais.
- Reencaixe os demais sem sobreposição, respeitando o pedido do usuário.
- Não invente itens novos nem remova existentes; apenas ajuste startTime/endTime.

Responda APENAS com um array JSON: [{ "id": string, "startTime": "HH:mm", "endTime": "HH:mm" }]
incluindo TODOS os itens (mesmo os que não mudaram).`;

  const user = `Agenda atual:
${JSON.stringify(current, null, 2)}

Pedido do usuário: "${instruction}"

Novo cronograma em JSON:`;

  const answer = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 0 }
  );

  const updates = parseJsonArray<{ id: string; startTime: string; endTime: string }>(answer);
  const byId = new Map(items.map((i) => [i.id, i]));

  for (const u of updates) {
    const item = byId.get(u.id);
    if (!item) continue;
    // Trava de segurança: nunca move item fixo, mesmo que o modelo tente.
    if (item.priority === 1 || item.createdBy === 'user') continue;
    if (!u.startTime || !u.endTime) continue;
    if (u.startTime === item.startTime && u.endTime === item.endTime) continue;
    await updateAgendaItem(item.id, { startTime: u.startTime, endTime: u.endTime });
  }

  const updated = await getAgendaForDay(date);
  return `Pronto, reorganizei! ✨\n\n${formatSchedule(updated, date)}`;
}
