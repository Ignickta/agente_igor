import { embed } from './openai';
import {
  saveSharedFact,
  getSharedFacts,
  saveConversationEntry,
  getConversationLog,
  ConversationEntry,
} from './firebase';
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

/** Quantos fatos recentes entram sempre, independente de similaridade. */
const RECENT_ALWAYS = 3;

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
 * Salva um fato no pool compartilhado. Best-effort no embedding: se a API
 * falhar, grava sem vetor (o fato ainda aparece pelo critério de recência).
 */
export async function rememberFact(
  contact: string,
  subagentId: string,
  text: string
): Promise<void> {
  let embedding: number[] = [];
  try {
    embedding = await embed(text);
  } catch (err) {
    console.error('[memory] embedding falhou (salvando sem vetor):', err);
  }
  await saveSharedFact({ contact, text: text.trim(), embedding, subagentId, createdAt: Date.now() });
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
  timestamp: number
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

  const scored = all.map((f) => ({
    f,
    score: queryEmb.length ? cosine(queryEmb, f.embedding || []) : 0,
  }));

  const recent = scored.slice(0, RECENT_ALWAYS);
  const similar = [...scored]
    .sort((a, b) => b.score - a.score)
    .filter((s) => s.score >= MIN_SIMILARITY);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...recent, ...similar]) {
    if (seen.has(s.f.text)) continue;
    seen.add(s.f.text);
    out.push(s.f.text);
    if (out.length >= k) break;
  }
  return out;
}
