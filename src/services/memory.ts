import { embed } from './openai';
import { saveSharedFact, getSharedFacts } from './firebase';

/**
 * Memória semântica compartilhada: fatos salvos por QUALQUER subagente ficam
 * num pool único por contato, com embedding. Na hora de responder, buscamos os
 * mais relevantes para a mensagem atual (similaridade) + os mais recentes —
 * assim o agente Pessoal "lembra" do cliente citado ao agente de Vendas há um
 * mês, e fatos antigos não somem do prompt só por serem antigos.
 */

/** Similaridade de cosseno; 0 se algum vetor for vazio ou de dimensão diferente. */
function cosine(a: number[], b: number[]): number {
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

/**
 * Fatos relevantes para a mensagem atual: os RECENT_ALWAYS mais recentes +
 * top-K por similaridade semântica, deduplicados, até `k` no total.
 */
export async function recallFacts(contact: string, query: string, k = 8): Promise<string[]> {
  const all = await getSharedFacts(contact);
  if (all.length === 0) return [];

  let queryEmb: number[] = [];
  try {
    queryEmb = await embed(query.slice(0, 2000));
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
