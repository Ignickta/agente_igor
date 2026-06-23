import { embed, chatJson } from './openai';
import {
  saveSharedFact,
  getSharedFacts,
  archiveSharedFact,
  saveConversationEntry,
  getConversationLog,
  ConversationEntry,
  SharedFact,
} from './firebase';
import { config } from '../config';
import { dayKey, timeKey } from './datetime';

/**
 * Memória semântica compartilhada: fatos salvos por QUALQUER subagente ficam
 * num pool único por contato, com embedding. Na hora de responder, buscamos os
 * mais relevantes para a mensagem atual (similaridade) + os mais recentes —
 * assim o agente Pessoal "lembra" do cliente citado ao agente de Vendas há um
 * mês, e fatos antigos não somem do prompt só por serem antigos.
 */

/** Similaridade de cosseno; 0 se algum vetor for vazio ou de dimensão diferente. */
export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Score mínimo para um fato entrar por similaridade (abaixo disso é ruído). */
const MIN_SIMILARITY = 0.25;

/**
 * Quantos fatos recentes podem entrar SEM serem os mais relevantes — desde que
 * tenham relevância mínima com a pergunta (RECENT_MIN_SIMILARITY). Antes eram
 * injetados incondicionalmente (os 3 mais novos sempre), o que poluía o prompt
 * com fatos sem relação. Agora recência é desempate, não passe livre.
 */
const RECENT_ALWAYS = 3;

/**
 * Piso de relevância para um fato recente "furar a fila" pela recência. Mais
 * baixo que MIN_SIMILARITY (damos um bônus à recência), mas não zero — um fato
 * novo totalmente fora do assunto continua de fora.
 */
const RECENT_MIN_SIMILARITY = 0.15;

/**
 * Cache do embedding da consulta: recallFacts e relevantPastExchanges embedam a
 * MESMA mensagem do usuário a cada turno — com o cache, vira uma única chamada
 * de API por mensagem. LRU simples (Map preserva ordem de inserção).
 */
const queryEmbCache = new Map<string, number[]>();
const QUERY_EMB_CACHE_MAX = 30;

export async function embedQuery(text: string): Promise<number[]> {
  const key = text.slice(0, 2000);
  const hit = queryEmbCache.get(key);
  if (hit) return hit;
  const vector = await embed(key);
  queryEmbCache.set(key, vector);
  if (queryEmbCache.size > QUERY_EMB_CACHE_MAX) {
    const oldest = queryEmbCache.keys().next().value;
    if (oldest !== undefined) queryEmbCache.delete(oldest);
  }
  return vector;
}

/**
 * Acima desta similaridade, dois fatos são considerados a MESMA informação
 * ("gosta de café" vs "prefere café") — o novo é redundante e não é salvo.
 * Alto de propósito: só barra quase-idênticos, nunca fatos meramente do mesmo
 * tema. Ajustável por env sem mexer no código.
 */
const DEDUP_SIMILARITY = parseFloat(process.env.FACT_DEDUP_SIM || '0.88');

/**
 * Classifica um fato como permanente (preferência/traço) ou transitório (status
 * do momento). Heurística barata por palavras — sem chamada de LLM. Sinais de
 * status em andamento/conclusão recente puxam para transitório; o resto é
 * permanente (default seguro: preferências nunca decaem por engano).
 */
const TRANSIENT_HINTS =
  /\b(est[áa] (configurando|terminando|fazendo|trabalhando|organizando|finalizando)|em (andamento|processo|progresso)|concluiu|conclu[ií]da?|finalizou|terminou|lan[çc]ou|até (hoje|amanh[ãa]|esta semana|essa semana|o dia)|esta semana|essa semana|no momento|por enquanto|ainda (não|nao|está|esta))\b/i;

function classifyFact(text: string): 'permanent' | 'transient' {
  return TRANSIENT_HINTS.test(text) ? 'transient' : 'permanent';
}

/** Meia-vida do decaimento de fatos transitórios, em dias. */
const TRANSIENT_HALF_LIFE_DAYS = parseFloat(process.env.FACT_TRANSIENT_HALFLIFE_DAYS || '14');

