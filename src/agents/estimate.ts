import { chatJson, ChatMessage } from '../services/openai';
import { config } from '../config';

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
        'Você estima quanto tempo uma tarefa leva, em minutos. Seja realista: tarefas ' +
        'rápidas 15–30, médias 45–90, grandes 120–240. Considere o tipo informado.',
    },
    { role: 'user', content: `Tipo: ${type}\nTarefa: "${t}"\nDuração estimada em minutos:` },
  ];

  try {
    const result = await chatJson<{ minutos: number }>(messages, {
      name: 'estimativa_duracao',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['minutos'],
        properties: {
          minutos: { type: 'integer', description: 'Duração estimada em minutos' },
        },
      },
      temperature: 0,
      // Estimar duração é tarefa utilitária — não precisa do modelo principal.
      model: config.openai.utilityModel,
    });
    const n = result?.minutos;
    if (!n || !Number.isFinite(n) || n <= 0) return undefined;
    // Limita a faixas sãs (15 min a 8h) e arredonda a múltiplos de 5.
    return Math.min(480, Math.max(15, Math.round(n / 5) * 5));
  } catch (err) {
    console.error('[estimate] falha ao estimar duração:', err instanceof Error ? err.message : err);
    return undefined;
  }
}
