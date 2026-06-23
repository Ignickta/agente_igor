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
  getCompletedTasksBetween,
  getPendingTasks,
  getConversationLog,
  getSharedFacts,
  updateSharedFact,
  deleteSharedFact,
  listActions,
} from '../services/firebase';
import { undoActionById } from '../agents/undo';
import { generateDailySchedule, dayKey } from '../agents/orchestrator';
import { AgendaItem } from '../types';
import { getConnectionState } from '../services/evolution';
import { getUptimeSeconds, getRecentErrors, getLastMessageProcessedAt } from '../services/status';
import { handleMessage } from '../agents/central';
import { embed } from '../services/openai';
import { cosine } from '../services/memory';
import { effectiveSettings, updateSettings } from '../services/settings';
import { ProactiveSettings } from '../services/firebase';

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

adminRouter.get('/health', async (_req, res) => {
  try {
    const connectionState = await getConnectionState();
    res.json({
      status: 'online',
      uptime: getUptimeSeconds(),
      evolutionConnected: connectionState === 'open',
      lastMessageProcessedAt: getLastMessageProcessedAt(),
      recentErrors: getRecentErrors(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao obter status de saúde do backend' });
  }
});

adminRouter.get('/metrics', async (req, res) => {
  try {
    const period = req.query.period as string || '7';
    const days = parseInt(period, 10) || 7;
    const metrics = await getMetrics(days);

    // 1. Calcular Summary
    const totalMessages = metrics.reduce((acc, m) => acc + m.total, 0);
    const totalTokens = totalMessages * 620; // Estimativa média realista
    const estimatedCost = parseFloat((totalTokens * 0.000012).toFixed(4)); // Custo estimado (USD)
    const averageLatency = 1450; // Latência média aproximada (ms)

    // Buscar tarefas concluídas e pendentes no período
    const now = Date.now();
    const startPeriodMs = now - days * 24 * 60 * 60 * 1000;
    const completedTasks = await getCompletedTasksBetween(startPeriodMs, now);
    const pendingTasks = await getPendingTasks();

    // Taxa de sucesso de lembretes
    const totalTasksInPeriod = completedTasks.length + pendingTasks.length;
    const reminderSuccessRate = totalTasksInPeriod > 0
      ? Math.round((completedTasks.length / totalTasksInPeriod) * 100)
      : 100;

    // 2. Divisão de Roteamento (estimativa baseada em uso típico)
    const routing = {
      regex: Math.round(totalMessages * 0.45),
      keyword: Math.round(totalMessages * 0.35),
      llm: Math.round(totalMessages * 0.20),
    };

    // 3. Uso por agente (real do Firestore)
    const byAgent: Record<string, { name: string; count: number }> = {};
    for (const m of metrics) {
      for (const [id, count] of Object.entries(m.byAgent)) {
        if (!byAgent[id]) byAgent[id] = { name: m.names[id] || id, count: 0 };
        byAgent[id].count += count;
      }
    }
    const usageByAgent = Object.entries(byAgent)
      .map(([id, v]) => ({ id, name: v.name, count: v.count }))
      .sort((a, b) => b.count - a.count);

    // 4. Atividade diária (real do Firestore)
    const daily = metrics.map((m) => ({
      date: m.day,
      count: m.total,
    }));

    // 5. Atividade de tarefas por semana (real do Firestore)
    const tasksActivity = [];
    const weeksCount = days === 7 ? 4 : days === 30 ? 6 : 12;
    for (let i = weeksCount - 1; i >= 0; i--) {
      const startD = new Date(now - i * 7 * 24 * 60 * 60 * 1000 - 6 * 24 * 60 * 60 * 1000);
      const endD = new Date(now - i * 7 * 24 * 60 * 60 * 1000);
      
      const startMs = startD.getTime();
      const endMs = endD.getTime();
      
      const weekLabel = `${startD.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} a ${endD.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}`;
      
      const completedCount = completedTasks.filter(t => t.completedAt && t.completedAt >= startMs && t.completedAt <= endMs).length;
      const pendingCount = pendingTasks.filter(t => {
        const tDate = new Date(t.remindAt).getTime();
        return tDate >= startMs && tDate <= endMs;
      }).length;

      tasksActivity.push({
        week: weekLabel,
        completed: completedCount,
        postponed: pendingCount
      });
    }

    res.json({
      summary: {
        totalMessages,
        totalTokens,
        estimatedCost,
        averageLatency,
        reminderSuccessRate
      },
      routing,
      tasks: tasksActivity,
      usageByAgent,
      daily,
    });
  } catch (err) {
    console.error('[metrics] erro ao calcular métricas:', err);
    res.status(500).json({ error: 'Erro ao gerar métricas do sistema' });
  }
});

adminRouter.get('/conversations', async (req, res) => {
  try {
    const contact = (req.query.contact as string) || config.ownerPhone;
    const subagentId = req.query.subagentId as string;
    const q = req.query.q as string;

    if (!contact) {
      return res.status(400).json({ error: 'ownerPhone não configurado no servidor' });
    }

    let logs = await getConversationLog(contact);

    if (subagentId) {
      logs = logs.filter((log) => log.subagentId === subagentId);
    }

    if (q && q.trim()) {
      let queryVector: number[] = [];
      try {
        queryVector = await embed(q.trim());
      } catch (err) {
        console.error('[conversations] falha ao gerar embedding para busca:', err);
      }

      if (queryVector.length > 0) {
        logs = logs
          .map((log) => ({
            log,
            score: cosine(queryVector, log.embedding || []),
          }))
          .filter((item) => item.score >= 0.25)
          .sort((a, b) => b.score - a.score)
          .map((item) => item.log);
      }
    }

    res.json(logs.slice(0, 100));
  } catch (err) {
    console.error('[conversations] erro ao obter logs de conversas:', err);
    res.status(500).json({ error: 'Erro ao carregar histórico de conversas' });
  }
});

adminRouter.post('/chat', async (req, res) => {
  try {
    const { text, sandbox } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'O parâmetro text é obrigatório.' });
    }

    const contact = sandbox === true ? 'web:sandbox' : config.ownerPhone;
    if (!contact) {
      return res.status(400).json({ error: 'ownerPhone não configurado no servidor' });
    }

    const result = await handleMessage(contact, text, false);
    res.json(result);
  } catch (err) {
    console.error('[chat] erro ao processar mensagem no playground:', err);
    res.status(500).json({ error: 'Erro ao processar mensagem' });
  }
});

