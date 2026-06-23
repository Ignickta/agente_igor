import { config } from '../config';
import { chatJson, ChatMessage } from '../services/openai';
import { getConversationLog, listTasks, createTask } from '../services/firebase';
import { rememberFact, formatEntry } from '../services/memory';
import { dayKey, timeKey, addDays, parseLocalIso } from '../services/datetime';

/**
 * Identificador de origem gravado em fatos e follow-ups criados pela reflexão
 * (no campo subagentId, que aqui marca a procedência, não um subagente real).
 */
export const REFLECTION_ORIGIN_ID = 'reflexao-diaria';

/**
 * Reflexão diária: relê as conversas das últimas 24h e extrai o que ficou para
 * trás. O agente só salva fato quando lembra de chamar salvar_fato e só cria
 * lembrete quando o Igor pede — promessas soltas ("amanhã eu ligo pro João")
 * morriam na conversa. A reflexão fecha esse vazamento:
 *  - FATOS duradouros não capturados viram memória (e a consolidação, que roda
 *    logo depois na mesma noite, deduplica contra o que já existe).
 *  - PROMESSAS com ação futura sem lembrete viram follow-up automático.
 */

interface ReflectionResult {
  fatos: string[];
  promessas: { texto: string; quando_iso: string | null }[];
}

/** Schema estrito da reflexão (Structured Outputs). */
const REFLECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fatos', 'promessas'],
  properties: {
    fatos: { type: 'array', items: { type: 'string' } },
    promessas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['texto', 'quando_iso'],
        properties: {
          texto: {
            type: 'string',
            description:
              'O que lembrar, na voz do lembrete, COM o contexto/motivo da conversa ' +
              '(assunto, pessoa, projeto) — autoexplicativo dias depois, não só a ação.',
          },
          quando_iso: {
            type: ['string', 'null'],
            description: 'Data/hora LOCAL ISO 8601 sem offset (ex: 2026-06-13T09:00:00), ou null',
          },
        },
      },
    },
  },
};

/** Janela de releitura: as últimas 24h (o job roda 1x/dia — sem sobreposição). */
const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Teto de caracteres das conversas no prompt (dias muito falados não estouram). */
const MAX_CONVO_CHARS = 24000;
const MAX_FACTS = 8;
const MAX_PROMISES = 5;

/**
 * Roda a reflexão para um contato. Best-effort: nunca lança; retorna contagens
 * para o log do job. Lembretes de promessa respeitam o kill-switch de
 * proatividade (são mensagens futuras que o Igor não pediu explicitamente).
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

  // Lembretes que já existem — a reflexão não pode recriar o que a conversa
  // já agendou (o agente costuma criar na hora via criar_lembrete).
  const pendentes = (await listTasks())
    .filter((t) => !t.done)
    .slice(0, 30)
    .map((t) => {
      const d = new Date(t.remindAt);
      return `- ${dayKey(d)} ${timeKey(d)}: ${t.text}`;
    })
    .join('\n');

  const hoje = dayKey();
  const amanha = addDays(hoje, 1);

  const system = `Você é a reflexão noturna do agente pessoal do Igor. Releia as conversas das
últimas 24 horas e extraia SOMENTE:

1. FATOS duradouros que valem memória de longo prazo: decisões tomadas, preferências
   reveladas, dados de projetos/clientes, mudanças de contexto. NÃO inclua trivialidades,
   suposições suas, nem coisas pontuais que perdem valor em poucos dias.
2. PROMESSAS do Igor com ação futura clara ("vou ligar pro João amanhã", "semana que vem
   reviso o contrato") que ainda NÃO têm lembrete — a lista de lembretes existentes está
   abaixo; não repita nenhum deles, nem reformulado. Escreva o texto na forma de lembrete
   INCLUINDO O CONTEXTO/MOTIVO da conversa, não só a ação seca: o lembrete deve fazer
   sentido sozinho dias depois. Ex.: em vez de "Ligar para o João", escreva "Ligar para o
   João sobre o orçamento da reforma da clínica que ele ia mandar". Puxe o porquê, o
   assunto e quem/o quê estava envolvido a partir da conversa.

Para cada promessa, defina quando_iso (data e hora LOCAIS, ISO 8601 sem offset, ex:
${amanha}T09:00:00) com o melhor momento para lembrar. Hoje é ${hoje}; amanhã é ${amanha} —
parta SEMPRE destas datas. Sem prazo claro na fala, use null.

Seja MUITO conservador: listas vazias são uma ótima resposta. No máximo ${MAX_FACTS} fatos e
${MAX_PROMISES} promessas.`;

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `Conversas das últimas 24h:\n\n${convo}\n\nLembretes já existentes (NÃO repetir):\n${
        pendentes || '(nenhum)'
      }\n\nExtraia fatos e promessas:`,
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

  let reminders = 0;
  if (config.proactiveNotifications) {
    const promessas = Array.isArray(result.promessas) ? result.promessas : [];
    for (const p of promessas.slice(0, MAX_PROMISES)) {
      const texto = String(p?.texto || '').trim();
      if (!texto) continue;
      // Sem prazo (ou prazo no passado): hoje às 09:00; se 09:00 já passou
      // (job rodando fora de hora), amanhã às 09:00.
      let when = p?.quando_iso ? parseLocalIso(String(p.quando_iso)) : new Date(NaN);
      if (isNaN(when.getTime()) || when.getTime() <= Date.now()) {
        when = parseLocalIso(`${hoje}T09:00:00`);
        if (when.getTime() <= Date.now()) when = parseLocalIso(`${amanha}T09:00:00`);
      }
      try {
        await createTask({
          text: texto,
          remindAt: when.toISOString(),
          to: contact,
          subagentId: REFLECTION_ORIGIN_ID,
        });
        reminders++;
      } catch (err) {
        console.error('[reflection] falha ao criar follow-up:', err);
      }
    }
  }

  return { facts, reminders };
}
