import { AgendaItem, Task, UndoOp } from '../types';
import {
  createAgendaItem,
  getAgendaForDay,
  getAgendaInRange,
  getAgendaItem,
  updateAgendaItem,
  deleteAgendaItem,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  getPendingTasksBetween,
} from './firebase';
import {
  calendarEnabled,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from './googleCalendar';
import { recordUndo } from '../agents/undo';
import { parseLocalIso, dayKey, timeKey } from './datetime';

/**
 * Camada compartilhada de ações da agenda.
 *
 * As regras de criar/remarcar/cancelar compromisso nasceram dentro do executor
 * de ferramentas do WhatsApp. A Alexa precisa das MESMAS regras (validação,
 * idempotência, espelho no Google, lembrete vinculado, desfazer) sem simular
 * uma mensagem de WhatsApp nem chamar a rota administrativa.
 *
 * Por isso elas moram aqui, em funções que devolvem RESULTADO ESTRUTURADO —
 * nunca texto pronto. Cada canal formata do seu jeito: o WhatsApp responde em
 * texto para o modelo, a Alexa fala uma frase curta, o painel mostra na tela.
 *
 * Este módulo é deliberadamente leve em dependências (nada de OpenAI, Evolution
 * ou orquestrador): ele está no caminho crítico da voz, que tem orçamento de
 * poucos segundos.
 */

/** Canal que originou a ação — entra na auditoria e no texto do desfazer. */
export type AgendaChannel = 'whatsapp' | 'alexa' | 'panel';

export interface AgendaActionContext {
  channel: AgendaChannel;
  /** Contato dono da ação; é a chave da pilha de desfazer. */
  contact: string;
  /** Id da requisição de origem (a Alexa usa para idempotência e log). */
  requestId?: string;
}

/** Sufixo de origem na descrição do desfazer. O WhatsApp fica sem sufixo. */
function origin(ctx: AgendaActionContext): string {
  return ctx.channel === 'whatsapp' ? '' : ` via ${ctx.channel === 'alexa' ? 'Alexa' : 'painel'}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

/** Dois intervalos do mesmo dia se cruzam? Bordas encostadas não são conflito. */
export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Mover para outro dia ou para uma hora maior é adiamento (alimenta o F8). */
function isLaterSlot(oldDate: string, oldStart: string, newDate: string, newStart: string): boolean {
  return newDate > oldDate || (newDate === oldDate && newStart > oldStart);
}

/** Comparação de título tolerante a acento, caixa e espaço repetido. */
export function normalizeTitle(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Criação
// ---------------------------------------------------------------------------

export interface CreateAppointmentInput {
  title: string;
  /** YYYY-MM-DD. */
  date: string;
  /** HH:mm. */
  startTime: string;
  /** HH:mm. */
  endTime: string;
  /**
   * Fixo = compromisso do usuário, que o reorganizador nunca move (prioridade 1
   * + createdBy 'user'). Móvel = bloco de planejamento remanejável. A Alexa só
   * cria fixos.
   */
  fixed: boolean;
}

export type CreateAppointmentResult =
  | { ok: true; item: AgendaItem; gcalEventId: string | null }
  | { ok: false; reason: 'missing_title' | 'invalid_date' | 'invalid_time' | 'invalid_range' }
  | { ok: false; reason: 'duplicate'; existing: AgendaItem };

/**
 * Mesmo título no mesmo dia com horário sobreposto = já existe.
 *
 * Núcleo puro, separado do Firestore para poder ser testado sem rede.
 */
export function findDuplicate(
  items: AgendaItem[],
  title: string,
  startTime: string,
  endTime: string
): AgendaItem | undefined {
  const alvo = normalizeTitle(title);
  return items.find(
    (i) => normalizeTitle(i.title) === alvo && overlaps(startTime, endTime, i.startTime, i.endTime)
  );
}

/**
 * Cria um compromisso na agenda.
 *
 * A checagem de duplicata (mesmo título no mesmo dia com horário sobreposto)
 * existe porque o modelo às vezes repete a chamada numa rodada seguinte de
 * tool-calling — foi assim que a agenda ganhou itens duplicados. Na Alexa a
 * mesma checagem cobre a reentrega de requisição.
 */
export async function createAppointment(
  input: CreateAppointmentInput,
  ctx: AgendaActionContext
): Promise<CreateAppointmentResult> {
  const title = input.title.trim();
  if (!title) return { ok: false, reason: 'missing_title' };
  if (!DATE_RE.test(input.date)) return { ok: false, reason: 'invalid_date' };
  if (!TIME_RE.test(input.startTime) || !TIME_RE.test(input.endTime)) {
    return { ok: false, reason: 'invalid_time' };
  }
  if (input.endTime <= input.startTime) return { ok: false, reason: 'invalid_range' };

  const existing = findDuplicate(await getAgendaForDay(input.date), title, input.startTime, input.endTime);
  if (existing) return { ok: false, reason: 'duplicate', existing };

  const item = await createAgendaItem({
    title,
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    priority: input.fixed ? 1 : 3,
    type: 'event',
    createdBy: input.fixed ? 'user' : 'agent',
  });

  // Evento FIXO também vai para o Google Calendar quando ele estiver ativo —
  // best-effort: a agenda local funciona igual se o Google falhar. Blocos
  // móveis são planejamento interno e não poluem o calendário.
  let gcalEventId: string | null = null;
  if (input.fixed && calendarEnabled()) {
    try {
      gcalEventId = await createCalendarEvent({
        title,
        date: input.date,
        startTime: input.startTime,
        endTime: input.endTime,
      });
      if (gcalEventId) await updateAgendaItem(item.id, { gcalEventId });
    } catch (err) {
      console.error('[agendaActions] falha ao criar no Google Calendar:', err);
    }
  }

  recordUndo(ctx.contact, `a criação do evento "${title}"${origin(ctx)}`, async () => {
    await deleteAgendaItem(item.id);
    if (gcalEventId) await deleteCalendarEvent(gcalEventId).catch(() => undefined);
  });

  return { ok: true, item: gcalEventId ? { ...item, gcalEventId } : item, gcalEventId };
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

export interface ListAppointmentsInput {
  /** YYYY-MM-DD inicial (inclusivo). */
  start: string;
  /** YYYY-MM-DD final (inclusivo); ausente = só o dia inicial. */
  end?: string;
  /** Deixa de fora o que já foi concluído. */
  excludeDone?: boolean;
}

/**
 * Itens de um intervalo, ordenados por data e horário. O range é feito no
 * Firestore (um único campo, sem índice composto) — nunca filtrando em memória
 * uma coleção inteira, que é o caminho rápido para estourar a cota.
 */
export async function listAppointments(input: ListAppointmentsInput): Promise<AgendaItem[]> {
  const end = input.end ?? input.start;
  const items =
    end === input.start
      ? await getAgendaForDay(input.start)
      : await getAgendaInRange(input.start, end);
  return input.excludeDone ? items.filter((i) => i.status !== 'done') : items;
}

/**
 * Um item do dia, venha ele da agenda ou dos lembretes.
 *
 * A agenda guarda compromissos com hora marcada; os lembretes vivem em outra
 * coleção e só viram bloco de agenda quando o dia é organizado. Quem pergunta
 * "o que eu tenho amanhã" quer as duas coisas — separar isso é detalhe de
 * implementação, não do dia da pessoa.
 */
export interface ScheduleEntry {
  kind: 'event' | 'reminder';
  id: string;
  title: string;
  /** YYYY-MM-DD local. */
  date: string;
  /** HH:mm local. */
  startTime: string;
}

/**
 * Agenda e lembretes de um intervalo, juntos e em ordem de horário.
 *
 * Um lembrete que JÁ virou bloco na agenda aparece uma vez só, como
 * compromisso — senão a pessoa ouviria a mesma coisa duas vezes com nomes
 * diferentes.
 */
export async function listScheduleEntries(input: ListAppointmentsInput): Promise<ScheduleEntry[]> {
  const end = input.end ?? input.start;
  const [items, tasks] = await Promise.all([
    listAppointments(input),
    getPendingTasksBetween(input.start, end),
  ]);

  const jaNaAgenda = new Set(items.map((i) => i.taskId).filter(Boolean));

  const eventos: ScheduleEntry[] = items.map((i) => ({
    kind: 'event',
    id: i.id,
    title: i.title,
    date: i.date,
    startTime: i.startTime,
  }));

  const lembretes: ScheduleEntry[] = tasks
    .filter((t) => !jaNaAgenda.has(t.id))
    .map((t) => {
      const quando = new Date(t.remindAt);
      return {
        kind: 'reminder' as const,
        id: t.id,
        title: t.text,
        date: dayKey(quando),
        startTime: timeKey(quando),
      };
    })
    // A query traz um dia de folga de cada lado; o recorte exato é aqui.
    .filter((e) => e.date >= input.start && e.date <= end);

  return [...eventos, ...lembretes].sort(
    (a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime)
  );
}

export interface FindCandidatesInput extends CandidateQuery {
  start: string;
  end: string;
  /** Alterações e cancelamentos ignoram o que já está concluído. */
  excludeDone?: boolean;
}

/**
 * Candidatos a uma alteração, do mais provável para o menos provável.
 *
 * A busca é determinística de propósito: quem escolhe é o Igor, por voz, e uma
 * pontuação previsível é o que permite dizer "encontrei mais de um" em vez de
 * chutar o item errado. Empate no topo NÃO deve ser resolvido automaticamente —
 * quem chama precisa comparar os dois primeiros antes de agir.
 */
export async function findAppointmentCandidates(
  input: FindCandidatesInput
): Promise<AgendaItem[]> {
  const items = await listAppointments({
    start: input.start,
    end: input.end,
    excludeDone: input.excludeDone,
  });
  return rankCandidates(items, input);
}

/** Critério de escolha: quanto o item combina com o que foi falado. */
export interface CandidateQuery {
  /** Trecho do título falado. */
  title?: string;
  /** HH:mm aproximado, quando a pessoa citar o horário em vez do nome. */
  aroundTime?: string;
}

/**
 * Pontua um item contra o que foi falado. `null` = não é candidato.
 *
 * Título exato vale mais que título contido, que vale mais que palavras soltas.
 * O horário aproximado só descarta sozinho quando nenhum título foi dito — se a
 * pessoa disse o nome, um horário diferente não elimina o item, apenas o
 * desempata mais abaixo.
 */
export function scoreCandidate(item: AgendaItem, query: CandidateQuery): number | null {
  const alvo = normalizeTitle(query.title ?? '');
  const titulo = normalizeTitle(item.title);
  let score = 0;

  if (alvo) {
    if (titulo === alvo) score += 100;
    else if (titulo.includes(alvo)) score += 60;
    else {
      const termos = alvo.split(' ').filter((t) => t.length > 2);
      const achados = termos.filter((t) => titulo.includes(t)).length;
      if (achados === 0) return null;
      score += 20 * achados;
    }
  }

  if (query.aroundTime) {
    const diff = Math.abs(minutesOf(item.startTime) - minutesOf(query.aroundTime));
    if (diff === 0) score += 40;
    else if (diff <= 60) score += 20;
    else if (!alvo) return null;
  }

  return score;
}

/**
 * Ordena e filtra os candidatos. Núcleo puro: recebe os itens já carregados,
 * para que a regra de escolha possa ser testada sem tocar no Firestore.
 */
export function rankCandidates(items: AgendaItem[], query: CandidateQuery): AgendaItem[] {
  return items
    .map((item) => ({ item, score: scoreCandidate(item, query) }))
    .filter((c): c is { item: AgendaItem; score: number } => c.score !== null)
    .sort(
      // Desempate por proximidade no tempo: entre dois iguais, o mais próximo
      // de agora é quase sempre o que a pessoa quis dizer.
      (a, b) =>
        b.score - a.score ||
        a.item.date.localeCompare(b.item.date) ||
        a.item.startTime.localeCompare(b.item.startTime)
    )
    .map((c) => c.item);
}

/**
 * Há empate na primeira posição? Nesse caso quem chamou NÃO pode escolher
 * sozinho — tem de perguntar. É a trava que impede remarcar ou cancelar o
 * compromisso errado por voz.
 */
export function isAmbiguous(items: AgendaItem[], query: CandidateQuery): boolean {
  const ranked = rankCandidates(items, query);
  if (ranked.length < 2) return false;
  return scoreCandidate(ranked[0], query) === scoreCandidate(ranked[1], query);
}

function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Outros compromissos do dia que cruzam com o intervalo pretendido. Conflito
 * não bloqueia (duas coisas ao mesmo tempo podem ser intencionais) — serve para
 * avisar e pedir uma confirmação reforçada.
 */
export async function findConflicts(
  date: string,
  startTime: string,
  endTime: string,
  ignoreId?: string
): Promise<AgendaItem[]> {
  return conflictsIn(await getAgendaForDay(date), startTime, endTime, ignoreId);
}

/** Núcleo puro de `findConflicts`, testável sem Firestore. */
export function conflictsIn(
  items: AgendaItem[],
  startTime: string,
  endTime: string,
  ignoreId?: string
): AgendaItem[] {
  return items.filter(
    (i) =>
      i.id !== ignoreId &&
      i.status !== 'done' &&
      overlaps(startTime, endTime, i.startTime, i.endTime)
  );
}

// ---------------------------------------------------------------------------
// Remarcação
// ---------------------------------------------------------------------------

export interface RescheduleAppointmentInput {
  id: string;
  title?: string;
  /** YYYY-MM-DD. */
  date?: string;
  /** HH:mm. */
  startTime?: string;
  /** HH:mm. */
  endTime?: string;
}

export type RescheduleAppointmentResult =
  | {
      ok: true;
      before: AgendaItem;
      after: AgendaItem;
      /** Quantas vezes o item já foi empurrado para mais tarde. */
      postponedCount: number;
      /** O lembrete de origem foi movido junto. */
      linkedTaskMoved: boolean;
    }
  | { ok: false; reason: 'not_found' | 'nothing_to_change' | 'invalid_date' | 'invalid_time' | 'invalid_range' };

/**
 * Remarca (ou renomeia) um item da agenda.
 *
 * Mover o bloco sem mover o LEMBRETE que o originou deixava o lembrete tocando
 * no horário antigo — o "antecipei e ele continuou me cobrando". Por isso a
 * task vinculada é rearmada junto, e o desfazer restaura os dois.
 */
export async function rescheduleAppointment(
  input: RescheduleAppointmentInput,
  ctx: AgendaActionContext
): Promise<RescheduleAppointmentResult> {
  const id = input.id.trim();
  if (!id) return { ok: false, reason: 'not_found' };
  const item = await getAgendaItem(id);
  if (!item) return { ok: false, reason: 'not_found' };

  const title = input.title?.trim();
  const date = input.date?.trim();
  const startTime = input.startTime?.trim();
  const endTime = input.endTime?.trim();
  if (date && !DATE_RE.test(date)) return { ok: false, reason: 'invalid_date' };
  if ((startTime && !TIME_RE.test(startTime)) || (endTime && !TIME_RE.test(endTime))) {
    return { ok: false, reason: 'invalid_time' };
  }

  const updates: Partial<
    Pick<AgendaItem, 'title' | 'startTime' | 'endTime' | 'date' | 'postponedCount'>
  > = {};
  if (title) updates.title = title;
  if (startTime) updates.startTime = startTime;
  if (endTime) updates.endTime = endTime;
  if (date) updates.date = date;
  if (Object.keys(updates).length === 0) return { ok: false, reason: 'nothing_to_change' };

  const novoInicio = startTime || item.startTime;
  const novoFim = endTime || item.endTime;
  if (novoFim <= novoInicio) return { ok: false, reason: 'invalid_range' };

  let postponedCount = item.postponedCount ?? 0;
  if (
    (startTime || date) &&
    isLaterSlot(item.date, item.startTime, date || item.date, novoInicio)
  ) {
    postponedCount += 1;
    updates.postponedCount = postponedCount;
  }

  await updateAgendaItem(id, updates);
  const after = { ...item, ...updates } as AgendaItem;

  if (item.gcalEventId && calendarEnabled()) {
    try {
      await updateCalendarEvent(item.gcalEventId, {
        ...(title ? { title: after.title } : {}),
        date: after.date,
        startTime: after.startTime,
        endTime: after.endTime,
      });
    } catch (err) {
      console.error('[agendaActions] falha ao propagar edição para o Google Calendar:', err);
    }
  }

  let linkedTask: Task | null = null;
  let linkedTaskPrev: Partial<Omit<Task, 'id' | 'createdAt'>> | null = null;
  if (item.taskId && (date || startTime || title)) {
    linkedTask = await getTask(item.taskId);
    if (linkedTask && !linkedTask.completedAt) {
      linkedTaskPrev = {
        text: linkedTask.text,
        remindAt: linkedTask.remindAt,
        done: linkedTask.done,
        firedAt: linkedTask.firedAt ?? null,
        lastNudgeAt: linkedTask.lastNudgeAt ?? null,
      };
      await updateTask(linkedTask.id, {
        ...(title ? { text: title } : {}),
        ...(date || startTime
          ? {
              remindAt: parseLocalIso(`${after.date}T${after.startTime}:00`).toISOString(),
              done: false,
              firedAt: null,
              lastNudgeAt: null,
            }
          : {}),
      });
    } else {
      linkedTask = null;
    }
  }

  const anterior = {
    title: item.title,
    startTime: item.startTime,
    endTime: item.endTime,
    date: item.date,
    postponedCount: item.postponedCount ?? 0,
  };
  recordUndo(
    ctx.contact,
    `a edição do item "${item.title}"${origin(ctx)}`,
    async () => {
      await updateAgendaItem(id, anterior);
      if (linkedTask && linkedTaskPrev) await updateTask(linkedTask.id, linkedTaskPrev);
      if (item.gcalEventId && calendarEnabled()) {
        await updateCalendarEvent(item.gcalEventId, {
          title: item.title,
          date: item.date,
          startTime: item.startTime,
          endTime: item.endTime,
        }).catch(() => undefined);
      }
    },
    [
      { kind: 'agenda.update', id, data: anterior },
      ...(linkedTask && linkedTaskPrev
        ? [{ kind: 'task.update', id: linkedTask.id, data: linkedTaskPrev } as UndoOp]
        : []),
    ]
  );

  return { ok: true, before: item, after, postponedCount, linkedTaskMoved: linkedTask !== null };
}

// ---------------------------------------------------------------------------
// Cancelamento
// ---------------------------------------------------------------------------

export type CancelAppointmentResult =
  | { ok: true; item: AgendaItem; linkedTaskRemoved: boolean; gcalRemoved: boolean }
  | { ok: false; reason: 'not_found' };

/**
 * Cancela um compromisso.
 *
 * Cancela junto o LEMBRETE que originou o bloco — compromisso cancelado não
 * deve continuar cobrando. Séries recorrentes ficam: some a ocorrência, a série
 * continua. O espelho no Google também é removido, senão o próximo sync
 * recriaria o item aqui.
 */
export async function cancelAppointment(
  id: string,
  ctx: AgendaActionContext
): Promise<CancelAppointmentResult> {
  const alvo = id.trim();
  if (!alvo) return { ok: false, reason: 'not_found' };
  const item = await getAgendaItem(alvo);
  if (!item) return { ok: false, reason: 'not_found' };

  await deleteAgendaItem(alvo);

  let removedTask: Task | null = null;
  if (item.taskId) {
    const t = await getTask(item.taskId);
    if (t && !t.recurrence && !t.completedAt) {
      await deleteTask(t.id);
      removedTask = t;
    }
  }

  let gcalRemoved = false;
  if (item.gcalEventId && calendarEnabled()) {
    try {
      await deleteCalendarEvent(item.gcalEventId);
      gcalRemoved = true;
    } catch (err) {
      console.error('[agendaActions] falha ao remover do Google Calendar:', err);
    }
  }

  recordUndo(ctx.contact, `a remoção do item "${item.title}"${origin(ctx)}`, async () => {
    if (removedTask) {
      await createTask({
        text: removedTask.text,
        remindAt: removedTask.remindAt,
        to: removedTask.to,
        ...(removedTask.subagentId ? { subagentId: removedTask.subagentId } : {}),
        ...(removedTask.estimatedMinutes ? { estimatedMinutes: removedTask.estimatedMinutes } : {}),
      });
    }
    // Recria no Google primeiro (id novo) para religar o espelho.
    let novoGcalId: string | null = null;
    if (gcalRemoved) {
      novoGcalId = await createCalendarEvent({
        title: item.title,
        date: item.date,
        startTime: item.startTime,
        endTime: item.endTime,
      }).catch(() => null);
    }
    await createAgendaItem({
      title: item.title,
      date: item.date,
      startTime: item.startTime,
      endTime: item.endTime,
      priority: item.priority,
      type: item.type,
      createdBy: item.createdBy,
      status: item.status,
      ...(item.notes ? { notes: item.notes } : {}),
      ...(item.subagentId ? { subagentId: item.subagentId } : {}),
      ...(item.estimatedMinutes ? { estimatedMinutes: item.estimatedMinutes } : {}),
      ...(item.taskId ? { taskId: item.taskId } : {}),
      ...(novoGcalId ? { gcalEventId: novoGcalId } : {}),
    });
  });

  return { ok: true, item, linkedTaskRemoved: removedTask !== null, gcalRemoved };
}
