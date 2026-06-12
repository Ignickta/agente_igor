import { config } from '../config';
import { chat, chatJson, embed } from '../services/openai';
import {
  getSharedFacts,
  archiveSharedFact,
  saveSharedFact,
  getProfile,
  saveProfile,
  SharedFact,
} from '../services/firebase';
import { dayKey } from '../services/datetime';
import { learnUserPatterns } from './orchestrator';

/**
 * Manutenção noturna da memória:
 *  - CONSOLIDAÇÃO: funde fatos duplicados, faz "Correção: ..." substituir o
 *    fato errado que corrige e arquiva fatos pontuais já expirados. Sem isso o
 *    pool só cresce e fatos contraditórios convivem no recall para sempre.
 *  - PERFIL VIVO: destila dos fatos um resumo do Igor (rotina, projetos,
 *    preferências) injetado no system prompt de TODOS os subagentes — assim
 *    qualquer área conhece o básico mesmo quando a mensagem não "puxa" os
 *    fatos por similaridade.
 * Arquivar é reversível (flag `archived`); nada é apagado de verdade.
 */

interface ConsolidationPlan {
  remover?: number[];
  fundir?: { numeros: number[]; texto: string }[];
}

/** Schema estrito do plano de limpeza (Structured Outputs). */
const CONSOLIDATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['remover', 'fundir'],
  properties: {
    remover: { type: 'array', items: { type: 'integer' } },
    fundir: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['numeros', 'texto'],
        properties: {
          numeros: { type: 'array', items: { type: 'integer' } },
          texto: { type: 'string' },
        },
      },
    },
  },
};

/** Abaixo disso não vale uma chamada de LLM — o pool ainda é pequeno e limpo. */
const MIN_FACTS_TO_CONSOLIDATE = 8;
/** Teto de fatos por rodada (os mais recentes; o resto entra nas noites seguintes). */
const MAX_FACTS_IN_PROMPT = 150;

// ===================== Consolidação de fatos =====================

/**
 * Pede ao modelo utilitário um plano de limpeza conservador (fusões + remoções)
 * e o aplica: fusões criam um fato novo e arquivam os originais; remoções só
 * arquivam. Best-effort: plano inválido = nada muda.
 */
export async function consolidateFacts(
  contact: string
): Promise<{ archived: number; merged: number }> {
  const facts = await getSharedFacts(contact);
  if (facts.length < MIN_FACTS_TO_CONSOLIDATE) return { archived: 0, merged: 0 };

  const sample = facts.slice(0, MAX_FACTS_IN_PROMPT);
  const lista = sample
    .map((f, i) => `${i + 1}. [${dayKey(new Date(f.createdAt))}] ${f.text}`)
    .join('\n');

  const system = `Você é o zelador da memória de longo prazo do agente pessoal do Igor.
Receberá os fatos memorizados, numerados e com a data em que foram salvos (hoje é ${dayKey()}).
Aponte APENAS limpezas seguras:
- DUPLICADOS/REDUNDANTES: fatos que dizem a mesma coisa → funda num único texto completo.
- CORREÇÕES: um fato que começa com "Correção:" substitui o fato errado que ele corrige →
  remova o errado (a correção permanece, não a remova).
- EXPIRADOS: fatos claramente pontuais cuja data já passou (ex: um compromisso de semanas
  atrás). Preferências, decisões, características e contexto do Igor NUNCA expiram sozinhos.
Seja CONSERVADOR: na dúvida, NÃO mexa — manter um fato a mais é melhor que perder informação.
Em "remover" vão os números dos fatos a arquivar; em "fundir", grupos de números com o texto
fundido. Sem nada a fazer, devolva as duas listas vazias.`;

  const plan = await chatJson<ConsolidationPlan>(
    [
      { role: 'system', content: system },
      { role: 'user', content: `Fatos memorizados:\n${lista}\n\nPlano de limpeza:` },
    ],
    {
      name: 'limpeza_memoria',
      schema: CONSOLIDATION_SCHEMA,
      temperature: 0,
      model: config.openai.utilityModel,
    }
  );
  if (!plan) {
    console.warn('[maintenance] consolidação sem JSON utilizável — nada alterado.');
    return { archived: 0, merged: 0 };
  }

  /** Converte um número 1-based do plano no fato correspondente (ou null). */
  const byIndex = (n: unknown): SharedFact | null =>
    typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= sample.length
      ? sample[n - 1]
      : null;

  const archivedIds = new Set<string>();
  let merged = 0;

  // Fusões primeiro: cria o fato fundido e arquiva os originais. Se a remoção
  // citar um fato já fundido, o arquivamento não se repete (archivedIds).
  const fusoes = Array.isArray(plan.fundir) ? plan.fundir : [];
  for (const f of fusoes) {
    const texto = String(f?.texto || '').trim();
    const numeros = Array.isArray(f?.numeros) ? f.numeros : [];
    const grupo = numeros.map(byIndex).filter((x): x is SharedFact => x !== null);
    if (!texto || grupo.length < 2) continue;

    let embedding: number[] = [];
    try {
      embedding = await embed(texto);
    } catch (err) {
      console.error('[maintenance] embedding do fato fundido falhou (salvando sem vetor):', err);
    }
    // Preserva o createdAt mais novo do grupo: o fato fundido não deve "furar"
    // a fila de recência do recall só por ter sido reescrito hoje.
    await saveSharedFact({
      contact,
      text: texto,
      embedding,
      createdAt: Math.max(...grupo.map((g) => g.createdAt)),
      ...(grupo.find((g) => g.subagentId)?.subagentId
        ? { subagentId: grupo.find((g) => g.subagentId)!.subagentId }
        : {}),
    });
    for (const g of grupo) {
      if (archivedIds.has(g.id)) continue;
      await archiveSharedFact(g.id);
      archivedIds.add(g.id);
    }
    merged++;
  }

  const remocoes = Array.isArray(plan.remover) ? plan.remover : [];
  for (const n of remocoes) {
    const fact = byIndex(n);
    if (!fact || archivedIds.has(fact.id)) continue;
    await archiveSharedFact(fact.id);
    archivedIds.add(fact.id);
  }

  return { archived: archivedIds.size, merged };
}