/**
 * Fator de recência [0..1] aplicado ao score de um fato no recall. Permanentes
 * não decaem (sempre 1). Transitórios decaem exponencialmente com a idade
 * (meia-vida configurável): um status de "está configurando o celular" de 2
 * meses atrás vira quase irrelevante, mas uma preferência antiga continua forte.
 */
function recencyFactor(fact: { kind?: 'permanent' | 'transient'; createdAt: number }): number {
  if (fact.kind !== 'transient') return 1;
  const ageDays = (Date.now() - fact.createdAt) / (24 * 60 * 60 * 1000);
  return Math.pow(0.5, ageDays / TRANSIENT_HALF_LIFE_DAYS);
}

/**
 * Acima desta similaridade um fato existente é CANDIDATO a ser contradito pelo
 * novo (mesmo tema). Abaixo, são assuntos distintos e nem entram no julgamento.
 * Menor que a dedup: "acordo 9h" vs "acordo 7h" são similares mas não idênticos.
 */
const CONTRADICTION_CANDIDATE_SIM = parseFloat(process.env.FACT_CONTRA_SIM || '0.78');

const CONTRADICTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['substitui'],
  properties: {
    substitui: {
      type: 'array',
      description: 'Índices (1-based) dos fatos ANTIGOS que o fato NOVO torna desatualizados/contradiz.',
      items: { type: 'integer' },
    },
  },
};

/**
 * Dado um fato novo e candidatos do mesmo tema, pergunta a um LLM leve quais
 * candidatos o novo CONTRADIZ/ATUALIZA (ex: "acorda às 7h" substitui "acorda às
 * 9h"). Só arquiva o que for atualização real — fatos meramente parecidos mas
 * compatíveis ficam. Best-effort: erro = não arquiva nada.
 */
async function reconcileContradictions(
  newText: string,
  candidates: SharedFact[]
): Promise<number> {
  if (candidates.length === 0) return 0;
  try {
    const lista = candidates.map((c, i) => `${i + 1}. ${c.text}`).join('\n');
    const res = await chatJson<{ substitui: number[] }>(
      [
        {
          role: 'system',
          content:
            'Você cuida da memória de um assistente pessoal. Receberá um fato NOVO e uma ' +
            'lista de fatos ANTIGOS do mesmo tema. Responda quais ANTIGOS o NOVO torna ' +
            'desatualizados ou contradiz (ex: mudança de horário, preferência ou status). ' +
            'NÃO inclua fatos que apenas se parecem mas continuam verdadeiros junto do novo. ' +
            'Na dúvida, NÃO inclua.',
        },
        { role: 'user', content: `NOVO: ${newText}\n\nANTIGOS:\n${lista}` },
      ],
      { name: 'reconciliacao', schema: CONTRADICTION_SCHEMA, model: config.openai.utilityModel, temperature: 0 }
    );
    const idxs = res?.substitui ?? [];
    let archived = 0;
    for (const i of idxs) {
      const victim = candidates[i - 1];
      if (!victim) continue;
      await archiveSharedFact(victim.id);
      archived++;
      console.log(`[memory] fato atualizado: arquivei "${victim.text.slice(0, 60)}" (substituído por "${newText.slice(0, 60)}")`);
    }
    return archived;
  } catch (err) {
    console.error('[memory] reconciliação de contradições falhou (seguindo):', err);
    return 0;
  }
}

/**
 * Salva um fato no pool compartilhado, com DEDUP SEMÂNTICA (não duplica
 * quase-iguais) e RECONCILIAÇÃO (arquiva fatos do mesmo tema que o novo
 * contradiz/atualiza). Best-effort no embedding: se a API falhar, grava sem
 * vetor (cai no dedup exato do saveSharedFact e na recência).
 *
 * Retorna { saved } — false se foi descartado como redundante.
 */
