import admin from 'firebase-admin';
import { config } from '../config';
import { dayKey, nextOccurrence } from './datetime';
import {
  Subagent,
  MemoryMessage,
  Task,
  AgendaItem,
  FocusSession,
  ActionRecord,
  PersistedUndo,
  PendingPrompt,
} from '../types';

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: config.firebase.projectId,
      clientEmail: config.firebase.clientEmail,
      privateKey: config.firebase.privateKey,
    }),
  });
}

const db = admin.firestore();

const subagentsCol = db.collection('subagents');
const tasksCol = db.collection('tasks');
const memoryCol = db.collection('memory');
const metricsCol = db.collection('metrics');
const agendaCol = db.collection('agenda');
const focusCol = db.collection('focus');
const sharedFactsCol = db.collection('shared_facts');
const conversationLogCol = db.collection('conversation_log');
const jobLocksCol = db.collection('job_locks');
const routeMissesCol = db.collection('route_misses');
const routeSuggestionsCol = db.collection('route_suggestions');
const settingsCol = db.collection('settings');
const actionsCol = db.collection('actions');
const routeExamplesCol = db.collection('route_examples');
const pendingPromptsCol = db.collection('pending_prompts');

function withoutUndefined<T extends Record<string, unknown>>(data: T): T {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined)
  ) as T;
}

// ===================== Subagentes =====================

export async function listSubagents(includeInactive = false): Promise<Subagent[]> {
  const snap = await subagentsCol.get();
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Subagent));
  return includeInactive ? items : items.filter((s) => s.active);
}

export async function getSubagent(id: string): Promise<Subagent | null> {
  const doc = await subagentsCol.doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() } as Subagent;
}