// ===================== Perfil vivo =====================

/** Com menos fatos que isso, um "perfil" seria invenção do modelo. */
const PROFILE_MIN_FACTS = 3;

/**
 * Destila o perfil do contato a partir dos fatos consolidados (+ padrões do
 * histórico) e persiste. Usa o modelo principal: roda uma vez por dia e é o
 * texto mais reaproveitado do sistema (entra em todo prompt).
 */
export async function rebuildProfile(contact: string): Promise<string> {
  const facts = await getSharedFacts(contact);
  if (facts.length < PROFILE_MIN_FACTS) return '';

  const lista = facts
    .slice(0, 80)
    .map((f) => `- [${dayKey(new Date(f.createdAt))}] ${f.text}`)
    .join('\n');
  const patterns = await learnUserPatterns().catch(() => '');

  const system = `Você destila o "perfil vivo" do Igor — um resumo injetado no system prompt de
TODOS os subagentes do agente pessoal dele, como contexto de fundo.
Escreva em português, em tópicos curtos (máximo 15 linhas), cobrindo SOMENTE o que os fatos
sustentam: quem é o Igor e seu contexto; projetos/negócios ativos e status; rotina e horários;
preferências (de comunicação, de decisão); decisões importantes ainda vigentes.
Não invente nada. Não inclua trivialidades nem eventos pontuais já passados. Em conflito entre
fatos, o mais recente vale mais. Responda apenas com o perfil, sem título nem comentários.`;

  const user = `Fatos memorizados (mais recentes primeiro):\n${lista}\n\n${
    patterns ? `Padrões observados do histórico de tarefas:\n${patterns}\n\n` : ''
  }Perfil vivo do Igor:`;

  const profile = (
    await chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: 0.2 }
    )
  ).trim();
  if (!profile) return '';

  await saveProfile(contact, profile);
  profileCache.set(contact, { text: profile, at: Date.now() });
  console.log(`[maintenance] perfil de ${contact} atualizado (${profile.length} chars).`);
  return profile;
}

// ===================== Leitura com cache (caminho quente) =====================

const profileCache = new Map<string, { text: string; at: number }>();
const PROFILE_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Perfil do contato para injeção no prompt — cacheado por 10 min para não
 * custar uma leitura de Firestore por mensagem. Nunca lança: sem perfil (ou
 * com erro), devolve '' e o prompt segue sem o bloco.
 */
export async function getProfileCached(contact: string): Promise<string> {
  const hit = profileCache.get(contact);
  if (hit && Date.now() - hit.at < PROFILE_CACHE_TTL_MS) return hit.text;
  try {
    const text = (await getProfile(contact)) || '';
    profileCache.set(contact, { text, at: Date.now() });
    return text;
  } catch (err) {
    console.error('[maintenance] falha ao carregar perfil:', err);
    return hit?.text || '';
  }
}

// ===================== Entradas do scheduler =====================

/** Job noturno: consolida os fatos do dono e reconstrói o perfil. */
export async function runMemoryMaintenance(): Promise<void> {
  if (!config.ownerPhone) {
    console.warn('[maintenance] OWNER_PHONE ausente — manutenção de memória pulada.');
    return;
  }
  const contact = config.ownerPhone;
  try {
    const { archived, merged } = await consolidateFacts(contact);
    console.log(`[maintenance] consolidação: ${merged} fusões, ${archived} fatos arquivados.`);
  } catch (err) {
    console.error('[maintenance] falha na consolidação de fatos:', err);
  }
  try {
    await rebuildProfile(contact);
  } catch (err) {
    console.error('[maintenance] falha ao reconstruir o perfil:', err);
  }
}

/**
 * No boot: gera o primeiro perfil se ainda não existir (sem esperar o job das
 * 03:30). Checa antes de gastar LLM, então re-deploys não custam nada.
 */
export async function bootstrapProfile(): Promise<void> {
  if (!config.ownerPhone) return;
  try {
    if (await getProfile(config.ownerPhone)) return;
    await rebuildProfile(config.ownerPhone);
  } catch (err) {
    console.error('[maintenance] falha no bootstrap do perfil:', err);
  }
}
