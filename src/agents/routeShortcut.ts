import { Subagent } from '../types';
import { config } from '../config';
import { embedQuery, cosine } from '../services/memory';
import { saveRouteExample, getRouteExamples, RouteExample } from '../services/firebase';

/**
 * Atalho de roteamento APRENDIDO.
 *
 * Toda vez que o Igor corrige a rota ("não, isso é do projeto X"), guardamos um
 * exemplo rotulado: a mensagem mal roteada → o subagente certo (com embedding).
 * Numa mensagem nova MUITO parecida com algum exemplo, roteamos direto pro
 * subagente certo, na hora — sem esperar a rotina semanal de keywords e sem
 * pedir confirmação. O piso de similaridade é alto (config.learnedRouting.minSim)
 * para nunca desviar uma mensagem legítima por engano.
 *
 * Custo zero de API extra: o embedding da mensagem sai do MESMO cache que o RAG
 * e o roteador por embedding usam (embedQuery).
 */

/**
 * Cache em memória dos exemplos por contato, para não ler o Firestore a cada
 * mensagem. Invalidado por TTL curto e imediatamente após aprender um novo.
 */
const examplesCache = new Map<string, { at: number; items: RouteExample[] }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function loadExamples(contact: string): Promise<RouteExample[]> {
  const hit = examplesCache.get(contact);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.items;
  const items = await getRouteExamples(contact);
  examplesCache.set(contact, { at: Date.now(), items });
  return items;
}

/**
 * Registra um exemplo aprendido a partir de uma correção. Best-effort: nunca
 * lança (uma falha aqui não pode quebrar o atendimento). Invalida o cache do
 * contato para o próximo turno já enxergar o exemplo novo.
 */
export async function learnRouteExample(
  contact: string,
  text: string,
  correctSub: Subagent
): Promise<void> {
  try {
    const trimmed = text.trim();
    if (trimmed.length < 15) return; // mensagens curtas não têm sinal semântico
    const embedding = await embedQuery(trimmed);
    if (!embedding.length) return;
    await saveRouteExample({
      contact,
      text: trimmed.slice(0, 500),
      embedding,
      subagentId: correctSub.id,
      subagentName: correctSub.name,
      at: Date.now(),
    });
    examplesCache.delete(contact);
  } catch (err) {
    console.error('[routeShortcut] falha ao aprender exemplo:', err);
  }
}

export interface LearnedRoute {
  sub: Subagent;
  /** Similaridade com o exemplo mais parecido. */
  score: number;
}

/**
 * Tenta rotear pela memória de correções. Retorna o subagente certo quando a
 * mensagem é suficientemente parecida com um exemplo aprendido E esse subagente
 * ainda existe/está ativo. Best-effort: em erro ou sem match forte, retorna null
 * e a cascata segue para o embedding/LLM.
 */
export async function routeByLearnedExample(
  contact: string,
  text: string,
  subagents: Subagent[]
): Promise<LearnedRoute | null> {
  try {
    const trimmed = text.trim();
    if (trimmed.length < 15 || subagents.length === 0) return null;
    const examples = await loadExamples(contact);
    if (examples.length === 0) return null;

    const msgEmb = await embedQuery(trimmed);
    if (!msgEmb.length) return null;

    let best: { ex: RouteExample; score: number } | null = null;
    for (const ex of examples) {
      if (!ex.embedding?.length) continue;
      const score = cosine(msgEmb, ex.embedding);
      if (!best || score > best.score) best = { ex, score };
    }
    if (!best || best.score < config.learnedRouting.minSim) return null;

    // O subagente aprendido pode ter sido renomeado/desativado/removido.
    const sub = subagents.find((s) => s.id === best!.ex.subagentId);
    if (!sub) return null;

    return { sub, score: best.score };
  } catch (err) {
    console.error('[routeShortcut] falha ao rotear por exemplo:', err);
    return null;
  }
}
