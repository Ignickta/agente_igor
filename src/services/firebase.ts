import admin from 'firebase-admin';
import { config } from '../config';
import { Subagent, MemoryMessage, Task } from '../types';

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

// ===================== Memória =====================

/** Salva uma mensagem na memória de conversa de um contato. */
export async function appendMemory(
  contact: string,
  message: MemoryMessage
): Promise<void> {
  await memoryCol.doc(contact).collection('messages').add(message);
}

/** Recupera as últimas N mensagens de um contato, em ordem cronológica. */
export async function getRecentMemory(
  contact: string,
  limit = 12
): Promise<MemoryMessage[]> {
  const snap = await memoryCol
    .doc(contact)
    .collection('messages')
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .get();
  return snap.docs
    .map((d) => d.data() as MemoryMessage)
    .reverse();
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

export async function markTaskDone(id: string): Promise<void> {
  await tasksCol.doc(id).set({ done: true }, { merge: true });
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

export { db };
