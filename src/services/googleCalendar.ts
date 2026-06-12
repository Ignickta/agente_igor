import axios from 'axios';
import { JWT } from 'google-auth-library';
import { config } from '../config';
import { dayKey, timeKey, dayStartMs, addDays } from './datetime';

/**
 * F10: cliente do Google Calendar via service account (a MESMA do Firebase —
 * o projeto Firebase é um projeto Google Cloud). Sem OAuth: o Igor compartilha
 * a agenda com o e-mail da service account ("Fazer alterações nos eventos") e
 * define GOOGLE_CALENDAR_ID no .env. Sem a env, tudo aqui vira no-op.
 */

const API = 'https://www.googleapis.com/calendar/v3';

/** Evento normalizado para o vocabulário do projeto (dia local + HH:mm). */
export interface CalendarEvent {
  id: string;
  title: string;
  /** Dia local YYYY-MM-DD (início). */
  date: string;
  /** HH:mm local; eventos de dia inteiro usam '00:00'. */
  startTime: string;
  endTime: string;
  /** Evento de dia inteiro (sem horário) — não vira bloco de cronograma. */
  allDay: boolean;
  description?: string;
}

/** True quando a integração está configurada (GOOGLE_CALENDAR_ID presente). */
export function calendarEnabled(): boolean {
  return Boolean(config.googleCalendar.calendarId);
}

let jwtClient: JWT | null = null;

/** Headers de autorização (token cacheado/renovado pela google-auth-library). */
async function authHeaders(): Promise<Record<string, string>> {
  if (!jwtClient) {
    jwtClient = new JWT({
      email: config.firebase.clientEmail,
      key: config.firebase.privateKey,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
  }
  const headers = await jwtClient.getRequestHeaders();
  return { ...headers, 'Content-Type': 'application/json' };
}

function calendarUrl(path = ''): string {
  return `${API}/calendars/${encodeURIComponent(config.googleCalendar.calendarId)}/events${path}`;
}

/** Payload cru de um evento como vem da API do Google. */
interface RawEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
}

/**
 * Normaliza início/fim de um evento do Google para o dia/horário LOCAIS do
 * projeto. Pura (recebe o payload, devolve a janela) — coberta pelos evals.
 * Eventos de dia inteiro usam `start.date`/`end.date` (end EXCLUSIVO).
 */
export function parseEventWindow(
  raw: Pick<RawEvent, 'start' | 'end'>
): { date: string; startTime: string; endTime: string; allDay: boolean } | null {
  if (raw.start?.dateTime) {
    const start = new Date(raw.start.dateTime);
    const end = raw.end?.dateTime ? new Date(raw.end.dateTime) : null;
    if (isNaN(start.getTime())) return null;
    const date = dayKey(start);
    const startTime = timeKey(start);
    let endTime = end && !isNaN(end.getTime()) ? timeKey(end) : startTime;
    // Evento que atravessa a meia-noite: o bloco local termina no fim do dia.
    if (end && dayKey(end) !== date) endTime = '23:59';
    return { date, startTime, endTime, allDay: false };
  }
  if (raw.start?.date) {
    return { date: raw.start.date, startTime: '00:00', endTime: '23:59', allDay: true };
  }
  return null;
}

function normalize(raw: RawEvent): CalendarEvent | null {
  if (!raw.id || raw.status === 'cancelled') return null;
  const window = parseEventWindow(raw);
  if (!window) return null;
  return {
    id: raw.id,
    title: (raw.summary || '(sem título)').trim(),
    ...window,
    ...(raw.description ? { description: raw.description } : {}),
  };
}

/**
 * Eventos do calendário num intervalo de dias locais [start, end] (inclusivo).
 * `singleEvents=true` expande recorrências — cada ocorrência vem como um
 * evento próprio, com id próprio.
 */
export async function listCalendarEvents(start: string, end: string): Promise<CalendarEvent[]> {
  if (!calendarEnabled()) return [];
  const headers = await authHeaders();
  const res = await axios.get(calendarUrl(), {
    headers,
    params: {
      timeMin: new Date(dayStartMs(start)).toISOString(),
      timeMax: new Date(dayStartMs(addDays(end, 1))).toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    },
    timeout: 15000,
  });
  const items: RawEvent[] = res.data?.items ?? [];
  return items.map(normalize).filter((e): e is CalendarEvent => e !== null);
}

/** Busca um evento pelo id. Retorna null se não existe ou foi cancelado. */
export async function getCalendarEvent(id: string): Promise<CalendarEvent | null> {
  if (!calendarEnabled()) return null;
  try {
    const headers = await authHeaders();
    const res = await axios.get(calendarUrl(`/${encodeURIComponent(id)}`), {
      headers,
      timeout: 15000,
    });
    return normalize(res.data as RawEvent);
  } catch (err) {
    if (axios.isAxiosError(err) && (err.response?.status === 404 || err.response?.status === 410)) {
      return null;
    }
    throw err;
  }
}

/** Corpo start/end da API a partir de dia local + HH:mm. */
function eventBody(date: string, startTime: string, endTime: string) {
  return {
    start: { dateTime: `${date}T${startTime}:00`, timeZone: config.timezone },
    end: { dateTime: `${date}T${endTime}:00`, timeZone: config.timezone },
  };
}

/** Cria um evento e retorna o id gerado pelo Google (ou null se desabilitado). */
export async function createCalendarEvent(data: {
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  description?: string;
}): Promise<string | null> {
  if (!calendarEnabled()) return null;
  const headers = await authHeaders();
  const res = await axios.post(
    calendarUrl(),
    {
      summary: data.title,
      ...(data.description ? { description: data.description } : {}),
      ...eventBody(data.date, data.startTime, data.endTime),
    },
    { headers, timeout: 15000 }
  );
  return (res.data?.id as string) || null;
}

/** Atualiza título e/ou janela de um evento existente (PATCH parcial). */
export async function updateCalendarEvent(
  id: string,
  data: { title?: string; date?: string; startTime?: string; endTime?: string }
): Promise<void> {
  if (!calendarEnabled()) return;
  const body: Record<string, unknown> = {};
  if (data.title) body.summary = data.title;
  if (data.date && data.startTime && data.endTime) {
    Object.assign(body, eventBody(data.date, data.startTime, data.endTime));
  }
  if (Object.keys(body).length === 0) return;
  const headers = await authHeaders();
  await axios.patch(calendarUrl(`/${encodeURIComponent(id)}`), body, { headers, timeout: 15000 });
}

/** Remove um evento. 404/410 (já removido) não é erro. */
export async function deleteCalendarEvent(id: string): Promise<void> {
  if (!calendarEnabled()) return;
  try {
    const headers = await authHeaders();
    await axios.delete(calendarUrl(`/${encodeURIComponent(id)}`), { headers, timeout: 15000 });
  } catch (err) {
    if (axios.isAxiosError(err) && (err.response?.status === 404 || err.response?.status === 410)) {
      return;
    }
    throw err;
  }
}