export async function createSubagent(
  data: Omit<Subagent, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Subagent> {
  const now = Date.now();
  const ref = await subagentsCol.add({ ...data, createdAt: now, updatedAt: now });
  return { id: ref.id, ...data, createdAt: now, updatedAt: now };
}

export async function updateSubagent(
  id: string,
  data: Partial<Omit<Subagent, 'id'>>
): Promise<void> {
  await subagentsCol.doc(id).set({ ...data, updatedAt: Date.now() }, { merge: true });
}

export async function deleteSubagent(id: string): Promise<void> {
  await subagentsCol.doc(id).delete();
}

/** Cria os subagentes padrão se a coleção estiver vazia. */
export async function seedDefaultSubagents(defaults: Omit<Subagent, 'id'>[]): Promise<void> {
  const snap = await subagentsCol.limit(1).get();
  if (!snap.empty) return;
  const batch = db.batch();
  for (const sub of defaults) {
    const ref = subagentsCol.doc();
    batch.set(ref, sub);
  }
  await batch.commit();
  console.log(`[firebase] ${defaults.length} subagentes padrão criados.`);
}

/**
 * Garante que um subagente exista (por nome), criando-o se ausente.
 *
 * Diferente de `seedDefaultSubagents` (que só roda com a coleção vazia), isto é
 * idempotente e funciona em bancos já populados — usado para introduzir o
 * subagente "Agenda / Orquestrador" sem duplicar a cada reboot.
 */
export async function ensureSubagent(def: Omit<Subagent, 'id'>): Promise<Subagent> {
  const existing = await listSubagents(true);
  const found = existing.find((s) => s.name === def.name);
  if (found) return found;
  return createSubagent(def);
}

// ===================== Memória (por subagente) =====================

/**
 * Memória separada por subagente, para não misturar assuntos de projetos
 * diferentes. Estrutura: memory/{contato}/agents/{subagentId}/messages.
 */
function messagesCol(contact: string, subagentId: string) {
  return memoryCol
    .doc(contact)
    .collection('agents')
    .doc(subagentId)
    .collection('messages');
}

/** Salva uma mensagem na memória de um contato dentro de um subagente. */
export async function appendMemory(
  contact: string,
  subagentId: string,
  message: MemoryMessage
): Promise<void> {
  await messagesCol(contact, subagentId).add(message);
}

/** Últimas N mensagens do contato naquele subagente, em ordem cronológica. */
export async function getRecentMemory(
  contact: string,
  subagentId: string,
  limit = 12
): Promise<MemoryMessage[]> {
  const snap = await messagesCol(contact, subagentId)
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map((d) => d.data() as MemoryMessage).reverse();
}

// ===================== Fatos persistentes (por subagente) =====================

/**
 * Fatos de longo prazo que o agente deve lembrar entre conversas
 * (ex: nomes de clientes, preferências, status de projetos).
 * Estrutura: memory/{contato}/agents/{subagentId}/facts.
 */
function factsCol(contact: string, subagentId: string) {
  return memoryCol
    .doc(contact)
    .collection('agents')
    .doc(subagentId)
    .collection('facts');
}

export async function saveFact(
  contact: string,
  subagentId: string,
  fact: string
): Promise<void> {
  const text = fact.trim();
  if (!text) return;
  // Evita duplicar o mesmo fato.
  const dup = await factsCol(contact, subagentId).where('text', '==', text).limit(1).get();
  if (!dup.empty) return;
  await factsCol(contact, subagentId).add({ text, createdAt: Date.now() });
}

export async function getFacts(
  contact: string,
  subagentId: string,
  limit = 30
): Promise<string[]> {
  const snap = await factsCol(contact, subagentId)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map((d) => (d.data() as { text: string }).text);
}

/** Um fato legado com metadados suficientes para migrar/apagar/exibir. */
export interface LegacyFact {
  id: string;
  subagentId: string;
  text: string;
  createdAt: number;
}

/**
 * Varre TODOS os subagentes de um contato e devolve os fatos legados
 * (memory/{contato}/agents/{sub}/facts). Base da migração para o banco único de
 * SharedFacts e da exposição no painel — nada aqui apaga.
 */
export async function listLegacyFacts(contact: string): Promise<LegacyFact[]> {
  const agents = await memoryCol.doc(contact).collection('agents').listDocuments();
  const out: LegacyFact[] = [];
  for (const ag of agents) {
    const snap = await ag.collection('facts').get();
    for (const doc of snap.docs) {
      const d = doc.data() as { text?: string; createdAt?: number };
      if (!d.text) continue;
      out.push({ id: doc.id, subagentId: ag.id, text: d.text, createdAt: d.createdAt ?? 0 });
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Apaga UM fato legado pelo caminho exato (contato/subagente/id). */
export async function deleteLegacyFact(
  contact: string,
  subagentId: string,
  factId: string
): Promise<void> {
  await factsCol(contact, subagentId).doc(factId).delete();
}

// ===================== Tarefas =====================

function taskHasReminder(task: Task): boolean {
  if (task.hasReminder === false) return false;
  if (task.done || task.firedAt) return true;
  const remindTime = new Date(task.remindAt).getTime();
  return Number.isFinite(remindTime) && Math.abs(remindTime - task.createdAt) > 60_000;
}

export async function createTask(data: Omit<Task, 'id' | 'createdAt' | 'done'>): Promise<Task> {
  const task = withoutUndefined({ ...data, done: false, createdAt: Date.now() }) as Omit<
    Task,
    'id'
  >;
  const ref = await tasksCol.add(task);
  return { id: ref.id, ...task };
}

/**
 * Tarefas pendentes que já passaram do horário de lembrar.
 *
 * O filtro de horário vai NA QUERY, não em memória. Esta função roda no tick de
 * cada minuto: filtrar em memória significa ler a coleção `tasks` inteira 1.440
 * vezes por dia, e o Firestore cobra por documento lido. Com ~40 tarefas isso
 * dava ~55 mil leituras/dia e estourava a cota diária (o backend passava a
 * morrer no boot com RESOURCE_EXHAUSTED). Com o `where` de horário, o caso
 * comum — nenhum lembrete vencido — lê zero documento.
 *
 * `taskHasReminder` continua em memória porque depende de comparar `remindAt`
 * com `createdAt`, o que não se expressa em query; mas aí já opera sobre o
 * punhado de vencidos, não sobre a coleção toda.
 *
 * Exige índice composto (done ASC, remindAt ASC) — ver firestore.indexes.json.
 */
export async function getDueTasks(): Promise<Task[]> {
  const nowIso = new Date().toISOString();
  const snap = await tasksCol
    .where('done', '==', false)
    .where('remindAt', '<=', nowIso)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as Task))
    .filter((t) => taskHasReminder(t));
}

/**
 * Marca uma tarefa como genuinamente CONCLUÍDA (pelo usuário/agenda), gravando
 * `completedAt` — entra na contagem de "concluídas" dos relatórios e no
 * aprendizado de padrões.
 */
export async function markTaskDone(id: string): Promise<void> {
  await tasksCol.doc(id).set({ done: true, completedAt: Date.now() }, { merge: true });
}

/**
 * Marca um lembrete como JÁ ENVIADO (deixa de re-disparar), sem `completedAt`.
 * Disparar um lembrete não é o mesmo que concluir uma tarefa, então isto NÃO
 * deve inflar a contagem de tarefas concluídas nos relatórios.
 */
export async function markReminderSent(id: string): Promise<void> {
  await tasksCol.doc(id).set({ done: true }, { merge: true });
}

/**
 * Reivindica um lembrete vencido ANTES do envio, de forma atômica: numa
 * transação, marca como enviado (ou reagenda, se recorrente) e só retorna true
 * para quem chegou primeiro. Se houver mais de uma instância do app rodando
 * contra o mesmo Firestore (deploy duplicado, container antigo vivo), apenas
 * uma envia — as outras veem o estado já alterado e desistem.
 */
export async function claimDueTask(task: Task): Promise<boolean> {
  const ref = tasksCol.doc(task.id);
  try {
    return await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) return false;
      const current = doc.data() as Task;
      if (task.recurrence) {
        // Outra instância já reagendou esta ocorrência.
        if (current.remindAt !== task.remindAt) return false;
        tx.update(ref, {
          remindAt: nextOccurrence(task.remindAt, task.recurrence),
          firedAt: Date.now(),
        });
      } else {
        if (current.done) return false;
        tx.update(ref, { done: true, firedAt: Date.now() });
      }
      return true;
    });
  } catch (err) {
    console.error(`[firebase] falha ao reivindicar lembrete ${task.id}:`, err);
    return false; // na dúvida, não envia — a tarefa continua vencida e o próximo tick tenta de novo
  }
}

