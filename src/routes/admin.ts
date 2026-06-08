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
  setTaskDone,
  deleteTask,
} from '../services/firebase';

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

adminRouter.get('/tasks', async (req, res) => {
  const subagentId = (req.query.subagentId as string) || undefined;
  const tasks = await listTasks(subagentId);
  res.json(tasks);
});

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

adminRouter.put('/tasks/:id', async (req, res) => {
  const { done } = req.body;
  if (typeof done !== 'boolean') {
    return res.status(400).json({ error: 'done (boolean) é obrigatório' });
  }
  await setTaskDone(req.params.id, done);
  res.json({ ok: true });
});

adminRouter.delete('/tasks/:id', async (req, res) => {
  await deleteTask(req.params.id);
  res.json({ ok: true });
});
