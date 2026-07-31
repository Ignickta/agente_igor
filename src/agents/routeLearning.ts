import { config } from '../config';
import { chatJson } from '../services/openai';
import { sendText } from '../services/evolution';
import { listSubagents, getRouteMisses, saveRouteSuggestion } from '../services/firebase';
import { proactiveMuted } from './pause';

/**
 * F9: aprendizado de erros de roteamento. A detecção (central.ts) registra
 * toda correção rápida como possível miss — generosa de propósito. Aqui, uma
 * vez por semana, o LLM separa "rota errada de verdade" de "correção de
 * conteúdo" e sugere keywords novas por subagente. As sugestões NÃO são
 * aplicadas sozinhas: vão ao Igor pelo WhatsApp e ele confirma (a tool
 * aplicar_sugestoes_roteamento aplica, com undo).
 */

/** Palavras genéricas demais para virar keyword de roteamento. */
const GENERIC_KEYWORDS = new Set([
  'hoje',
  'amanhã',
  'amanha',
  'agenda',
  'agora',
  'dia',
  'semana',
  'mês',
  'mes',
  'lembrete',
  'tarefa',
  'coisa',
  'isso',
  'aquilo',
]);

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['analises'],
  properties: {
    analises: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['indice', 'subagenteCorreto', 'keywords'],
        properties: {
          indice: { type: 'integer', description: 'Número do caso analisado (1-based)' },
          subagenteCorreto: {
            type: ['string', 'null'],
            description: 'Nome EXATO do subagente certo, ou null se a rota estava certa',
          },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'Até 3 palavras curtas da mensagem que indicariam a rota certa',
          },
        },
      },
    },
  },
};

interface RouteAnalysis {
  analises: { indice: number; subagenteCorreto: string | null; keywords: string[] }[];
}

/**
 * Analisa os misses da última semana e, havendo sugestões válidas, salva como
 * pendentes e avisa o Igor. Silencioso quando não há nada útil.
 */
export async function sendRouteLearningReport(): Promise<void> {
  if (!config.ownerPhone || !config.proactiveNotifications) return;
  if (await proactiveMuted(config.ownerPhone)) return;

  const misses = await getRouteMisses(Date.now() - 7 * 86400000);
  if (misses.length === 0) return;

  const subs = await listSubagents();
  if (subs.length === 0) return;

  const casos = misses.slice(0, 20);
  const lista = casos
    .map(
      (m, i) =>
        `${i + 1}. Mensagem: "${m.text.slice(0, 200)}" → roteada para "${m.routedToName}". ` +
        `Correção do Igor logo depois: "${m.correction.slice(0, 200)}"` +
        (m.suggestedCorrectName
          ? ` (a conversa seguiu no subagente "${m.suggestedCorrectName}")`
          : '')
    )
    .join('\n');
  const subsDesc = subs.map((s) => `- ${s.name} — keywords atuais: ${s.keywords.join(', ')}`).join('\n');

  const system = `Você audita o roteamento de um agente pessoal multi-subagente. Receberá casos em
que o Igor corrigiu o agente logo após uma resposta — alguns são erro de ROTEAMENTO (a mensagem
caiu no subagente errado), outros são correção de CONTEÚDO (a rota estava certa).

Para cada caso: se a rota estava certa ou houver dúvida, "subagenteCorreto": null. Só aponte um
subagente quando for CLARO que a mensagem pertencia a outra área. Nesse caso, sugira até 3
keywords CURTAS e específicas, presentes (ou quase) na mensagem original, que teriam roteado
certo — nunca palavras genéricas (hoje, agenda, tarefa...) nem keywords que o subagente já tem.
Seja conservador: melhor nenhuma sugestão do que keyword ruim poluindo o roteamento.`;

  const user = `Casos da semana:\n${lista}\n\nSubagentes disponíveis:\n${subsDesc}\n\nAnálise:`;

  const result = await chatJson<RouteAnalysis>(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { name: 'analise_roteamento', schema: ANALYSIS_SCHEMA, temperature: 0, model: config.openai.utilityModel }
  );
  if (!result || !Array.isArray(result.analises)) return;

  // Agrega keywords válidas por subagente alvo (dedup, sem genéricas, sem repetidas).
  const byName = new Map(subs.map((s) => [s.name.toLowerCase(), s]));
  const porSubagente = new Map<string, Set<string>>();
  for (const a of result.analises) {
    if (!a.subagenteCorreto) continue;
    const alvo = byName.get(String(a.subagenteCorreto).toLowerCase());
    if (!alvo) continue;
    const caso = casos[a.indice - 1];
    if (caso && alvo.name === caso.routedToName) continue; // "certo" = onde já caiu, nada a fazer
    const atuais = new Set(alvo.keywords.map((k) => k.toLowerCase()));
    for (const kw of (Array.isArray(a.keywords) ? a.keywords : []).slice(0, 3)) {
      const k = String(kw).trim().toLowerCase();
      if (!k || k.length < 3 || GENERIC_KEYWORDS.has(k) || atuais.has(k)) continue;
      const set = porSubagente.get(alvo.id) ?? new Set<string>();
      set.add(k);
      porSubagente.set(alvo.id, set);
    }
  }
  if (porSubagente.size === 0) return;

  const items = [...porSubagente.entries()].map(([subagentId, kws]) => ({
    subagentId,
    subagentName: subs.find((s) => s.id === subagentId)!.name,
    keywords: [...kws],
  }));
  await saveRouteSuggestion(items);

  const resumo = items
    .map((i) => `• *${i.subagentName}*: ${i.keywords.map((k) => `"${k}"`).join(', ')}`)
    .join('\n');
  await sendText(
    config.ownerPhone,
    `🧭 *Aprendizado de roteamento*\n\nEsta semana notei ${casos.length} ` +
      `${casos.length === 1 ? 'mensagem que pode ter caído' : 'mensagens que podem ter caído'} ` +
      `no agente errado. Para melhorar, sugiro adicionar estas palavras-chave:\n\n${resumo}\n\n` +
      `_Quer que eu aplique? É só dizer "aplica as sugestões de roteamento"._`
  );
  console.log(`[routeLearning] sugestões enviadas (${items.length} subagentes).`);
}
