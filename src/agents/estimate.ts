import { chatJson, ChatMessage } from '../services/openai';
import { config } from '../config';
import { getMeasuredAgendaItems } from '../services/firebase';

/** Janela de histórico considerada na calibração. */
const CALIBRATION_WINDOW_MS = 60 * 86400000; // 60 dias

/**
 * Duração real (minutos) a partir do par startedAt→completedAt, com sanidade:
 * < 3 min é toque acidental, > 8h é item esquecido aberto — ambos viram null
 * para não contaminar a calibração. Pura e exportada para os evals.
 */
export function realDurationMinutes(
  startedAt?: number,
  completedAt?: number | null
): number | null {
  if (!startedAt || !completedAt || completedAt <= startedAt) return null;
  const min = Math.round((completedAt - startedAt) / 60000);
  if (min < 3 || min > 480) return null;
  return min;
}

const EXAMPLES_TTL_MS = 10 * 60 * 1000;
let examplesCache: { text: string; at: number } | null = null;

/**
 * Few-shot de durações REAIS medidas nas últimas semanas, para o modelo
 * calibrar estimativas pelo comportamento do Igor, não por chute genérico.
 * '' enquanto não houver medições — a feature "liga" sozinha com o uso.
 */
export async function durationExamples(): Promise<string> {
  if (examplesCache && Date.now() - examplesCache.at < EXAMPLES_TTL_MS) {
    return examplesCache.text;
  }
  try {
    const items = await getMeasuredAgendaItems(Date.now() - CALIBRATION_WINDOW_MS, 40);
    const linhas: string[] = [];
    for (const i of items) {
      const real = realDurationMinutes(i.startedAt, i.completedAt);
      if (real === null) continue;
      const est = i.estimatedMinutes ? `estimado ${i.estimatedMinutes} min → ` : '';
      linhas.push(`- "${i.title}": ${est}real ${real} min`);
      if (linhas.length >= 8) break;
    }
    const text = linhas.join('\n');
    examplesCache = { text, at: Date.now() };
    return text;
  } catch (err) {
    console.error('[estimate] falha ao buscar durações medidas:', err);
    return examplesCache?.text ?? '';
  }
}

/**
 * Resumo da calibração (razão real/estimado) para o aprendizado de padrões do
 * cronograma. '' com menos de 4 medições que tenham estimativa.
 */
export async function calibrationSummary(): Promise<string> {
  try {
    const items = await getMeasuredAgendaItems(Date.now() - CALIBRATION_WINDOW_MS, 60);
    const ratios: number[] = [];
    for (const i of items) {
      const real = realDurationMinutes(i.startedAt, i.completedAt);
      if (real === null || !i.estimatedMinutes) continue;
      ratios.push(real / i.estimatedMinutes);
    }
    if (ratios.length < 4) return '';
    const media = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    return `- Tarefas levam em média ${media.toFixed(1)}× o tempo estimado (${ratios.length} medições).`;
  } catch (err) {
    console.error('[estimate] falha no resumo de calibração:', err);
    return '';
  }
}

/**
 * Estima a duração de uma tarefa (em minutos) a partir do título e tipo, usando
 * o LLM calibrado pelas durações reais medidas. Retorna um número arredondado
 * em faixas razoáveis (15–480 min) ou undefined se não der para estimar —
 * nunca lança, para não bloquear a criação.
 */
export async function estimateDurationMinutes(
  title: string,
  type = 'task'
): Promise<number | undefined> {
  const t = title.trim();
  if (!t) return undefined;

  const exemplos = await durationExamples();
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'Você estima quanto tempo uma tarefa leva, em minutos. Seja realista: tarefas ' +
        'rápidas 15–30, médias 45–90, grandes 120–240. Considere o tipo informado.' +
        (exemplos
          ? `\n\nDurações REAIS medidas de tarefas recentes do Igor — calibre por elas, ` +
            `principalmente quando a tarefa for parecida:\n${exemplos}`
          : ''),
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