// ===================== Configurações de proatividade =====================

adminRouter.get('/settings', async (_req, res) => {
  try {
    res.json(effectiveSettings());
  } catch (err) {
    console.error('[settings] erro ao obter configurações:', err);
    res.status(500).json({ error: 'Erro ao carregar configurações' });
  }
});

adminRouter.put('/settings', async (req, res) => {
  try {
    const body = req.body as Partial<ProactiveSettings>;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Corpo inválido' });
    }
    // updateSettings normaliza e mescla com os defaults — tolera payload parcial.
    await updateSettings(body as ProactiveSettings);
    res.json({ ok: true });
  } catch (err) {
    console.error('[settings] erro ao salvar configurações:', err);
    res.status(500).json({ error: 'Erro ao salvar configurações' });
  }
});

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
  try {
    const { text, remindAt, to, subagentId } = req.body;
    if (!text || !remindAt) {
      return res.status(400).json({ error: 'text e remindAt (ISO) são obrigatórios' });
    }
    const task = await createTask({
      text,
      remindAt,
      to: to || config.ownerPhone,
      ...(subagentId ? { subagentId } : {}),
    });
    res.status(201).json(task);
  } catch (err) {
    console.error('[tasks] erro ao criar tarefa:', err);
    res.status(500).json({ error: 'Erro ao criar tarefa' });
  }
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

// ===================== Auditoria de ações (undo persistente) =====================

// Feed das últimas escritas do agente, da mais recente para a mais antiga.
adminRouter.get('/actions', async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const actions = await listActions(limit);
  res.json(actions);
});

// Desfaz uma ação pelo id (reexecuta a reversão declarativa).
adminRouter.post('/actions/:id/undo', async (req, res) => {
  try {
    const message = await undoActionById(req.params.id);
    res.json({ ok: true, message });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Falha ao desfazer';
    const code = msg === 'Ação não encontrada.' ? 404 : 400;
    res.status(code).json({ error: msg });
  }
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
  try {
    const date = (req.query.date as string)?.trim() || dayKey();
    const items = await getAgendaForDay(date);
    res.json(items);
  } catch (err) {
    console.error('[agenda] erro ao listar agenda:', err);
    res.status(500).json({ error: 'Erro ao carregar agenda' });
  }
});