// ===================== Travas de jobs proativos =====================

/**
 * Trava distribuída de job proativo (cronograma, follow-up, resumo noturno...).
 * Usa `create()`, que falha se o documento já existir — assim, mesmo com várias
 * instâncias do app, só a primeira a chegar dispara o job naquele período.
 */
export async function acquireJobLock(job: string, periodKey: string): Promise<boolean> {
  try {
    await jobLocksCol.doc(`${job}_${periodKey}`).create({ job, periodKey, at: Date.now() });
    return true;
  } catch {
    return false; // já existe (outra instância venceu) ou Firestore indisponível
  }
}

/** Apaga travas com mais de 48h para a coleção não crescer sem limite. */
export async function cleanupJobLocks(): Promise<void> {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  // Em lotes, com teto de iterações — o tick por minuto gera ~1440 travas/dia.
  for (let i = 0; i < 10; i++) {
    const snap = await jobLocksCol.where('at', '<', cutoff).limit(500).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

/**
 * Tarefas concluídas num intervalo [start, end] de epoch ms (por completedAt).
 * Tarefas antigas sem completedAt são ignoradas neste recorte temporal.
 */
export async function getCompletedTasksBetween(start: number, end: number): Promise<Task[]> {
  const snap = await tasksCol.where('done', '==', true).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as Task))
    .filter((t) => t.completedAt != null && t.completedAt >= start && t.completedAt <= end);
}

/**
 * Lembretes que JÁ DISPARARAM hoje e ainda não foram confirmados pelo usuário
 * (done sem completedAt, remindAt no dia local `today`). São os "bloqueadores"
 * da fila sequencial: enquanto existir um, os próximos lembretes seguram.
 *
 * Como `getDueTasks`, roda no tick de cada minuto e por isso NÃO pode varrer
 * todas as concluídas — elas só acumulam com o tempo (ver comentário lá sobre a
 * cota estourada). A query recorta `remindAt` numa janela de ±1 dia em torno de
 * hoje, o que basta para descartar o histórico antigo.
 *
 * A janela é folgada de propósito: `today` é um dia no fuso local
 * (`config.timezone`) e `remindAt` é ISO/UTC, então as bordas não coincidem. O
 * `dayKey` exato continua sendo aplicado em memória logo abaixo — a query só
 * corta volume, quem decide o dia é o filtro de sempre.
 *
 * Exige índice composto (done ASC, remindAt ASC) — ver firestore.indexes.json.
 */
