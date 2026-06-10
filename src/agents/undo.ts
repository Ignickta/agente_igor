/**
 * Desfazer: cada ação de escrita das tools (criar/editar/remover lembrete,
 * reorganizar agenda...) registra aqui sua reversão. "Desfaz isso" vira a
 * execução das reversões do último GRUPO — uma mensagem do usuário pode gerar
 * várias escritas (ex: "organiza minha tarde" cria 4 lembretes), e desfazer só
 * a última seria mentir que desfez tudo. Em memória, por contato (zera num
 * restart — aceitável para uma janela de arrependimento curta).
 */
interface UndoEntry {
  /** Descrição curta do que foi feito, para a mensagem de confirmação. */
  description: string;
  /** Função que reverte a ação. */
  revert: () => Promise<void>;
  at: number;
  /** Grupo = uma mensagem do usuário; "desfazer" reverte o grupo inteiro. */
  group: number;
}

const stacks = new Map<string, UndoEntry[]>();
const groupSeq = new Map<string, number>();
const MAX_ENTRIES = 10;

/**
 * Abre um novo grupo de undo para o contato. Chamado a cada mensagem recebida:
 * tudo que as tools escreverem ao atendê-la cai no mesmo grupo.
 */
export function beginUndoGroup(contact: string): void {
  if (!contact) return;
  groupSeq.set(contact, (groupSeq.get(contact) ?? 0) + 1);
}

/** Registra uma ação desfazível para o contato (no grupo atual). */
export function recordUndo(
  contact: string,
  description: string,
  revert: () => Promise<void>
): void {
  if (!contact) return;
  const stack = stacks.get(contact) ?? [];
  stack.push({ description, revert, at: Date.now(), group: groupSeq.get(contact) ?? 0 });
  if (stack.length > MAX_ENTRIES) stack.shift();
  stacks.set(contact, stack);
}

/**
 * Desfaz o grupo de ações mais recente do contato (todas as escritas feitas ao
 * atender a última mensagem), na ordem inversa. Retorna a mensagem de resultado,
 * honesta sobre o que reverteu e o que falhou.
 */
export async function undoLast(contact: string): Promise<string> {
  const stack = stacks.get(contact) ?? [];
  if (stack.length === 0) return 'Não há nenhuma ação recente para desfazer.';

  const group = stack[stack.length - 1].group;
  const entries: UndoEntry[] = [];
  while (stack.length > 0 && stack[stack.length - 1].group === group) {
    entries.push(stack.pop()!); // já sai do mais recente para o mais antigo
  }

  const done: string[] = [];
  const failed: string[] = [];
  for (const e of entries) {
    try {
      await e.revert();
      done.push(e.description);
    } catch (err) {
      console.error('[undo] falha ao desfazer:', err);
      failed.push(e.description);
    }
  }

  if (done.length === 0) {
    return `Não consegui desfazer ${failed.join('; ')} — algo mudou desde então.`;
  }
  const msg = `Desfeito: ${done.join('; ')}.`;
  return failed.length > 0 ? `${msg}\n⚠️ Não consegui desfazer: ${failed.join('; ')}.` : msg;
}
