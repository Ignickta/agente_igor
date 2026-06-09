import { chat, ChatMessage } from '../services/openai';

/**
 * Estima a duração de uma tarefa (em minutos) a partir do título e tipo, usando
 * o LLM. Retorna um número arredondado em faixas razoáveis (15–480 min) ou
 * undefined se não der para estimar — nunca lança, para não bloquear a criação.
 */
export async function estimateDurationMinutes(
  title: string,
  type = 'task'
): Promise<number | undefined> {
  const t = title.trim();
  if (!t) return undefined;

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'Você estima quanto tempo uma tarefa leva. Responda APENAS com um número inteiro de ' +
        'minutos (sem texto, sem unidade). Seja realista: tarefas rápidas 15–30, médias 45–90, ' +
        'grandes 120–240. Considere o tipo informado.',
    },
    { role: 'user', content: `Tipo: ${type}\nTarefa: "${t}"\nDuração estimada em minutos:` },
  ];

  try {
    const answer = await chat(messages, { temperature: 0 });
    const n = parseInt(answer.replace(/\D/g, ''), 10);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    // Limita a faixas sãs (15 min a 8h) e arredonda a múltiplos de 5.
    return Math.min(480, Math.max(15, Math.round(n / 5) * 5));
  } catch (err) {
    console.error('[estimate] falha ao estimar duração:', err instanceof Error ? err.message : err);
    return undefined;
  }
}