export async function getFiredUnconfirmed(today: string): Promise<Task[]> {
  const dayMs = 86_400_000;
  const ref = new Date(`${today}T12:00:00Z`).getTime();
  const from = new Date(ref - dayMs).toISOString();
  const to = new Date(ref + dayMs).toISOString();

  const snap = await tasksCol
    .where('done', '==', true)
    .where('remindAt', '>=', from)
    .where('remindAt', '<=', to)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as Task))
    .filter((t) => !t.completedAt && dayKey(new Date(t.remindAt)) === today)
    .sort((a, b) => a.remindAt.localeCompare(b.remindAt));
}

/** Todas as tarefas pendentes (done == false), sem filtro de horário. */
export async function getPendingTasks(): Promise<Task[]> {
  const snap = await tasksCol.where('done', '==', false).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Task));
}

/** Lista todas as tarefas, ordenadas por horário de lembrar (crescente). */
export async function listTasks(): Promise<Task[]> {
  const snap = await tasksCol.get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as Task))
    .sort((a, b) => a.remindAt.localeCompare(b.remindAt));
}

export async function getTask(id: string): Promise<Task | null> {
  const doc = await tasksCol.doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() } as Task;
}

/** Atualiza campos de uma tarefa (texto, done, remindAt, subagentId...). */
export async function updateTask(
  id: string,
  data: Partial<Omit<Task, 'id' | 'createdAt'>>
): Promise<void> {
  await tasksCol.doc(id).set(data, { merge: true });
}

export async function deleteTask(id: string): Promise<void> {
  await tasksCol.doc(id).delete();
}

// ===================== Memória semântica compartilhada =====================

/**
 * Fato de longo prazo no pool COMPARTILHADO entre todos os subagentes, com
 * embedding para busca semântica. Substitui gradualmente os facts por
 * subagente: o que o agente de Vendas aprende, o Pessoal também enxerga.
 */
export interface SharedFact {
  id: string;
  contact: string;
  text: string;
  /** Embedding do texto (vazio se a API de embeddings falhou na gravação). */
  embedding: number[];
  /** Subagente que registrou o fato (origem), para contexto. */
  subagentId?: string;
  createdAt: number;
  /**
   * Natureza do fato, para pesar a recência no recall:
   * - `permanent`: preferência/traço duradouro — não decai com o tempo.
   * - `transient`: status do momento ("está configurando o celular") — decai
   *   rápido, para não competir com informação atual depois de velho.
   * Ausente = tratado como permanente (compatível com fatos antigos).
   */
  kind?: 'permanent' | 'transient';
  /**
   * Arquivado pela consolidação noturna (duplicado, corrigido ou expirado).
   * Arquivar é reversível — fatos nunca são apagados de verdade.
   */
  archived?: boolean;
  archivedAt?: number;
}

/**
 * Salva um fato no pool compartilhado. Retorna true se salvou, false se um
 * fato ATIVO idêntico já existia (dedupe). Fatos arquivados não bloqueiam:
 * um fato que expirou e foi arquivado pode voltar se for dito de novo.
 */
export async function saveSharedFact(data: Omit<SharedFact, 'id'>): Promise<boolean> {
  if (!data.text.trim()) return false;
  const dup = await sharedFactsCol
    .where('contact', '==', data.contact)
    .where('text', '==', data.text)
    .get();
  const activeDup = dup.docs.some((d) => !(d.data() as SharedFact).archived);
  if (activeDup) return false;
  await sharedFactsCol.add(data);
  return true;
}

/** Fatos compartilhados ATIVOS do contato (não arquivados), mais recentes primeiro. */
export async function getSharedFacts(contact: string, limit = 400): Promise<SharedFact[]> {
  const snap = await sharedFactsCol.where('contact', '==', contact).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as SharedFact))
    .filter((f) => !f.archived)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

/** Arquiva um fato (sai do recall, mas continua no banco — reversível). */
export async function archiveSharedFact(id: string): Promise<void> {
  await sharedFactsCol.doc(id).set({ archived: true, archivedAt: Date.now() }, { merge: true });
}

/** Desarquiva um fato (volta ao recall). Usado para desfazer arquivamentos. */
export async function unarchiveSharedFact(id: string): Promise<void> {
  await sharedFactsCol.doc(id).set({ archived: false }, { merge: true });
}