export async function rememberFact(
  contact: string,
  subagentId: string,
  text: string
): Promise<{ saved: boolean; reason?: string }> {
  const clean = text.trim();
  if (!clean) return { saved: false, reason: 'vazio' };

  let embedding: number[] = [];
  try {
    embedding = await embed(clean);
  } catch (err) {
    console.error('[memory] embedding falhou (salvando sem vetor):', err);
  }

  if (embedding.length) {
    const existing = await getSharedFacts(contact);
    const scored = existing
      .filter((f) => f.embedding?.length)
      .map((f) => ({ f, sim: cosine(embedding, f.embedding) }))
      .sort((a, b) => b.sim - a.sim);

    // Candidatos do mesmo tema (inclui os quase-idênticos da faixa de dedup —
    // "acorda 9h" e "acorda 7h" são ~0.9 mas contraditórios, então a decisão de
    // descartar NÃO pode ser só por similaridade).
    const candidates = scored.filter((s) => s.sim >= CONTRADICTION_CANDIDATE_SIM).map((s) => s.f);

    // RECONCILIAÇÃO primeiro: o LLM diz quais antigos o novo torna obsoletos.
    // Precisa rodar ANTES da decisão de dedup (a dedup sozinha barraria "acorda
    // 7h" achando que é repetição de "acorda 9h"). A chamada de LLM só acontece
    // quando HÁ candidato do mesmo tema (caso raro = atualização real); no caso
    // comum (fato inédito) candidates é vazio e não há custo nem latência extra.
    const archived = candidates.length ? await reconcileContradictions(clean, candidates) : 0;

    // Se NADA foi arquivado e existe um quase-idêntico, então o novo é mesmo
    // redundante (mera repetição, não atualização) → não duplica.
    if (archived === 0) {
      const near = scored.find((s) => s.sim >= DEDUP_SIMILARITY);
      if (near) {
        console.log(`[memory] fato redundante, não salvo: "${clean.slice(0, 60)}" ≈ "${near.f.text.slice(0, 60)}"`);
        return { saved: false, reason: 'redundante' };
      }
    }
  }

  const ok = await saveSharedFact({
    contact,
    text: clean,
    embedding,
    subagentId,
    kind: classifyFact(clean),
    createdAt: Date.now(),
  });
  return { saved: ok };
}

// ===================== Trocas recentes GLOBAIS (entre subagentes) =====================

/**
 * Buffer em memória das últimas trocas do contato com QUALQUER subagente.
 * Resolve a memória fragmentada: cada subagente tem seu histórico próprio, mas
 * a conversa no WhatsApp é uma só — sem isso, um "ajusta os horários" que cai
 * em outro subagente não sabe o que acabou de ser combinado na área vizinha.
 * Após restart, é semeado (uma vez por contato) do log de conversas no Firestore.
 */
export interface RecentExchange {
  subagentId: string;
  subagentName: string;
  user: string;
  assistant: string;
  timestamp: number;
}

const RECENT_BUFFER_MAX = 10;
const recentBuffer = new Map<string, RecentExchange[]>();
const seededContacts = new Set<string>();

function pushRecent(contact: string, entry: RecentExchange): void {
  const buf = recentBuffer.get(contact) ?? [];
  buf.push(entry);
  recentBuffer.set(contact, buf.slice(-RECENT_BUFFER_MAX));
}

/** Semeia o buffer do contato a partir do log persistido (uma vez por restart). */
async function seedRecent(contact: string): Promise<void> {
  if (seededContacts.has(contact)) return;
  seededContacts.add(contact);
  try {
    const log = await getConversationLog(contact, RECENT_BUFFER_MAX);
    const fromLog: RecentExchange[] = log
      .map((e) => ({
        subagentId: e.subagentId,
        subagentName: e.subagentName,
        user: e.user,
        assistant: e.assistant,
        timestamp: e.timestamp,
      }))
      .reverse(); // getConversationLog vem mais recente primeiro; buffer é cronológico
    const existing = recentBuffer.get(contact) ?? [];
    recentBuffer.set(contact, [...fromLog, ...existing].slice(-RECENT_BUFFER_MAX));
  } catch (err) {
    console.error('[memory] falha ao semear trocas recentes:', err);
  }
}

/**
 * Últimas `n` trocas do contato com qualquer subagente, em ordem cronológica.
 * Nunca lança (best-effort).
 */
export async function recentExchanges(contact: string, n = 4): Promise<RecentExchange[]> {
  await seedRecent(contact);
  return (recentBuffer.get(contact) ?? []).slice(-n);
}

