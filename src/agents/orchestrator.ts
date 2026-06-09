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
} from '../services/firebase';
import { AgendaItem } from '../types';

/** Data local (YYYY-MM-DD) no timezone configurado. */
export function dayKey(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Hora local (HH:mm) no timezone configurado. */
function timeKey(date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** Soma `days` a uma data YYYY-MM-DD e devolve outra YYYY-MM-DD (UTC-safe). */
function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Dia da semana local (0=domingo .. 6=sábado) de uma data YYYY-MM-DD. */
function weekdayOf(dateKey: string): number {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    weekday: 'short',
  }).format(new Date(`${dateKey}T12:00:00Z`));
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

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

  // Tarefas pendentes cujo lembrete cai no dia alvo.
  const tasks = (await listTasks()).filter(
    (t) => !t.done && t.remindAt.slice(0, 10) === date
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
  }));

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

Classifique cada item em type: "task", "event" ou "research".

Responda APENAS com um array JSON, sem texto fora dele. Cada elemento:
{ "title": string, "startTime": "HH:mm", "endTime": "HH:mm", "priority": number (2-5),
  "type": "task"|"event"|"research", "notes"?: string, "subagentId"?: string }`;

  const user = `Itens FIXOS (não mexer):
${fixedDesc}

Tarefas pendentes a encaixar:
${candidates.length ? JSON.stringify(candidates, null, 2) : '(nenhuma)'}

Contexto do usuário (memória):
${memoryContext || '(sem contexto adicional)'}

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

  // Persiste os itens gerados pelo agente.
  const created: AgendaItem[] = [];
  for (const p of planned) {
    if (!p.title || !p.startTime || !p.endTime) continue;
    if (fixedTitles.has(norm(p.title)) || fixedSlots.has(`${p.startTime}-${p.endTime}`)) {
      continue;
    }
    const item = await createAgendaItem({
      title: p.title,
      date,
      startTime: p.startTime,
      endTime: p.endTime,
      priority: Math.min(5, Math.max(2, Number(p.priority) || 3)),
      type: (['task', 'event', 'research'] as const).includes(p.type) ? p.type : 'task',
      createdBy: 'agent',
      ...(p.notes ? { notes: p.notes } : {}),
      ...(p.subagentId ? { subagentId: p.subagentId } : {}),
    });
    created.push(item);
  }

  return getAgendaForDay(date);
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
    const date = t.remindAt.slice(0, 10);
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
}

// ===================== Transições de tarefa =====================

/**
 * Avança a agenda: marca `item` como concluído, promove o próximo item pendente
 * para `in_progress` e avisa o usuário no WhatsApp. Usado tanto pelo cron
 * (transição por horário) quanto pelo atalho "terminei" (confirmação).
 */
export async function advanceTask(item: AgendaItem): Promise<void> {
  if (item.status !== 'done') {
    await updateAgendaItem(item.id, { status: 'done' });
  }

  const dayItems = await getAgendaForDay(item.date);
  const next = dayItems.find(
    (i) => i.id !== item.id && i.status === 'pending'
  );

  if (!config.ownerPhone) return;

  if (next) {
    await updateAgendaItem(next.id, { status: 'in_progress' });
    await sendText(
      config.ownerPhone,
      `✅ Concluído: *${item.title}*\n\n➡️ Agora: *${next.title}* (${next.startTime}–${next.endTime})`
    );
  } else {
    await sendText(
      config.ownerPhone,
      `✅ Concluído: *${item.title}*\n\n🎉 Era o último item do dia. Mandou bem, Igor!`
    );
  }
}

/**
 * Verifica a agenda de hoje e avança itens cujo `endTime` já passou e ainda não
 * foram concluídos (modo horário do híbrido). Pensado para rodar a cada minuto.
 */
export async function processTimeBasedTransitions(): Promise<void> {
  const date = dayKey();
  const now = timeKey();
  const items = await getAgendaForDay(date);
  for (const item of items) {
    if (item.status !== 'done' && item.endTime <= now) {
      await advanceTask(item);
    }
  }
}

/** Item atualmente em andamento no dia (ou o próximo pendente), se houver. */
export async function getActiveItem(date = dayKey()): Promise<AgendaItem | null> {
  const items = await getAgendaForDay(date);
  return (
    items.find((i) => i.status === 'in_progress') ||
    items.find((i) => i.status === 'pending') ||
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
