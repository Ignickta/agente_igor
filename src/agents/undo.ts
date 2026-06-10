/**
 * Desfazer: cada ação de escrita das tools (criar/editar/remover lembrete,
 * reorganizar agenda...) registra aqui sua reversão. "Desfaz isso" vira a
 * execução da última reversão registrada. Em memória, por contato (zera num
 * restart — aceitável para uma janela de arrependimento curta).
 */
interface UndoEntry {
  /** Descrição curta do que foi feito, para a mensagem de confirmação. */
  description: string;
  /** Função que reverte a ação. */
  revert: () => Promise<void>;
  at: number;
}

const stacks = new Map<string, UndoEntry[]>();
const MAX_ENTRIES = 5;

/** Registra uma ação desfazível para o contato. */
export function recordUndo(
  contact: string,
  description: string,
  revert: () => Promise<void>
): void {
  if (!contact) return;
  const stack = stacks.get(contact) ?? [];
  stack.push({ description, revert, at: Date.now() });
  if (stack.length > MAX_ENTRIES) stack.shift();
  stacks.set(contact, stack);
}

/** Desfaz a ação mais recente do contato. Retorna a mensagem de resultado. */
export async function undoLast(contact: string): Promise<string> {
  const stack = stacks.get(contact) ?? [];
  const entry = stack.pop();
  if (!entry) return 'Não há nenhuma ação recente para desfazer.';
  try {
    await entry.revert();
    return `Desfeito: ${entry.description}.`;
  } catch (err) {
    console.error('[undo] falha ao desfazer:', err);
    return `Não consegui desfazer "${entry.description}" — algo mudou desde então.`;
  }
}