/** Atualiza os dados de um fato (por exemplo, texto e embedding). */
export async function updateSharedFact(id: string, data: Partial<SharedFact>): Promise<void> {
  await sharedFactsCol.doc(id).set(data, { merge: true });
}

/** Remove permanentemente um fato do Firestore. */
export async function deleteSharedFact(id: string): Promise<void> {
  await sharedFactsCol.doc(id).delete();
}

// ===================== Perfil vivo (memória consolidada) =====================

/**
 * Perfil destilado do contato (rotina, projetos, preferências), reconstruído
 * pela manutenção noturna e injetado no system prompt de todos os subagentes.
 * Estrutura: profiles/{contato} = { text, updatedAt }.
 */
const profilesCol = db.collection('profiles');

export async function saveProfile(contact: string, text: string): Promise<void> {
  await profilesCol.doc(contact).set({ text, updatedAt: Date.now() });
}

export async function getProfile(contact: string): Promise<string | null> {
  const doc = await profilesCol.doc(contact).get();
  if (!doc.exists) return null;
  return (doc.data() as { text?: string }).text || null;
}

// ===================== Log pesquisável de conversas =====================

/**
 * Uma TROCA de mensagens (Igor + resposta) com embedding, para busca semântica
 * no histórico antigo — além da janela curta de memória por subagente.
 */
export interface ConversationEntry {
  id: string;
  contact: string;
  subagentId: string;
  subagentName: string;
  user: string;
  assistant: string;
  /** Embedding da troca (vazio se a API falhou na gravação). */
  embedding: number[];
  timestamp: number;
  // Metadados de execução para Raio-X
  toolCalls?: { name: string; args: string; result: string }[];
  elapsedMs?: number;
  routedBy?: string;
}

export async function saveConversationEntry(
  data: Omit<ConversationEntry, 'id'>
): Promise<void> {
  await conversationLogCol.add(data);
}

/** Trocas do contato, mais recentes primeiro (cap para a busca em memória). */
export async function getConversationLog(
  contact: string,
  limit = 800
): Promise<ConversationEntry[]> {
  const snap = await conversationLogCol.where('contact', '==', contact).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as ConversationEntry))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

// ===================== F9: aprendizado de roteamento =====================

/**
 * Possível erro de roteamento: o Igor corrigiu logo após uma troca. A detecção
 * é generosa (correção pode ser de conteúdo); o job semanal usa o LLM para
 * separar o joio e sugerir keywords.
 */
export interface RouteMiss {
  id: string;
  contact: string;
  /** A mensagem que pode ter sido mal roteada. */
  text: string;
  routedToId: string;
  routedToName: string;
  /** A correção do Igor que disparou o registro. */
  correction: string;
  /** Para onde a correção foi roteada, quando DIFERENTE — palpite da rota certa. */
  suggestedCorrectName?: string;
  at: number;
}

export async function recordRouteMiss(data: Omit<RouteMiss, 'id'>): Promise<void> {
  await routeMissesCol.add(data);
}

/** Misses desde `sinceMs`, em ordem cronológica (range num campo só — sem índice). */
export async function getRouteMisses(sinceMs: number): Promise<RouteMiss[]> {
  const snap = await routeMissesCol.where('at', '>=', sinceMs).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as RouteMiss))
    .sort((a, b) => a.at - b.at);
}

/**
 * Exemplo rotulado de roteamento, derivado de uma correção do Igor: "esta
 * mensagem deveria ter ido para este subagente". Usado pelo atalho de
 * roteamento aprendido (routeShortcut), que age de imediato — sem esperar a
 * rotina semanal de keywords.
 */
export interface RouteExample {
  id: string;
  contact: string;
  /** A mensagem original que foi mal roteada. */
  text: string;
  /** Embedding da mensagem, para comparar por similaridade. */
  embedding: number[];
  /** Subagente CORRETO (para onde a correção foi roteada). */
  subagentId: string;
  subagentName: string;
  at: number;
}

/**
 * Grava um exemplo de roteamento aprendido. Idempotente por (contact, text,
 * subagentId): re-corrigir a mesma mensagem não duplica.
 */
