import { config } from '../config';
import {
  ProactiveSettings,
  getStoredSettings,
  saveStoredSettings,
} from './firebase';

/**
 * Overlay de configurações de proatividade. Os valores efetivos vêm do
 * documento `settings/proactive` no Firestore (editado pelo painel) quando
 * existir; caso contrário, dos defaults derivados das envs (`config`).
 *
 * Carregado uma vez no boot (`loadSettings`) e mantido em memória. Os
 * consumidores leem pelos getters (`effectiveSettings`, `getUrgentKeywords`,
 * `getMaxDailyWorkMinutes`, `isNotificationEnabled`) — nunca direto do `config`
 * — para que uma alteração no painel tenha efeito sem reiniciar o processo.
 */

/** Defaults a partir das envs. Sempre uma cópia nova (arrays não compartilhados). */
function defaultsFromConfig(): ProactiveSettings {
  return {
    maxDailyWorkMinutes: config.maxDailyWorkMinutes,
    urgentKeywords: [...config.urgentKeywords],
    notifications: {
      morningSchedule: { enabled: config.proactiveNotifications, time: '07:00' },
      eveningSummary: { enabled: config.proactiveNotifications, time: '22:00' },
      weeklyReview: { enabled: config.proactiveNotifications, time: '18:00' },
      subagentReports: { enabled: config.proactiveNotifications },
    },
  };
}

let current: ProactiveSettings = defaultsFromConfig();

/** Carrega do Firestore para o overlay (best-effort). Chamar no boot. */
export async function loadSettings(): Promise<void> {
  try {
    const stored = await getStoredSettings();
    if (stored) {
      current = mergeWithDefaults(stored);
      console.log('[settings] configurações de proatividade carregadas do Firestore.');
    }
  } catch (err) {
    console.error('[settings] falha ao carregar configurações — usando defaults das envs:', err);
  }
}

/**
 * Mescla o doc salvo com os defaults, tolerando campos ausentes (docs antigos
 * ou parciais não derrubam um getter). Normaliza tipos vindos do banco.
 */
function mergeWithDefaults(stored: Partial<ProactiveSettings>): ProactiveSettings {
  const base = defaultsFromConfig();
  const n = stored.notifications || ({} as ProactiveSettings['notifications']);
  return {
    maxDailyWorkMinutes:
      typeof stored.maxDailyWorkMinutes === 'number' && stored.maxDailyWorkMinutes > 0
        ? stored.maxDailyWorkMinutes
        : base.maxDailyWorkMinutes,
    urgentKeywords: Array.isArray(stored.urgentKeywords)
      ? stored.urgentKeywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean)
      : base.urgentKeywords,
    notifications: {
      morningSchedule: { ...base.notifications.morningSchedule, ...(n.morningSchedule || {}) },
      eveningSummary: { ...base.notifications.eveningSummary, ...(n.eveningSummary || {}) },
      weeklyReview: { ...base.notifications.weeklyReview, ...(n.weeklyReview || {}) },
      subagentReports: { ...base.notifications.subagentReports, ...(n.subagentReports || {}) },
    },
  };
}

/** Snapshot atual das configurações efetivas (para o GET do painel). */
export function effectiveSettings(): ProactiveSettings {
  return current;
}

/** Persiste e aplica novas configurações em runtime. */
export async function updateSettings(input: ProactiveSettings): Promise<ProactiveSettings> {
  const merged = mergeWithDefaults(input);
  await saveStoredSettings(merged);
  current = merged;
  return current;
}

/** Palavras-chave de urgência efetivas (painel > envs). */
export function getUrgentKeywords(): string[] {
  return current.urgentKeywords;
}

/** Limite de carga diária (minutos) efetivo. */
export function getMaxDailyWorkMinutes(): number {
  return current.maxDailyWorkMinutes;
}

type NotificationKey = keyof ProactiveSettings['notifications'];

/**
 * True se a notificação está habilitada. Respeita o kill-switch global
 * (`config.proactiveNotifications`): se as proativas estão OFF na env, nenhuma
 * notificação passa, independentemente do painel.
 */
export function isNotificationEnabled(key: NotificationKey): boolean {
  if (!config.proactiveNotifications) return false;
  return current.notifications[key]?.enabled !== false;
}
