/**
 * Debounce de rajada por contato. No WhatsApp é comum o usuário quebrar um
 * pedido em várias mensagens seguidas ("coloque tudo na agenda" / "tarefa 1" /
 * "tarefa 2"). Sem agrupar, cada mensagem virava uma execução isolada do
 * agente — daí as respostas em dobro com agendas conflitantes.
 *
 * Estratégia: trailing debounce. Cada mensagem de texto entra num buffer por
 * contato e reinicia um timer curto; quando o timer dispara (silêncio), o
 * texto acumulado é processado de uma vez só. Um teto de tempo total garante
 * que uma sequência longa e ininterrupta ainda seja processada.
 *
 * Só para TEXTO simples: áudio/mídia seguem o caminho direto (chegam como uma
 * unidade e juntar conteúdo extraído confundiria mais do que ajudaria).
 *
 * Em memória: um restart perde buffers pendentes (janela de segundos, ok). Não
 * há concorrência real entre contatos — o Node é single-threaded e os timers
 * rodam no mesmo event loop.
 */

/** Silêncio (ms) após a última mensagem antes de processar o lote. */
const QUIET_WINDOW_MS = 9000;
/** Teto (ms) desde a 1ª mensagem do lote — evita esperar indefinidamente numa rajada contínua. */
const MAX_WAIT_MS = 30000;

interface Pending {
  parts: string[];
  /** Timer do silêncio (reiniciado a cada mensagem). */
  quietTimer: NodeJS.Timeout;
  /** Timer do teto absoluto (definido uma vez, na 1ª mensagem). */
  hardTimer: NodeJS.Timeout;
  /** Quem processa o lote quando fecha. */
  flush: (text: string) => void;
}

const buffers = new Map<string, Pending>();

/**
 * Enfileira uma mensagem de texto do contato. Quando a rajada fecha (silêncio
 * de QUIET_WINDOW_MS ou teto de MAX_WAIT_MS), chama `onFlush` UMA vez com o
 * texto concatenado de todas as mensagens do lote, na ordem de chegada.
 *
 * Reusa o `onFlush` da primeira mensagem do lote; mensagens subsequentes só
 * acrescentam texto e empurram o silêncio.
 */
export function enqueueMessage(
  contact: string,
  text: string,
  onFlush: (text: string) => void
): void {
  const existing = buffers.get(contact);

  if (existing) {
    existing.parts.push(text);
    clearTimeout(existing.quietTimer);
    existing.quietTimer = setTimeout(() => closeBuffer(contact), QUIET_WINDOW_MS);
    return;
  }

  const pending: Pending = {
    parts: [text],
    flush: onFlush,
    quietTimer: setTimeout(() => closeBuffer(contact), QUIET_WINDOW_MS),
    hardTimer: setTimeout(() => closeBuffer(contact), MAX_WAIT_MS),
  };
  buffers.set(contact, pending);
}

/** Fecha o buffer do contato e dispara o processamento do lote acumulado. */
function closeBuffer(contact: string): void {
  const pending = buffers.get(contact);
  if (!pending) return;
  clearTimeout(pending.quietTimer);
  clearTimeout(pending.hardTimer);
  buffers.delete(contact);

  // Junta as partes numa mensagem só. Quebra de linha preserva a separação
  // que o usuário fez (listas, itens), sem colar palavras de mensagens distintas.
  const merged = pending.parts.join('\n').trim();
  if (merged) pending.flush(merged);
}
