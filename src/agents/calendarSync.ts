import {
  CalendarEvent,
  calendarEnabled,
  listCalendarEvents,
  getCalendarEvent,
} from '../services/googleCalendar';
import {
  getAgendaInRange,
  createAgendaItem,
  updateAgendaItem,
  deleteAgendaItem,
} from '../services/firebase';
import { AgendaItem } from '../types';

/**
 * F10: espelhamento Google Calendar → agenda local. Eventos com horário viram
 * itens FIXOS (priority 1, createdBy 'user') do cronograma, deduplicados por
 * `gcalEventId` — assim aparecem no cronograma das 07:00, nas visões de
 * semana/mês e nas transições de horário, sem tocar no resto do sistema.
 *
 * Direção dos conflitos: o Google Calendar é a fonte da verdade dos eventos
 * espelhados. Edições feitas PELO agente são propagadas ao Google na hora
 * (tools em subagents/index.ts), então o próximo sync já as vê consistentes.
 */

/** Subconjunto de AgendaItem que a reconciliação precisa enxergar. */
export type MirrorItem = Pick<
  AgendaItem,
  'id' | 'title' | 'date' | 'startTime' | 'endTime' | 'status' | 'gcalEventId'
>;

export interface MirrorPlan {
  /** Eventos novos no Google que ainda não têm item local. */
  toCreate: CalendarEvent[];
  /** Item local equivalente (mesmo título + horário sobreposto) a "adotar" (linkar o id). */
  toAdopt: { itemId: string; eventId: string }[];
  /** Itens espelhados cujo evento mudou no Google (título/dia/horário). */
  toUpdate: { itemId: string; event: CalendarEvent }[];
  /**
   * Itens espelhados cujo evento NÃO apareceu no intervalo — pode ter sido
   * cancelado OU movido para fora do range; quem decide é um GET individual.
   */
  toDeleteCheck: MirrorItem[];
}

const norm = (s: string) => s.trim().toLowerCase();

/** True se [aStart,aEnd) e [bStart,bEnd) se sobrepõem (strings HH:mm). */
const overlaps = (a: MirrorItem, e: CalendarEvent) =>
  a.date === e.date && a.startTime < e.endTime && e.startTime < a.endTime;

/**
 * Calcula o plano de reconciliação entre os eventos do Google e os itens da
 * agenda local num mesmo intervalo. PURA (sem I/O) — coberta pelos evals.
 * Itens já concluídos (`done`) nunca são alterados nem removidos.
 */
export function diffMirror(events: CalendarEvent[], items: MirrorItem[]): MirrorPlan {
  const plan: MirrorPlan = { toCreate: [], toAdopt: [], toUpdate: [], toDeleteCheck: [] };
  const byEventId = new Map(items.filter((i) => i.gcalEventId).map((i) => [i.gcalEventId!, i]));
  const seenEventIds = new Set<string>();
  const adoptedItemIds = new Set<string>();

  for (const e of events) {
    if (e.allDay) continue; // dia inteiro não vira bloco de cronograma
    seenEventIds.add(e.id);

    const mirrored = byEventId.get(e.id);
    if (mirrored) {
      const changed =
        mirrored.title !== e.title ||
        mirrored.date !== e.date ||
        mirrored.startTime !== e.startTime ||
        mirrored.endTime !== e.endTime;
      if (changed && mirrored.status !== 'done') {
        plan.toUpdate.push({ itemId: mirrored.id, event: e });
      }
      continue;
    }

    // Item local equivalente sem link (Igor criou dos dois lados): adota em vez
    // de duplicar — mesmo título e horário sobreposto no mesmo dia.
    const twin = items.find(
      (i) =>
        !i.gcalEventId &&
        !adoptedItemIds.has(i.id) &&
        norm(i.title) === norm(e.title) &&
        overlaps(i, e)
    );
    if (twin) {
      adoptedItemIds.add(twin.id);
      plan.toAdopt.push({ itemId: twin.id, eventId: e.id });
      continue;
    }

    plan.toCreate.push(e);
  }

  // Espelhados que sumiram do intervalo: cancelados OU movidos para fora dele.
  for (const i of items) {
    if (!i.gcalEventId || seenEventIds.has(i.gcalEventId)) continue;
    if (i.status === 'done') continue;
    plan.toDeleteCheck.push(i);
  }

  return plan;
}

/**
 * Sincroniza o intervalo [start, end] (dias locais, inclusivo): UMA chamada de
 * listagem ao Google + reconciliação com a agenda local. Best-effort: falhas
 * são logadas e nunca derrubam o chamador (cronograma/visões funcionam sem o
 * Google). No-op se GOOGLE_CALENDAR_ID não estiver configurado.
 */
export async function syncCalendarRange(start: string, end: string): Promise<void> {
  if (!calendarEnabled()) return;
  try {
    const [events, items] = await Promise.all([
      listCalendarEvents(start, end),
      getAgendaInRange(start, end),
    ]);
    const plan = diffMirror(events, items);

    for (const e of plan.toCreate) {
      await createAgendaItem({
        title: e.title,
        date: e.date,
        startTime: e.startTime,
        endTime: e.endTime,
        priority: 1,
        type: 'event',
        createdBy: 'user',
        gcalEventId: e.id,
        ...(e.description ? { notes: e.description.slice(0, 500) } : {}),
      });
    }
    for (const a of plan.toAdopt) {
      await updateAgendaItem(a.itemId, { gcalEventId: a.eventId });
    }
    for (const u of plan.toUpdate) {
      await updateAgendaItem(u.itemId, {
        title: u.event.title,
        date: u.event.date,
        startTime: u.event.startTime,
        endTime: u.event.endTime,
      });
    }
    for (const i of plan.toDeleteCheck) {
      // GET individual decide: cancelado → remove o espelho; movido → segue o evento.
      const event = await getCalendarEvent(i.gcalEventId!);
      if (!event) {
        await deleteAgendaItem(i.id);
      } else if (!event.allDay) {
        await updateAgendaItem(i.id, {
          title: event.title,
          date: event.date,
          startTime: event.startTime,
          endTime: event.endTime,
        });
      }
    }

    const total =
      plan.toCreate.length + plan.toAdopt.length + plan.toUpdate.length + plan.toDeleteCheck.length;
    if (total > 0) {
      console.log(
        `[calendarSync] ${start}..${end}: +${plan.toCreate.length} novos, ` +
          `${plan.toAdopt.length} adotados, ${plan.toUpdate.length} atualizados, ` +
          `${plan.toDeleteCheck.length} verificados.`
      );
    }
  } catch (err) {
    console.error('[calendarSync] falha no sync (seguindo sem o Google):', err instanceof Error ? err.message : err);
  }
}

/** Atalho: sincroniza um único dia local. */
export async function syncCalendarDay(date: string): Promise<void> {
  await syncCalendarRange(date, date);
}
