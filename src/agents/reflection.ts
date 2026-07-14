import { chatJson, ChatMessage } from '../services/openai';
import { getConversationLog } from '../services/firebase';
import { rememberFact, formatEntry } from '../services/memory';

/**
 * Identificador de origem gravado em fatos pela reflexão (no campo subagentId,
 * que aqui marca a procedência, não um subagente real).
 */
export const REFLECTION_ORIGIN_ID = 'reflexao-diaria';

/**
 * Reflexão diária: relê as conversas das últimas 24h e extrai o que ficou para
 * trás. Ela captura somente fatos duradouros que não foram salvos durante a
 * conversa. Tarefas e lembretes exigem uma ação explícita do Igor na conversa
 * ou no painel; a reflexão nunca inventa prazo, horário ou subtarefa.
 */

interface ReflectionResult {
  fatos: string[];
}

/** Schema estrito da reflexão (Structured Outputs). */
const REFLECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fatos'],
  properties: {
    fatos: { type: 'array', items: { type: 'string' } },
  },
};

/** Janela de releitura: as últimas 24h (o job roda 1x/dia — sem sobreposição). */
const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Teto de caracteres das conversas no prompt (dias muito falados não estouram). */
const MAX_CONVO_CHARS = 24000;
const MAX_FACTS = 8;

/**
 * Roda a reflexão para um contato. Best-effort: nunca lança; retorna contagens
 * para o log do job. O campo reminders é mantido como zero por compatibilidade
 * com o scheduler e os logs antigos.
 */
export async function reflectOnRecentExchanges(
  contact: string
): Promise<{ facts: number; reminders: number }> {
  const since = Date.now() - WINDOW_MS;
  const all = await getConversationLog(contact);
  const recent = all
    .filter((e) => e.timestamp >= since)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (recent.length === 0) return { facts: 0, reminders: 0 };

  const convo = recent
    .map((e) => formatEntry(e))
    .join('\n\n')
    .slice(-MAX_CONVO_CHARS); // corta pelo INÍCIO: o fim do dia é o mais fresco

  const system = `Você é a reflexão noturna do agente pessoal do Igor. Releia as conversas das
últimas 24 horas e extraia SOMENTE:

1. FATOS duradouros que valem memória de longo prazo: decisões tomadas, preferências
   reveladas, dados de projetos/clientes, mudanças de contexto. NÃO inclua trivialidades,
   suposições suas, nem coisas pontuais que perdem valor em poucos dias.

NUNCA crie, sugira ou extraia tarefas, lembretes, horários, planos, prioridades ou subtarefas.
Mesmo que o Igor tenha dito que fará algo amanhã, isso não é um fato de longo prazo. Em caso de
dúvida, deixe a lista vazia. No máximo ${MAX_FACTS} fatos.`;

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `Conversas das últimas 24h:\n\n${convo}\n\nExtraia apenas fatos duradouros:`,
    },
  ];

  const result = await chatJson<ReflectionResult>(messages, {
    name: 'reflexao_diaria',
    schema: REFLECTION_SCHEMA,
    temperature: 0,
  });
  if (!result) return { facts: 0, reminders: 0 };

  let facts = 0;
  for (const f of (Array.isArray(result.fatos) ? result.fatos : []).slice(0, MAX_FACTS)) {
    const texto = String(f || '').trim();
    if (!texto) continue;
    try {
      await rememberFact(contact, REFLECTION_ORIGIN_ID, texto);
      facts++;
    } catch (err) {
      console.error('[reflection] falha ao salvar fato:', err);
    }
  }

  return { facts, reminders: 0 };
}
