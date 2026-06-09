import { config } from '../config';

/**
 * Helpers de data/hora centralizados, todos no timezone configurado
 * (config.timezone). Antes estavam duplicados em orchestrator/firebase/reports/
 * focus — um único lugar evita divergência (fuso, DST, formato).
 */

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
export function timeKey(date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/** Soma `days` a uma data YYYY-MM-DD e devolve outra YYYY-MM-DD (UTC-safe). */
export function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Dia da semana local (0=domingo .. 6=sábado) de uma data YYYY-MM-DD. */
export function weekdayOf(dateKey: string): number {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    weekday: 'short',
  }).format(new Date(`${dateKey}T12:00:00Z`));
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

/**
 * Epoch ms do início (00:00) de um dia local YYYY-MM-DD no timezone configurado.
 *
 * Calcula o offset real do fuso para aquela data (cobre DST) e o aplica ao
 * instante UTC da meia-noite — não depende do timezone do processo, ao contrário
 * de `new Date('YYYY-MM-DDT00:00:00')`.
 */
export function dayStartMs(dateKey: string): number {
  const utcMidnight = new Date(`${dateKey}T00:00:00Z`).getTime();
  // Quanto o relógio local está adiantado/atrasado em relação ao UTC nessa data.
  const offsetMin = tzOffsetMinutes(dateKey, config.timezone);
  // Local 00:00 = UTC 00:00 menos o offset local.
  return utcMidnight - offsetMin * 60000;
}

/**
 * Converte um ISO 8601 SEM offset (ex: "2026-06-10T22:00:00"), interpretado no
 * timezone configurado, em um Date correto — independente do fuso do servidor.
 * `new Date('...T22:00:00')` usaria o fuso do PROCESSO (UTC em containers sem
 * TZ), deslocando lembretes em horas. Strings com offset/Z passam direto.
 */
export function parseLocalIso(iso: string): Date {
  const trimmed = iso.trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return new Date(trimmed);
  const m = trimmed.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return new Date(trimmed);
  const [, dateKey, hh = '00', mm = '00', ss = '00'] = m;
  const utcMs = Date.UTC(
    Number(dateKey.slice(0, 4)),
    Number(dateKey.slice(5, 7)) - 1,
    Number(dateKey.slice(8, 10)),
    Number(hh),
    Number(mm),
    Number(ss)
  );
  // Local = UTC + offset ⇒ UTC = local - offset.
  return new Date(utcMs - tzOffsetMinutes(dateKey, config.timezone) * 60000);
}

/**
 * Offset (em minutos) do timezone em relação ao UTC para uma data
 * (ex.: America/Sao_Paulo → -180). Positivo a leste de Greenwich.
 */
function tzOffsetMinutes(dateKey: string, timeZone: string): number {
  const at = new Date(`${dateKey}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
  }).formatToParts(at);
  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT+0';
  const m = tzName.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/);
  if (!m) return 0;
  const hours = parseInt(m[1], 10);
  const mins = m[2] ? parseInt(m[2], 10) : 0;
  return hours * 60 + Math.sign(hours || 1) * mins;
}
