import { config } from '../config';
import { sendText } from '../services/evolution';
import {
  startFocus,
  getFocus,
  endFocus,
  getExpiredFocusSessions,
} from '../services/firebase';

/** Default de duração do foco quando o usuário não especifica (minutos). */
const DEFAULT_FOCUS_MINUTES = 60;

/** True se a mensagem é um pedido para entrar em modo foco. */
export function isFocusRequest(text: string): boolean {
  const t = text.toLowerCase();
  return /modo\s*foco|entrar\s+em\s+foco|\bfoco\s+por\b|\bfoca(r)?\b|me\s+foca/.test(t);
}

/** Extrai a duração (minutos) de frases como "foco por 2h", "foco por 90 min". */
function parseFocusMinutes(text: string): number {
  const t = text.toLowerCase();
  const h = t.match(/(\d+(?:[.,]\d+)?)\s*h(?:oras?)?\b/);
  if (h) return Math.round(parseFloat(h[1].replace(',', '.')) * 60);
  const m = t.match(/(\d+)\s*(?:min|minutos?)\b/);
  if (m) return parseInt(m[1], 10);
  return DEFAULT_FOCUS_MINUTES;
}

/** True se a mensagem é marcada como urgente (passa mesmo durante o foco). */
export function isUrgent(text: string): boolean {
  const t = text.toLowerCase();
  return config.urgentKeywords.some((k) => t.includes(k));
}

/**
 * Inicia uma sessão de foco para o contato. Retorna a resposta a enviar.
 */
export async function enterFocus(contact: string, text: string): Promise<string> {
  const minutes = Math.min(600, Math.max(10, parseFocusMinutes(text)));
  const endsAt = Date.now() + minutes * 60000;
  await startFocus(contact, endsAt);
  const fim = new Date(endsAt).toLocaleTimeString('pt-BR', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
  });
  const horas = minutes >= 60 ? `${(minutes / 60).toFixed(minutes % 60 ? 1 : 0)}h` : `${minutes} min`;
  return (
    `🔕 *Modo foco ativado* por ${horas} (até ${fim}).\n` +
    'Vou segurar as mensagens não urgentes até lá. Se for urgente, escreva "urgente" que eu respondo na hora.'
  );
}

/**
 * Verifica o estado do foco para uma mensagem recebida.
 * - active=false: não há foco vigente; siga o fluxo normal.
 * - active=true + reply: foco vigente e mensagem não-urgente; responda `reply`
 *   e NÃO processe a mensagem.
 * - active=true + sem reply: foco vigente mas a mensagem é urgente; processe.
 */
export async function focusGate(
  contact: string,
  text: string
): Promise<{ active: boolean; reply?: string }> {
  const session = await getFocus(contact);
  if (!session || session.ended || session.endsAt <= Date.now()) {
    return { active: false };
  }
  if (isUrgent(text)) {
    return { active: true }; // urgente: deixa passar
  }
  const fim = new Date(session.endsAt).toLocaleTimeString('pt-BR', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
  });
  return {
    active: true,
    reply: `🔕 Você está em modo foco até ${fim}. Anotei sua mensagem mentalmente — me chame com "urgente" se for mesmo importante. 🙂`,
  };
}

/**
 * Encerra sessões de foco expiradas e avisa o usuário. Pensado para rodar no
 * cron de cada minuto. Respeita o kill-switch de notificações proativas.
 */
export async function processFocusExpirations(): Promise<void> {
  if (!config.proactiveNotifications) return;
  const expired = await getExpiredFocusSessions();
  for (const s of expired) {
    await endFocus(s.contact);
    await sendText(s.contact, '✅ *Modo foco encerrado.* Como foi? Posso retomar o que ficou pendente.');
    console.log(`[focus] foco encerrado para ${s.contact}`);
  }
}