/**
 * Registra uma TROCA (mensagem do Igor + resposta) no log pesquisável, com um
 * único embedding por troca (barato). Também alimenta o buffer global de trocas
 * recentes. Best-effort: nunca lança.
 */
export async function logExchange(
  contact: string,
  subagentId: string,
  subagentName: string,
  userText: string,
  reply: string,
  timestamp: number,
  metadata?: {
    toolCalls?: { name: string; args: string; result: string }[];
    elapsedMs?: number;
    routedBy?: string;
  }
): Promise<void> {
  pushRecent(contact, {
    subagentId,
    subagentName,
    user: userText.slice(0, 1500),
    assistant: reply.slice(0, 1500),
    timestamp,
  });
  try {
    let embedding: number[] = [];
    try {
      embedding = await embed(`${userText}\n${reply}`.slice(0, 6000));
    } catch (err) {
      console.error('[memory] embedding da troca falhou (salvando sem vetor):', err);
    }
    await saveConversationEntry({
      contact,
      subagentId,
      subagentName,
      user: userText.slice(0, 1500),
      assistant: reply.slice(0, 1500),
      embedding,
      timestamp,
      ...(metadata || {}),
    });
    // Mantém o cache do RAG automático em dia sem esperar o TTL. O teto
    // espelha o limite do getConversationLog — sem ele, uma rajada de
    // mensagens dentro da janela do TTL inflaria o array sem limite.
    const cached = logCache.get(contact);
    if (cached) {
      cached.entries.unshift({
        subagentName,
        user: userText.slice(0, 1500),
        assistant: reply.slice(0, 1500),
        embedding,
        timestamp,
      });
      if (cached.entries.length > 800) cached.entries.length = 800;
    }
  } catch (err) {
    console.error('[memory] falha ao registrar troca no log:', err);
  }
}

/**
 * Cache do log de conversas: o RAG automático roda em TODA mensagem, e reler a
 * coleção inteira do Firestore a cada turno seria caro. O log só cresce pelo
 * nosso próprio logExchange (que alimenta o cache), então 10 min de TTL é só
 * uma rede de segurança para outras instâncias escrevendo no mesmo banco.
 */
type CachedEntry = Pick<
  ConversationEntry,
  'subagentName' | 'user' | 'assistant' | 'embedding' | 'timestamp'
>;
const logCache = new Map<string, { entries: CachedEntry[]; at: number }>();
const LOG_CACHE_TTL_MS = 10 * 60 * 1000;

/** Log do contato (mais recente primeiro), com cache. Nunca lança. */
async function getLogCached(contact: string): Promise<CachedEntry[]> {
  const hit = logCache.get(contact);
  if (hit && Date.now() - hit.at < LOG_CACHE_TTL_MS) return hit.entries;
  try {
    const entries = await getConversationLog(contact);
    logCache.set(contact, { entries, at: Date.now() });
    return entries;
  } catch (err) {
    console.error('[memory] falha ao carregar log de conversas:', err);
    return hit?.entries ?? [];
  }
}

/**
 * Formata uma troca para injeção em prompt / tool result. `maxChars` trunca
 * cada lado da troca (para contextos com orçamento curto, ex: crossContext).
 */
export function formatEntry(
  e: Pick<CachedEntry, 'subagentName' | 'user' | 'assistant' | 'timestamp'>,
  maxChars?: number
): string {
  const d = new Date(e.timestamp);
  const user = maxChars ? e.user.slice(0, maxChars) : e.user;
  const assistant = maxChars ? e.assistant.slice(0, maxChars) : e.assistant;
  return `[${dayKey(d)} ${timeKey(d)} | ${e.subagentName}]\nIgor: ${user}\nAgente: ${assistant}`;
}

/**
 * Busca semântica no histórico de conversas antigas. Retorna as trocas mais
 * relevantes formatadas com data, hora e subagente — pronto para tool result.
 *
 * Lê DIRETO do Firestore (sem cache): a tool é chamada raramente e precisa
 * enxergar trocas recém-gravadas por outra instância (deploy com container
 * antigo vivo, dev local) — o cache de 10 min fica só no RAG automático.
 */