export async function saveRouteExample(
  data: Omit<RouteExample, 'id'>
): Promise<void> {
  const dup = await routeExamplesCol
    .where('contact', '==', data.contact)
    .where('text', '==', data.text)
    .where('subagentId', '==', data.subagentId)
    .limit(1)
    .get();
  if (!dup.empty) return;
  await routeExamplesCol.add(withoutUndefined(data));
}

/** Todos os exemplos aprendidos de um contato (volume pequeno; filtra em memória). */
export async function getRouteExamples(contact: string): Promise<RouteExample[]> {
  const snap = await routeExamplesCol.where('contact', '==', contact).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as RouteExample));
}

/** Sugestão de keywords por subagente, aguardando confirmação do Igor. */
export interface RouteSuggestion {
  id: string;
  createdAt: number;
  applied: boolean;
  items: { subagentId: string; subagentName: string; keywords: string[] }[];
}

export async function saveRouteSuggestion(
  items: RouteSuggestion['items']
): Promise<void> {
  // Uma pendente por vez: a nova substitui (marca como aplicada) as antigas,
  // senão um "aplica" tardio executaria sugestões de semanas atrás.
  const old = await routeSuggestionsCol.where('applied', '==', false).get();
  for (const d of old.docs) {
    await d.ref.set({ applied: true }, { merge: true });
  }
  await routeSuggestionsCol.add({ items, createdAt: Date.now(), applied: false });
}

export async function getPendingRouteSuggestion(): Promise<RouteSuggestion | null> {
  const snap = await routeSuggestionsCol.where('applied', '==', false).get();
  const all = snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as RouteSuggestion))
    .sort((a, b) => b.createdAt - a.createdAt);
  return all[0] ?? null;
}

export async function markRouteSuggestionApplied(id: string): Promise<void> {
  await routeSuggestionsCol.doc(id).set({ applied: true }, { merge: true });
}

// ===================== Métricas de uso =====================

/**
 * Registra uma mensagem processada incrementando contadores do dia.
 * Estrutura: metrics/{YYYY-MM-DD} = { total, byAgent: { <id>: n }, names: { <id>: nome } }.
 * Sem índices compostos: leitura por range de ids de documento.
 */
export async function recordMessage(
  subagentId: string,
  subagentName: string
): Promise<void> {
  const ref = metricsCol.doc(dayKey());
  const inc = admin.firestore.FieldValue.increment(1);
  await ref.set(
    {
      total: inc,
      byAgent: { [subagentId]: inc },
      names: { [subagentId]: subagentName },
      updatedAt: Date.now(),
    },
    { merge: true }
  );
}

export interface DayMetric {
  day: string;
  total: number;
  byAgent: Record<string, number>;
  names: Record<string, string>;
}

/** Métricas dos últimos N dias (inclui hoje), em ordem cronológica. */
export async function getMetrics(days = 7): Promise<DayMetric[]> {
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    keys.push(dayKey(d));
  }
  const refs = keys.map((k) => metricsCol.doc(k));
  const snaps = await db.getAll(...refs);
  return snaps.map((snap, idx) => {
    const data = snap.exists ? (snap.data() as Partial<DayMetric>) : {};
    return {
      day: keys[idx],
      total: data.total || 0,
      byAgent: data.byAgent || {},
      names: data.names || {},
    };
  });
}

// ===================== Agenda (cronograma diário) =====================

/**
 * Cria um item da agenda. Injeta `createdAt` e default `status:'pending'`.
 * Datas/horas seguem o schema textual do resto do projeto (date YYYY-MM-DD,
 * horários HH:mm), sem usar Timestamp nativo do Firestore.
 */
export async function createAgendaItem(
  data: Omit<AgendaItem, 'id' | 'createdAt' | 'status'> & { status?: AgendaItem['status'] }
): Promise<AgendaItem> {
  const item = withoutUndefined({
    status: 'pending' as const,
    ...data,
    createdAt: Date.now(),
  }) as Omit<AgendaItem, 'id'>;
  const ref = await agendaCol.add(item);
  return { id: ref.id, ...item };
}

/**
 * Itens da agenda de um dia (YYYY-MM-DD), ordenados por horário de início.
 *
 * Usa apenas um filtro de igualdade (`date ==`) — que não exige índice composto
 * — e ordena em memória, mesma estratégia de `getDueTasks`.
 */
