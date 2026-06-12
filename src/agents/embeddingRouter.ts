import { Subagent } from '../types';
import { config } from '../config';
import { embed } from '../services/openai';
import { embedQuery, cosine } from '../services/memory';

/**
 * Roteamento por embedding: degrau entre o keyword match (grátis, mas exige 2
 * keywords) e o LLM (preciso, mas custa uma chamada por mensagem). Compara o
 * embedding da mensagem com o descritor de cada subagente e decide sozinho
 * quando a semelhança é forte E com folga sobre o segundo colocado.
 *
 * Custo: o embedding da mensagem vem do MESMO cache que recallFacts e o RAG
 * usam (embedQuery) — continua uma chamada de embedding por mensagem. Os
 * descritores dos subagentes são embedados uma vez e cacheados (invalidado se
 * o subagente for editado, pois a chave inclui o texto do descritor).
 */

/** Texto que representa o subagente no espaço de embeddings. */
function descriptor(sub: Subagent): string {
  return `${sub.name}\nTemas: ${sub.keywords.join(', ')}\n${sub.prompt.slice(0, 500)}`;
}

const descriptorCache = new Map<string, { text: string; embedding: number[] }>();

async function subagentEmbedding(sub: Subagent): Promise<number[]> {
  const text = descriptor(sub);
  const hit = descriptorCache.get(sub.id);
  if (hit && hit.text === text) return hit.embedding;
  const embedding = await embed(text);
  descriptorCache.set(sub.id, { text, embedding });
  return embedding;
}

export interface EmbeddingRoute {
  sub: Subagent;
  /** Similaridade do 1º colocado com a mensagem. */
  score: number;
  /** Folga sobre o 2º colocado (0 se só houver um subagente). */
  margin: number;
  /** True quando score e margem passam dos limiares — pode rotear sem LLM. */
  decided: boolean;
}

/**
 * Mensagens curtas ("e amanhã?", "muda pra 15h") são continuações de assunto:
 * embedding não tem sinal nelas e a continuidade (última rota) decide melhor
 * via LLM. Abaixo deste tamanho, nem tenta.
 */
const MIN_TEXT_LEN = 15;

/**
 * Pisos para o palpite virar DICA ao roteador LLM (sem decidir sozinho).
 * Calibrado com a API real: um top-1 com margem ~0.003 ("remédio da mãe" caiu
 * em Vendas de Arroz) é ruído — dica errada vicia o LLM. Abaixo dos pisos, o
 * LLM decide sem dica.
 */
const HINT_MIN_SIM = 0.35;
const HINT_MIN_MARGIN = 0.05;

/** Palpite confiável o bastante para virar dica ao LLM, ou null. */
export function hintFrom(route: EmbeddingRoute | null): Subagent | null {
  if (!route) return null;
  return route.score >= HINT_MIN_SIM && route.margin >= HINT_MIN_MARGIN ? route.sub : null;
}

/**
 * Classifica a mensagem contra todos os subagentes. Retorna o melhor candidato
 * com score/margem e se a confiança basta para decidir sem LLM. Best-effort:
 * nunca lança; em erro (ou mensagem curta demais), retorna null.
 */
export async function routeByEmbedding(
  text: string,
  subagents: Subagent[]
): Promise<EmbeddingRoute | null> {
  if (text.trim().length < MIN_TEXT_LEN || subagents.length === 0) return null;
  try {
    const [msgEmb, subEmbs] = await Promise.all([
      embedQuery(text),
      Promise.all(subagents.map(subagentEmbedding)),
    ]);
    if (!msgEmb.length) return null;

    const ranked = subagents
      .map((sub, i) => ({ sub, score: cosine(msgEmb, subEmbs[i]) }))
      .sort((a, b) => b.score - a.score);

    const top = ranked[0];
    const margin = ranked.length > 1 ? top.score - ranked[1].score : top.score;
    const decided =
      top.score >= config.embeddingRouting.minSim &&
      margin >= config.embeddingRouting.minMargin;

    return { sub: top.sub, score: top.score, margin, decided };
  } catch (err) {
    console.error('[embeddingRouter] falha (caindo para o LLM):', err);
    return null;
  }
}
