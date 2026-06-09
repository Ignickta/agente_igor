import { Router, Request, Response, NextFunction } from 'express';
import { config } from '../config';
import {
  listSubagents,
  getSubagent,
  createSubagent,
  updateSubagent,
  deleteSubagent,
  createTask,
  listTasks,
  getTask,
  updateTask,
  deleteTask,
  getMetrics,
  getAgendaForDay,
  getAgendaItem,
  createAgendaItem,
  updateAgendaItem,
  deleteAgendaItem,
} from '../services/firebase';
import { generateDailySchedule, dayKey } from '../agents/orchestrator';
import { AgendaItem } from '../types';

export const adminRouter = Router();

/** Middleware simples de auth por token (header x-admin-token ou ?token=). */
function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (!config.adminToken) return next(); // sem token configurado = aberto (apenas dev)
  const provided = req.header('x-admin-token') || (req.query.token as string);
  if (provided !== config.adminToken) {
    res.status(401).json({ error: 'Token inválido' });
    return;
  }
  next();
}

adminRouter.use(requireToken);

// ===================== Subagentes =====================

adminRouter.get('/subagents', async (_req, res) => {
  const subs = await listSubagents(true);
  res.json(subs);
});

adminRouter.get('/subagents/:id', async (req, res) => {
  const sub = await getSubagent(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subagente não encontrado' });
  res.json(sub);
});

adminRouter.post('/subagents', async (req, res) => {
  const { name, keywords, prompt, active } = req.body;
  if (!name || !prompt) {
    return res.status(400).json({ error: 'name e prompt são obrigatórios' });
  }
  const sub = await createSubagent({
    name,
    keywords: Array.isArray(keywords) ? keywords : [],
    prompt,
    active: active !== false,
  });
  res.status(201).json(sub);
});

adminRouter.put('/subagents/:id', async (req, res) => {
  const existing = await getSubagent(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Subagente não encontrado' });
  const { name, keywords, prompt, active } = req.body;
  await updateSubagent(req.params.id, { name, keywords, prompt, active });
  res.json({ ok: true });
});

adminRouter.delete('/subagents/:id', async (req, res) => {
  await deleteSubagent(req.params.id);
  res.json({ ok: true });
});

// ===================== Tarefas / Lembretes =====================

adminRouter.post('/tasks', async (req, res) => {
  const { text, remindAt, to, subagentId } = req.body;
  if (!text || !remindAt) {
    return res.status(400).json({ error: 'text e remindAt (ISO) são obrigatórios' });
  }
  const task = await createTask({
    text,
    remindAt,
    to: to || config.ownerPhone,
    subagentId,
  });
  res.status(201).json(task);
});

// Lista tarefas. Filtros opcionais:
//   ?subagent=nome|id  -> só de um projeto
//   ?upcoming=true     -> só pendentes com data futura (próximos lembretes)
adminRouter.get('/tasks', async (req, res) => {
  let tasks = await listTasks();

  const filter = (req.query.subagent as string)?.trim();
  if (filter) {
    const subs = await listSubagents(true);
    const match = subs.find(
      (s) => s.id === filter || s.name.toLowerCase() === filter.toLowerCase()
    );
    const subId = match?.id || filter;
    tasks = tasks.filter((t) => t.subagentId === subId);
  }

  if (req.query.upcoming === 'true') {
    const nowIso = new Date().toISOString();
    tasks = tasks.filter((t) => !t.done && t.remindAt >= nowIso);
  }

  res.json(tasks);
});

// Estatísticas de uso para o dashboard.
// Retorna: mensagens de hoje, total e uso por subagente nos últimos N dias.
adminRouter.get('/stats', async (req, res) => {
  const days = Math.min(Math.max(parseInt((req.query.days as string) || '7', 10), 1), 31);
  const metrics = await getMetrics(days);

  const today = metrics[metrics.length - 1];
  const totalPeriod = metrics.reduce((acc, m) => acc + m.total, 0);

  // Agrega uso por subagente no período.
  const byAgent: Record<string, { name: string; count: number }> = {};
  for (const m of metrics) {
    for (const [id, count] of Object.entries(m.byAgent)) {
      if (!byAgent[id]) byAgent[id] = { name: m.names[id] || id, count: 0 };
      byAgent[id].count += count;
      if (m.names[id]) byAgent[id].name = m.names[id];
    }
  }
  const usageByAgent = Object.entries(byAgent)
    .map(([id, v]) => ({ id, name: v.name, count: v.count }))
    .sort((a, b) => b.count - a.count);

  res.json({
    today: today?.total || 0,
    totalPeriod,
    days,
    daily: metrics.map((m) => ({ day: m.day, total: m.total })),
    usageByAgent,
  });
});

// Atualiza uma tarefa (marcar como feito, editar texto, remindAt, etc.)
adminRouter.put('/tasks/:id', async (req, res) => {
  const existing = await getTask(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tarefa não encontrada' });

  const { text, remindAt, done, subagentId, to } = req.body;
  const update: Record<string, unknown> = {};
  if (text !== undefined) update.text = text;
  if (remindAt !== undefined) update.remindAt = remindAt;
  if (done !== undefined) update.done = !!done;
  if (subagentId !== undefined) update.subagentId = subagentId;
  if (to !== undefined) update.to = to;

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  await updateTask(req.params.id, update);
  res.json({ ok: true });
});

// Remove uma tarefa
adminRouter.delete('/tasks/:id', async (req, res) => {
  const existing = await getTask(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tarefa não encontrada' });
  await deleteTask(req.params.id);
  res.json({ ok: true });
});

// ===================== Agenda (cronograma diário) =====================

const AGENDA_TYPES = ['task', 'event', 'research'];
const AGENDA_STATUSES = ['pending', 'in_progress', 'done'];

const clampPriority = (p: unknown): number => Math.min(5, Math.max(1, Number(p) || 3));

/**
 * Coage e valida os campos de um item de agenda vindos do body, com as MESMAS
 * regras para POST e PUT. Em modo `partial` (PUT) só inclui os campos presentes;
 * caso contrário aplica os defaults de criação.
 */
function coerceAgendaFields(
  body: Record<string, unknown>,
  partial = false
): Partial<Omit<AgendaItem, 'id' | 'createdAt'>> {
  const { title, date, startTime, endTime, priority, type, status, createdBy, subagentId, notes } =
    body;
  const out: Partial<Omit<AgendaItem, 'id' | 'createdAt'>> = {};

  if (!partial || title !== undefined) out.title = title as string;
  if (!partial || date !== undefined) out.date = date as string;
  if (!partial || startTime !== undefined) out.startTime = startTime as string;
  if (!partial || endTime !== undefined) out.endTime = endTime as string;
  if (!partial || priority !== undefined) out.priority = clampPriority(priority);
  if (!partial || type !== undefined) {
    out.type = (AGENDA_TYPES.includes(type as string) ? type : 'task') as AgendaItem['type'];
  }
  if (!partial || status !== undefined) {
    out.status = (AGENDA_STATUSES.includes(status as string)
      ? status
      : 'pending') as AgendaItem['status'];
  }
  if (!partial || createdBy !== undefined) {
    out.createdBy = createdBy === 'agent' ? 'agent' : 'user';
  }
  if (subagentId !== undefined) out.subagentId = subagentId as string;
  if (notes !== undefined) out.notes = notes as string;
  return out;
}

// Lista a agenda de um dia. ?date=YYYY-MM-DD (padrão: hoje).
adminRouter.get('/agenda', async (req, res) => {
  const date = (req.query.date as string)?.trim() || dayKey();
  const items = await getAgendaForDay(date);
  res.json(items);
});

// Cria um item da agenda. Itens fixos do usuário usam priority 1 / createdBy 'user'.
adminRouter.post('/agenda', async (req, res) => {
  const { title, date, startTime, endTime } = req.body;
  if (!title || !date || !startTime || !endTime) {
    return res
      .status(400)
      .json({ error: 'title, date, startTime e endTime são obrigatórios' });
  }
  const fields = coerceAgendaFields(req.body, false) as Parameters<typeof createAgendaItem>[0];
  const item = await createAgendaItem(fields);
  res.status(201).json(item);
});

// Gera o cronograma do dia a partir das tarefas pendentes. ?date=&force=true
adminRouter.post('/agenda/generate', async (req, res) => {
  const date = (req.query.date as string)?.trim() || dayKey();
  const force = req.query.force === 'true';
  const items = await generateDailySchedule(date, force);
  res.json({ date, count: items.length, items });
});

// Atualiza um item da agenda (status, horários, prioridade, etc.).
adminRouter.put('/agenda/:id', async (req, res) => {
  const existing = await getAgendaItem(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Item de agenda não encontrado' });

  const update = coerceAgendaFields(req.body, true);
  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }
  await updateAgendaItem(req.params.id, update);
  res.json({ ok: true });
});

// Remove um item da agenda.
adminRouter.delete('/agenda/:id', async (req, res) => {
  const existing = await getAgendaItem(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Item de agenda não encontrado' });
  await deleteAgendaItem(req.params.id);
  res.json({ ok: true });
});