export async function getAgendaForDay(date: string): Promise<AgendaItem[]> {
  const snap = await agendaCol.where('date', '==', date).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as AgendaItem))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/**
 * Itens da agenda num intervalo de datas [start, end] inclusivo (YYYY-MM-DD),
 * ordenados por data e depois por horário de início.
 *
 * Como `date` é string YYYY-MM-DD (ordenável lexicograficamente), um range em um
 * único campo não exige índice composto no Firestore.
 */
export async function getAgendaInRange(start: string, end: string): Promise<AgendaItem[]> {
  const snap = await agendaCol
    .where('date', '>=', start)
    .where('date', '<=', end)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as AgendaItem))
    .sort((a, b) =>
      a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date)
    );
}

export async function getAgendaItem(id: string): Promise<AgendaItem | null> {
  const doc = await agendaCol.doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() } as AgendaItem;
}

/**
 * Itens da agenda ligados a uma Task (lembrete) pelo `taskId`. Base da
 * propagação bidirecional: mover/remover/concluir um lembrete alcança os blocos
 * de cronograma que nasceram dele.
 */
export async function getAgendaItemsByTaskId(taskId: string): Promise<AgendaItem[]> {
  const snap = await agendaCol.where('taskId', '==', taskId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as AgendaItem));
}

/** Atualiza campos de um item da agenda (status, horários, prioridade...). */
export async function updateAgendaItem(
  id: string,
  data: Partial<Omit<AgendaItem, 'id' | 'createdAt'>>
): Promise<void> {
  await agendaCol.doc(id).set(withoutUndefined(data), { merge: true });
}

export async function deleteAgendaItem(id: string): Promise<void> {
  await agendaCol.doc(id).delete();
}

/**
 * Itens concluídos COM duração medida (startedAt + completedAt), mais recentes
 * primeiro — a matéria-prima da calibração de estimativas. Igualdade única
 * (status == done) para não exigir índice composto; o resto filtra em memória.
 */
export async function getMeasuredAgendaItems(
  sinceMs: number,
  limit = 50
): Promise<AgendaItem[]> {
  const snap = await agendaCol.where('status', '==', 'done').get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as AgendaItem))
    .filter((i) => i.startedAt != null && i.completedAt != null && i.completedAt >= sinceMs)
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
    .slice(0, limit);
}

// ===================== Modo foco =====================

/** Inicia/renova a sessão de foco de um contato (documento por contato). */
export async function startFocus(contact: string, endsAt: number): Promise<FocusSession> {
  const session: FocusSession = { contact, startedAt: Date.now(), endsAt, ended: false };
  await focusCol.doc(contact).set(session);
  return session;
}

/** Sessão de foco do contato, ou null se não houver. */
export async function getFocus(contact: string): Promise<FocusSession | null> {
  const doc = await focusCol.doc(contact).get();
  if (!doc.exists) return null;
  return doc.data() as FocusSession;
}

/** Marca a sessão de foco como encerrada (após avisar o usuário). */
export async function endFocus(contact: string): Promise<void> {
  await focusCol.doc(contact).set({ ended: true }, { merge: true });
}

/** Sessões de foco expiradas (endsAt passou) e ainda não avisadas. */
export async function getExpiredFocusSessions(now = Date.now()): Promise<FocusSession[]> {
  const snap = await focusCol.where('ended', '==', false).get();
  return snap.docs
    .map((d) => d.data() as FocusSession)
    .filter((s) => s.endsAt <= now);
}

// ===================== Perguntas pendentes =====================

/**
 * Registra a pergunta fechada que acabou de ser enviada ao contato, com os
 * itens que ela colocou em jogo. Sobrescreve qualquer pergunta anterior: só a
 * última cobrança está "no ar" — responder a uma pergunta de três turnos atrás
 * não é um caso real, e manter várias abertas só multiplicaria a chance de
 * casar a resposta com a pergunta errada.
 */
export async function setPendingPrompt(prompt: PendingPrompt): Promise<void> {
  await pendingPromptsCol.doc(prompt.contact).set(withoutUndefined({ ...prompt }));
}

/** Pergunta pendente do contato, ou null se não houver / já ter expirado. */
export async function getPendingPrompt(contact: string): Promise<PendingPrompt | null> {
  if (!contact) return null;
  const doc = await pendingPromptsCol.doc(contact).get();
  if (!doc.exists) return null;
  const prompt = doc.data() as PendingPrompt;
  if (prompt.expiresAt <= Date.now()) return null;
  return prompt;
}

