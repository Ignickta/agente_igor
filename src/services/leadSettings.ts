import { config } from '../config';
import {
  LeadBotSettings,
  getStoredLeadBotSettings,
  saveStoredLeadBotSettings,
} from './firebase';

const MAX_NAME_LENGTH = 120;
const MAX_CONTEXT_LENGTH = 20_000;
const MAX_INSTRUCTIONS_LENGTH = 12_000;

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

function defaultsFromConfig(): LeadBotSettings {
  return {
    enabled: config.leadBot.enabled,
    businessName: config.leadBot.businessName.trim(),
    businessContext: config.leadBot.businessContext.trim(),
    instructions: config.leadBot.instructions.trim(),
    historyLimit: config.leadBot.historyLimit,
    maxMessagesPerHour: config.leadBot.maxMessagesPerHour,
  };
}

function normalize(input: Partial<LeadBotSettings>): LeadBotSettings {
  const base = defaultsFromConfig();
  return {
    enabled: input.enabled === true,
    businessName: String(input.businessName ?? base.businessName).trim().slice(0, MAX_NAME_LENGTH),
    businessContext: String(input.businessContext ?? base.businessContext)
      .trim()
      .slice(0, MAX_CONTEXT_LENGTH),
    instructions: String(input.instructions ?? base.instructions)
      .trim()
      .slice(0, MAX_INSTRUCTIONS_LENGTH),
    historyLimit: clampInteger(input.historyLimit, base.historyLimit, 2, 30),
    maxMessagesPerHour: clampInteger(
      input.maxMessagesPerHour,
      base.maxMessagesPerHour,
      5,
      120
    ),
  };
}

let current = defaultsFromConfig();

export async function loadLeadBotSettings(): Promise<void> {
  try {
    const stored = await getStoredLeadBotSettings();
    if (stored) {
      current = normalize(stored);
      console.log('[leads] configurações comerciais carregadas do Firestore.');
    }
  } catch (err) {
    console.error('[leads] falha ao carregar configurações — usando defaults das envs:', err);
  }
}

export function effectiveLeadBotSettings(): LeadBotSettings {
  return { ...current };
}

export function leadBotConfigurationError(settings = current): string | null {
  if (!settings.businessName.trim()) return 'Informe o nome da empresa.';
  if (!settings.businessContext.trim()) return 'Informe o contexto comercial do atendimento.';
  return null;
}

export function isLeadBotReady(): boolean {
  return current.enabled && !leadBotConfigurationError(current);
}

export async function updateLeadBotSettings(
  input: Partial<LeadBotSettings>
): Promise<LeadBotSettings> {
  const merged = normalize({ ...current, ...input });
  const error = merged.enabled ? leadBotConfigurationError(merged) : null;
  if (error) throw new Error(error);
  await saveStoredLeadBotSettings(merged);
  current = merged;
  return effectiveLeadBotSettings();
}

// Limite simples em memória para impedir que um contato consuma a API sem controle.
const leadUsage = new Map<string, number[]>();
const ONE_HOUR_MS = 60 * 60 * 1000;

export function consumeLeadQuota(contact: string, now = Date.now()): boolean {
  const cutoff = now - ONE_HOUR_MS;
  // Limpa contatos expirados quando o mapa cresce, evitando retenção ilimitada.
  if (leadUsage.size > 1_000) {
    for (const [storedContact, timestamps] of leadUsage) {
      if (!timestamps.some((timestamp) => timestamp > cutoff)) leadUsage.delete(storedContact);
    }
  }
  const recent = (leadUsage.get(contact) || []).filter((timestamp) => timestamp > cutoff);
  if (recent.length >= current.maxMessagesPerHour) {
    leadUsage.set(contact, recent);
    return false;
  }
  recent.push(now);
  leadUsage.set(contact, recent);
  return true;
}
