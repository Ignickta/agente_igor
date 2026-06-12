import admin from 'firebase-admin';
import { config } from '../config';
import { dayKey, nextOccurrence } from './datetime';
import { Subagent, MemoryMessage, Task, AgendaItem, FocusSession } from '../types';

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

// ===================== Tarefas =====================

export async function createTask(data: Omit<Task, 'id' | 'createdAt' | 'done'>): Promise<Task> {
  const task = { ...data, done: false, createdAt: Date.now() };
  const ref = await tasksCol.add(task);
  return { id: ref.id, ...task };
}

/**
 * Tarefas pendentes que já passaram do horário de lembrar.
 *
 * Usa apenas um filtro de igualdade (`done == false`) — que não exige índice
 * composto no Firestore — e filtra por horário em memória. O volume de tarefas
 * pendentes é pequeno, então isso é eficiente e evita a necessidade de índice.
 */
export async function getDueTasks(): Promise<Task[]> {
  const nowIso = new Date().toISOString();
  const snap = await tasksCol.where('done', '==', false).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as Task))
    .filter((t) => t.remindAt <= nowIso);
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
        tx.update(ref, { remindAt: nextOccurrence(task.remindAt, task.recurrence) });
      } else {
        if (current.done) return false;
        tx.update(ref, { done: true });
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
   * Arquivado pela consolidação noturna (duplicado, corrigido ou expirado).
   * Arquivar é reversível — fatos nunca são apagados de verdade.
   */
  archived?: boolean;
  archivedAt?: number;
}

export async function saveSharedFact(data: Omit<SharedFact, 'id'>): Promise<void> {
  if (!data.text.trim()) return;
  const dup = await sharedFactsCol
    .where('contact', '==', data.contact)
    .where('text', '==', data.text)
    .limit(1)
    .get();
  if (!dup.empty) return;
  await sharedFactsCol.add(data);
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
  const item = {
    status: 'pending' as const,
    ...data,
    createdAt: Date.now(),
  };
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

/** Atualiza campos de um item da agenda (status, horários, prioridade...). */
export async function updateAgendaItem(
  id: string,
  data: Partial<Omit<AgendaItem, 'id' | 'createdAt'>>
): Promise<void> {
  await agendaCol.doc(id).set(data, { merge: true });
}

export async function deleteAgendaItem(id: string): Promise<void> {
  await agendaCol.doc(id).delete();
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

export { db };