/**
 * A pergunta pendente do contato IGNORANDO o TTL de resposta. A suspensão da
 * cobrança diária dura até a virada do dia, não as 6h em que uma resposta
 * ainda é interpretada como resposta — por isso ela não pode usar
 * `getPendingPrompt`, que devolve null assim que o prompt expira.
 */
export async function getPendingPromptRaw(contact: string): Promise<PendingPrompt | null> {
  if (!contact) return null;
  const doc = await pendingPromptsCol.doc(contact).get();
  return doc.exists ? (doc.data() as PendingPrompt) : null;
}

/** Marca que já pedimos desambiguação desta pergunta (para não pedir de novo). */
export async function markPendingPromptClarified(contact: string): Promise<void> {
  await pendingPromptsCol.doc(contact).set({ clarifiedAt: Date.now() }, { merge: true });
}

/** Encerra a pergunta pendente do contato (respondida ou descartada). */
export async function clearPendingPrompt(contact: string): Promise<void> {
  if (!contact) return;
  await pendingPromptsCol.doc(contact).delete();
}

// ===================== Configurações de proatividade =====================

/**
 * Configurações editáveis pelo painel (agente-igor-web). Persistidas num
 * documento único `settings/proactive`. Os defaults vêm do `config` (envs);
 * o que estiver salvo aqui SOBRESCREVE em runtime via o serviço `settings`.
 */
export interface ProactiveSettings {
  maxDailyWorkMinutes: number;
  urgentKeywords: string[];
  notifications: {
    morningSchedule: { enabled: boolean; time: string };
    eveningSummary: { enabled: boolean; time: string };
    weeklyReview: { enabled: boolean; time: string };
    subagentReports: { enabled: boolean };
  };
}

const SETTINGS_DOC = 'proactive';

/** Lê as configurações salvas, ou null se nunca foram gravadas. */
export async function getStoredSettings(): Promise<ProactiveSettings | null> {
  const doc = await settingsCol.doc(SETTINGS_DOC).get();
  if (!doc.exists) return null;
  return doc.data() as ProactiveSettings;
}

/** Grava (sobrescreve) as configurações de proatividade. */
export async function saveStoredSettings(data: ProactiveSettings): Promise<void> {
  await settingsCol.doc(SETTINGS_DOC).set(data);
}

// ===================== Auditoria de ações (undo persistente) =====================

/**
 * Grava um registro de auditoria de uma escrita do agente. Best-effort: nunca
 * deve quebrar o fluxo principal, então o chamador trata a falha como não-fatal.
 */
export async function logAction(
  data: Omit<ActionRecord, 'id'>
): Promise<ActionRecord> {
  const clean = withoutUndefined({ ...data }) as Omit<ActionRecord, 'id'>;
  const ref = await actionsCol.add(clean);
  return { id: ref.id, ...clean };
}

/** Lista as ações mais recentes (auditoria), da mais nova para a mais antiga. */
export async function listActions(limit = 50): Promise<ActionRecord[]> {
  const snap = await actionsCol.orderBy('at', 'desc').limit(limit).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as ActionRecord));
}

export async function getAction(id: string): Promise<ActionRecord | null> {
  const doc = await actionsCol.doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() } as ActionRecord;
}

/** Marca uma ação como desfeita pelo painel (carimba `undoneAt`). */
export async function markActionUndone(id: string): Promise<void> {
  await actionsCol.doc(id).set({ undoneAt: Date.now() }, { merge: true });
}

/**
 * Executa uma reversão declarativa contra o Firestore, aplicando cada operação
 * em ordem. É o "motor" do desfazer pelo painel: reconstrói o efeito da closure
 * `revert` a partir do payload serializado, então funciona mesmo após restart.
 */
export async function applyPersistedUndo(undo: PersistedUndo): Promise<void> {
  for (const op of undo) {
    switch (op.kind) {
      case 'task.create':
        await createTask(op.data);
        break;
      case 'task.update':
        await updateTask(op.id, op.data);
        break;
      case 'task.delete':
        await deleteTask(op.id);
        break;
      case 'agenda.update':
        await updateAgendaItem(op.id, op.data);
        break;
      case 'agenda.create':
        await createAgendaItem(op.data);
        break;
    }
  }
}

export { db };
