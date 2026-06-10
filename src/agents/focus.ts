import { config } from '../config';
import { sendText } from '../services/evolution';
import { timeKey } from '../services/datetime';
import {
  startFocus,
  getFocus,
  endFocus,
  getExpiredFocusSessions,
} from '../services/firebase';

/** Default de duração do foco quando o usuário não especifica (minutos). */
const DEFAULT_FOCUS_MINUTES = 60;

/**
 * Mensagens seguradas durante o foco, para entregar quando ele terminar. Antes
 * o bot dizia "anotei sua mensagem mentalmente" e DESCARTAVA o texto — promessa
 * falsa. Em memória, por contato (um restart perde a fila; janela curta, ok).
 */
const heldByContact = new Map<string, { text: string; at: number }[]>();
const MAX_HELD = 20;

function holdMessage(contact: string, text: string): void {
  const list = heldByContact.get(contact) ?? [];
  list.push({ text: text.slice(0, 500), at: Date.now() });
  heldByContact.set(contact, list.slice(-MAX_HELD));
}

/** Formata e limpa a fila de mensagens seguradas do contato ('' se vazia). */
function flushHeld(contact: string): string {
  const list = heldByContact.get(contact) ?? [];
  heldByContact.delete(contact);
  if (list.length === 0) return '';
  const linhas = list.map((m) => `• [${timeKey(new Date(m.at))}] ${m.text}`).join('\n');
  return `\n\n📥 Enquanto você focava, você tinha me mandado:\n${linhas}\n\nQuer que eu trate ${
    list.length > 1 ? 'alguma delas' : 'isso'
  } agora?`;
}

/** True se a mensagem é um pedido para SAIR do modo foco. */
export function isCancelFocusRequest(text: string): boolean {
  const t = text.toLowerCase();
  return /(sair|encerrar|terminar|parar|desativar|cancelar|tirar|desliga(r)?)\s+(d?o\s+|do\s+)?(modo\s*)?foco|fim\s+do\s+foco/.test(
    t
  );
}

/** True se a mensagem é um pedido para entrar em modo foco. */
export function isFocusRequest(text: string): boolean {
  // Não confundir um pedido de SAIR com um de entrar.
  if (isCancelFocusRequest(text)) return false;
  const t = text.toLowerCase();
  return /modo\s*foco|entrar\s+em\s+foco|\bfoco\s+por\b|\bfoca(r)?\b|me\s+foca/.test(t);
}

/**
 * Extrai a duração (minutos) de frases como "foco por 2h", "1h30", "90 min".
 * Soma horas e minutos quando vierem juntos ("1h30" → 90).
 */
function parseFocusMinutes(text: string): number {
  const t = text.toLowerCase();
  const h = t.match(/(\d+(?:[.,]\d+)?)\s*h(?:oras?)?/);
  // Minutos: ou explícitos ("30 min") ou logo após a hora ("1h30").
  const m = t.match(/(\d+)\s*(?:min|minutos?)\b/) || (h ? t.match(/\dh\s*(\d{1,2})\b/) : null);
  let total = 0;
  if (h) total += parseFloat(h[1].replace(',', '.')) * 60;
  if (m) total += parseInt(m[1], 10);
  return total > 0 ? Math.round(total) : DEFAULT_FOCUS_MINUTES;
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
  const fim = timeKey(new Date(endsAt));
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
  // Segura a mensagem DE VERDADE para reapresentar no fim do foco.
  holdMessage(contact, text);
  const fim = timeKey(new Date(session.endsAt));
  return {
    active: true,
    reply: `🔕 Você está em modo foco até ${fim}. Guardei sua mensagem e te mostro quando o foco acabar — me chame com "urgente" (ou peça para "sair do foco") se precisar. 🙂`,
  };
}

/** Encerra a sessão de foco do contato a pedido dele. Retorna a resposta. */
export async function cancelFocus(contact: string): Promise<string> {
  const session = await getFocus(contact);
  if (!session || session.ended || session.endsAt <= Date.now()) {
    return 'Você não está em modo foco agora. 🙂';
  }
  await endFocus(contact);
  return `✅ *Modo foco encerrado.* Pode mandar o que precisar.${flushHeld(contact)}`;
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
    await sendText(s.contact, `✅ *Modo foco encerrado.* Como foi?${flushHeld(s.contact)}`);
    console.log(`[focus] foco encerrado para ${s.contact}`);
  }
}