export async function searchHistory(contact: string, query: string, k = 5): Promise<string[]> {
  const all = await getConversationLog(contact);
  if (all.length === 0) return [];

  let queryEmb: number[] = [];
  try {
    queryEmb = await embedQuery(query);
  } catch (err) {
    console.error('[memory] embedding da busca falhou:', err);
    return [];
  }

  return all
    .map((e) => ({ e, score: cosine(queryEmb, e.embedding || []) }))
    .sort((a, b) => b.score - a.score)
    .filter((s) => s.score >= MIN_SIMILARITY)
    .slice(0, k)
    .map(({ e }) => formatEntry(e));
}

// ===================== RAG automático do histórico =====================

/**
 * Injeção automática é mais exigente que a busca por tool: entra no prompt de
 * TODA mensagem, então abaixo deste score é ruído que só gasta contexto.
 */
const MIN_SIMILARITY_AUTO = 0.35;

/**
 * As trocas mais recentes já chegam ao modelo pela memória do subagente (12
 * mensagens) e pelo crossContext (4 trocas globais) — reinjetá-las seria
 * duplicação. Pula as N mais novas e busca só no passado "esquecido".
 */
const AUTO_SKIP_RECENT = 6;

/**
 * RAG automático: as `k` trocas ANTIGAS mais similares à mensagem atual, para
 * injetar no prompt sem depender de o modelo lembrar de chamar
 * buscar_no_historico. Best-effort: nunca lança; sem nada relevante, [].
 */
export async function relevantPastExchanges(
  contact: string,
  query: string,
  k = 3
): Promise<string[]> {
  try {
    const all = await getLogCached(contact);
    const candidates = all.slice(AUTO_SKIP_RECENT);
    if (candidates.length === 0) return [];

    const queryEmb = await embedQuery(query);
    if (!queryEmb.length) return [];

    return candidates
      .map((e) => ({ e, score: cosine(queryEmb, e.embedding || []) }))
      .filter((s) => s.score >= MIN_SIMILARITY_AUTO)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ e }) => formatEntry(e));
  } catch (err) {
    console.error('[memory] RAG automático falhou (seguindo sem ele):', err);
    return [];
  }
}

/**
 * Fatos relevantes para a mensagem atual: os RECENT_ALWAYS mais recentes +
 * top-K por similaridade semântica, deduplicados, até `k` no total.
 */
export async function recallFacts(contact: string, query: string, k = 8): Promise<string[]> {
  const all = await getSharedFacts(contact);
  if (all.length === 0) return [];

  let queryEmb: number[] = [];
  try {
    queryEmb = await embedQuery(query);
  } catch (err) {
    console.error('[memory] embedding da consulta falhou (usando só recência):', err);
  }

  // Sem embedding da consulta (API falhou): não há sinal de relevância, então
  // cai na recência pura — melhor algum contexto que nenhum.
  if (!queryEmb.length) {
    return all.slice(0, k).map((f) => f.text);
  }

  // Score = similaridade × fator de recência. Transitórios velhos perdem força;
  // permanentes não decaem. `idx` preserva a ordem original (mais novo primeiro)
  // para a reserva de vagas por recência logo abaixo.
  const scored = all
    .map((f, idx) => ({
      f,
      idx,
      score: cosine(queryEmb, f.embedding || []) * recencyFactor(f),
    }))
    .sort((a, b) => b.score - a.score);

  // 1) Relevantes de verdade entram primeiro (ordenados por similaridade).
  const relevant = scored.filter((s) => s.score >= MIN_SIMILARITY);

  // 2) Reserva algumas vagas para fatos RECENTES — mas só os que têm relevância
  //    mínima com a pergunta (não despeja os mais novos cegamente). `idx` reflete
  //    a ordem de getSharedFacts (mais novo primeiro).
  const recentRelevant = [...scored]
    .filter((s) => s.idx < RECENT_ALWAYS * 2 && s.score >= RECENT_MIN_SIMILARITY)
    .sort((a, b) => a.idx - b.idx)
    .slice(0, RECENT_ALWAYS);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...relevant, ...recentRelevant]) {
    if (seen.has(s.f.text)) continue;
    seen.add(s.f.text);
    out.push(s.f.text);
    if (out.length >= k) break;
  }
  return out;
}