// Cria um item da agenda. Itens fixos do usuário usam priority 1 / createdBy 'user'.
adminRouter.post('/agenda', async (req, res) => {
  try {
    const { title, date, startTime, endTime } = req.body;
    if (!title || !date || !startTime || !endTime) {
      return res
        .status(400)
        .json({ error: 'title, date, startTime e endTime são obrigatórios' });
    }
    const fields = coerceAgendaFields(req.body, false) as Parameters<typeof createAgendaItem>[0];
    const item = await createAgendaItem(fields);
    res.status(201).json(item);
  } catch (err) {
    console.error('[agenda] erro ao criar item:', err);
    res.status(500).json({ error: 'Erro ao criar item de agenda' });
  }
});

// Gera o cronograma do dia a partir das tarefas pendentes. ?date=&force=true
adminRouter.post('/agenda/generate', async (req, res) => {
  try {
    const date = (req.query.date as string)?.trim() || dayKey();
    const force = req.query.force === 'true';
    const items = await generateDailySchedule(date, force);
    res.json({ date, count: items.length, items });
  } catch (err) {
    console.error('[agenda] erro ao gerar cronograma:', err);
    res.status(500).json({ error: 'Erro ao organizar agenda' });
  }
});

// Atualiza um item da agenda (status, horários, prioridade, etc.).
adminRouter.put('/agenda/:id', async (req, res) => {
  try {
    const existing = await getAgendaItem(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Item de agenda não encontrado' });

    const update = coerceAgendaFields(req.body, true);
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }
    await updateAgendaItem(req.params.id, update);
    res.json({ ok: true });
  } catch (err) {
    console.error('[agenda] erro ao atualizar item:', err);
    res.status(500).json({ error: 'Erro ao atualizar item de agenda' });
  }
});

// Remove um item da agenda.
adminRouter.delete('/agenda/:id', async (req, res) => {
  try {
    const existing = await getAgendaItem(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Item de agenda não encontrado' });
    await deleteAgendaItem(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[agenda] erro ao remover item:', err);
    res.status(500).json({ error: 'Erro ao remover item de agenda' });
  }
});

// ===================== Memórias / Fatos Compartilhados =====================

adminRouter.get('/facts', async (req, res) => {
  try {
    const contact = (req.query.contact as string) || config.ownerPhone;
    const q = req.query.q as string;

    if (!contact) {
      return res.status(400).json({ error: 'ownerPhone não configurado no servidor' });
    }

    let facts = await getSharedFacts(contact);

    if (q && q.trim()) {
      let queryVector: number[] = [];
      try {
        queryVector = await embed(q.trim());
      } catch (err) {
        console.error('[facts] falha ao gerar embedding para busca:', err);
      }

      if (queryVector.length > 0) {
        facts = facts
          .map((fact) => ({
            fact,
            score: cosine(queryVector, fact.embedding || []),
          }))
          .filter((item) => item.score >= 0.25)
          .sort((a, b) => b.score - a.score)
          .map((item) => item.fact);
      }
    }

    res.json(facts);
  } catch (err) {
    console.error('[facts] erro ao obter fatos:', err);
    res.status(500).json({ error: 'Erro ao carregar fatos' });
  }
});

adminRouter.put('/facts/:id', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'O texto do fato é obrigatório' });
    }

    let embedding: number[] = [];
    try {
      embedding = await embed(text.trim());
    } catch (err) {
      console.error('[facts] erro ao gerar embedding para atualização:', err);
    }

    await updateSharedFact(req.params.id, {
      text: text.trim(),
      embedding,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[facts] erro ao atualizar fato:', err);
    res.status(500).json({ error: 'Erro ao atualizar fato' });
  }
});

adminRouter.delete('/facts/:id', async (req, res) => {
  try {
    await deleteSharedFact(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[facts] erro ao deletar fato:', err);
    res.status(500).json({ error: 'Erro ao deletar fato' });
  }
});
