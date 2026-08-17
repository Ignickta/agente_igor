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
  markTaskDone,
  getDueTasks,
  getFiredUnconfirmed,
  getMetrics,
  getAgendaForDay,
  getAgendaItem,
  getAgendaItemsByTaskId,
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
import { generateDailySchedule, advanceTask, dayKey } from '../agents/orchestrator';
import { AgendaItem } from '../types';
import { getConnectionState } from '../services/evolution';
import { getUptimeSeconds, getRecentErrors, getLastMessageProcessedAt } from '../services/status';
import { handleMessage } from '../agents/central';
import { embed } from '../services/openai';
import { cosine } from '../services/memory';
import { effectiveSettings, updateSettings } from '../services/settings';
import { ProactiveSettings } from '../services/firebase';
import { timeKey, parseLocalIso } from '../services/datetime';

export const adminRouter = Router();

function taskHasReminder(task: {
  hasReminder?: boolean;
  remindAt: string;
  createdAt: number;
  done: boolean;
  firedAt?: number | null;
}): boolean {
  if (task.hasReminder === false) return false;
  if (task.done || task.firedAt) return true;
  const remindTime = new Date(task.remindAt).getTime();
  return Number.isFinite(remindTime) && Math.abs(remindTime - task.createdAt) > 60_000;
}

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

    // 1. Resumo baseado apenas em dados efetivamente registrados.
    const totalMessages = metrics.reduce((acc, m) => acc + m.total, 0);
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const logs = config.ownerPhone
      ? (await getConversationLog(config.ownerPhone, 2_000)).filter((log) => log.timestamp >= sinceMs)
      : [];
    const latencySamples = logs.filter((log) => typeof log.elapsedMs === 'number' && log.elapsedMs > 0);
    const averageLatency = latencySamples.length
      ? Math.round(latencySamples.reduce((sum, log) => sum + (log.elapsedMs || 0), 0) / latencySamples.length)
      : null;

    // Buscar tarefas concluídas e pendentes no período
    const now = Date.now();
    const startPeriodMs = now - days * 24 * 60 * 60 * 1000;
    const completedTasks = await getCompletedTasksBetween(startPeriodMs, now);
    const pendingTasks = await getPendingTasks();
    const allTasks = await listTasks();

    // Taxa de sucesso de lembretes
    const totalTasksInPeriod = completedTasks.length + pendingTasks.length;
    const reminderSuccessRate = totalTasksInPeriod > 0
      ? Math.round((completedTasks.length / totalTasksInPeriod) * 100)
      : 100;

    // 2. Divisão de roteamento registrada no log de conversas.
    // "outros" cobre embedding, exemplos aprendidos e atalhos administrativos.
    const routing = { regex: 0, keyword: 0, llm: 0, other: 0 };
    for (const log of logs) {
      if (log.routedBy === 'agenda-regex') routing.regex++;
      else if (log.routedBy === 'keywords') routing.keyword++;
      else if (log.routedBy === 'llm') routing.llm++;
      else routing.other++;
    }

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
      const postponedCount = allTasks.filter((t) => {
        if ((t.postponedCount ?? 0) === 0) return false;
        const tDate = new Date(t.remindAt).getTime();
        return tDate >= startMs && tDate <= endMs;
      }).length;

      tasksActivity.push({
        week: weekLabel,
        completed: completedCount,
        // Não são tarefas pendentes: são tarefas que possuem um adiamento
        // registrado e estão agendadas para esta semana.
        postponed: postponedCount
      });
    }

    res.json({
      summary: {
        totalMessages,
        averageLatency,
        latencySampleSize: latencySamples.length,
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

adminRouter.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json([]);

    const contact = config.ownerPhone;
    const [tasks, facts, actions] = await Promise.all([
      listTasks(),
      contact ? getSharedFacts(contact) : Promise.resolve([]),
      listActions(100),
    ]);

    const results: Array<{
      kind: 'task' | 'fact' | 'action';
      id: string;
      title: string;
      subtitle?: string;
      href?: string;
    }> = [];

    for (const t of tasks) {
      if (!t.text.toLowerCase().includes(q)) continue;
      results.push({
        kind: 'task',
        id: t.id,
        title: t.text,
        subtitle: t.completedAt ? 'tarefa concluída' : t.done ? 'tocou sem confirmação' : 'tarefa pendente',
        href: `/tasks?search=${encodeURIComponent(t.text)}`,
      });
    }

    for (const f of facts) {
      if (!f.text.toLowerCase().includes(q)) continue;
      results.push({
        kind: 'fact',
        id: f.id,
        title: f.text,
        subtitle: 'memória',
        href: `/memoria?search=${encodeURIComponent(q)}`,
      });
    }

    for (const a of actions) {
      if (!a.description.toLowerCase().includes(q)) continue;
      results.push({
        kind: 'action',
        id: a.id,
        title: a.description,
        subtitle: 'auditoria',
        href: '/auditoria',
      });
    }

    res.json(results.slice(0, 30));
  } catch (err) {
    console.error('[search] erro ao buscar:', err);
    res.status(500).json({ error: 'Erro ao buscar' });
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
    if (!text) {
      return res.status(400).json({ error: 'text é obrigatório' });
    }
    const hasReminder = !!remindAt;
    const task = await createTask({
      text,
      remindAt: hasReminder ? remindAt : new Date().toISOString(),
      hasReminder,
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
    tasks = tasks.filter((t) => !t.done && taskHasReminder(t) && t.remindAt >= nowIso);
  }

  res.json(tasks);
});

// Contagem de pendências (atrasadas + disparadas sem confirmação) para o
// badge do menu. Usa as mesmas queries filtradas do scheduler (`where` no
// Firestore) em vez de `listTasks()` — evita ler a coleção inteira a cada
// poll de 2min do painel, que já estourou a cota diária do Firestore antes.
adminRouter.get('/tasks/pending-count', async (req, res) => {
  try {
    const [due, fired] = await Promise.all([getDueTasks(), getFiredUnconfirmed(dayKey())]);
    res.json({ count: due.length + fired.length });
  } catch (err) {
    console.error('[tasks] erro ao contar pendências:', err);
    res.status(500).json({ error: 'Erro ao contar pendências' });
  }
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

  const { text, remindAt, done, subagentId, to, hasReminder } = req.body;
  const update: Record<string, unknown> = {};
  if (text !== undefined) update.text = text;
  if (hasReminder === false) update.hasReminder = false;
  if (remindAt !== undefined) {
    update.remindAt = remindAt;
    update.hasReminder = true;
    // Editar o horário rearma o disparo e os marcadores da fila sequencial —
    // mesma regra do editar_lembrete via WhatsApp (senão o painel poderia
    // "destravar" um lembrete que a fila considera confirmado).
    if (remindAt !== existing.remindAt && done === undefined) {
      update.done = false;
      update.completedAt = null;
    }
    update.firedAt = null;
    update.lastNudgeAt = null;
  }
  if (done !== undefined) {
    update.done = !!done;
    update.completedAt = done ? Date.now() : null;
  }
  if (subagentId !== undefined) update.subagentId = subagentId;
  if (to !== undefined) update.to = to;

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  await updateTask(req.params.id, update);

  // Propaga para os BLOCOS da agenda ligados a este lembrete (taskId): mover
  // ou renomear o lembrete pelo painel também move/renomeia o cronograma, e
  // confirmar o lembrete conclui o bloco — mesma regra do editar_lembrete /
  // concluir_lembrete via WhatsApp (evita o "editei/confirmei aqui e o bloco
  // ficou órfão ou continuou cobrando na agenda").
  if (text !== undefined || remindAt !== undefined || done === true) {
    const linked = (await getAgendaItemsByTaskId(req.params.id)).filter((i) => i.status !== 'done');
    for (const item of linked) {
      const itemUpdate: Record<string, unknown> = {};
      if (text !== undefined) itemUpdate.title = text;
      if (remindAt !== undefined) {
        const when = new Date(remindAt);
        const [sh, sm] = item.startTime.split(':').map(Number);
        const [eh, em] = item.endTime.split(':').map(Number);
        const dur = Math.max(5, (eh * 60 + em - (sh * 60 + sm) + 1440) % 1440);
        const startTime = timeKey(when);
        const [nh, nm] = startTime.split(':').map(Number);
        const endMin = nh * 60 + nm + dur;
        itemUpdate.date = dayKey(when);
        itemUpdate.startTime = startTime;
        itemUpdate.endTime = `${String(Math.floor(endMin / 60) % 24).padStart(2, '0')}:${String(
          endMin % 60
        ).padStart(2, '0')}`;
        itemUpdate.nudgedAt = null;
      }
      if (done === true) {
        itemUpdate.status = 'done';
        itemUpdate.completedAt = Date.now();
      }
      await updateAgendaItem(item.id, itemUpdate);
    }
  }

  res.json({ ok: true });
});

// Remove uma tarefa
adminRouter.delete('/tasks/:id', async (req, res) => {
  const existing = await getTask(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tarefa não encontrada' });
  await deleteTask(req.params.id);
  // Remove também os blocos da agenda ligados — mesma regra do remover_lembrete
  // via WhatsApp (evita o cronograma cobrar um compromisso que não existe mais).
  const linked = (await getAgendaItemsByTaskId(req.params.id)).filter((i) => i.status !== 'done');
  for (const item of linked) {
    await deleteAgendaItem(item.id);
  }
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
// Body opcional { taskIds: string[] }: quando presente, só ESSAS tarefas viram
// bloco (o "escolho tudo ou só alguns" do painel). Ausente/vazio = todas.
adminRouter.post('/agenda/generate', async (req, res) => {
  try {
    const date = (req.query.date as string)?.trim() || dayKey();
    const force = req.query.force === 'true';
    const maxMinutesRaw = Number(req.query.maxMinutes);
    const body = req.body as Record<string, unknown> | undefined;
    const rawIds = body?.taskIds;
    const taskIds = Array.isArray(rawIds)
      ? rawIds.map((id) => String(id)).filter(Boolean)
      : undefined;
    const tasks = Array.isArray(body?.tasks)
      ? body.tasks
          .map((entry) => {
            const task = entry as Record<string, unknown>;
            const id = String(task.id || '').trim();
            if (!id) return null;
            const priority = Number(task.priority);
            const estimatedMinutes = Number(task.estimatedMinutes);
            return {
              id,
              priority: Number.isFinite(priority) ? priority : undefined,
              estimatedMinutes: Number.isFinite(estimatedMinutes) ? estimatedMinutes : undefined,
            };
          })
          .filter((task): task is NonNullable<typeof task> => task !== null)
      : undefined;
    const items = await generateDailySchedule(date, force, {
      startTime: (req.query.startTime as string) || undefined,
      endTime: (req.query.endTime as string) || undefined,
      maxMinutes: Number.isFinite(maxMinutesRaw) && maxMinutesRaw > 0 ? maxMinutesRaw : undefined,
      taskIds,
      tasks,
    });
    res.json({ date, count: items.length, items });
  } catch (err) {
    console.error('[agenda] erro ao gerar cronograma:', err);
    res.status(500).json({ error: 'Erro ao organizar agenda' });
  }
});

// Conclui um item da agenda e avança para o próximo (modo secretário).
// Reusa advanceTask: propaga a conclusão para a Task de origem (taskId) e
// anuncia o próximo item no WhatsApp — mantendo tela e WhatsApp sincronizados.
adminRouter.post('/agenda/:id/advance', async (req, res) => {
  try {
    const existing = await getAgendaItem(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Item de agenda não encontrado' });
    await advanceTask(existing);
    const items = await getAgendaForDay(existing.date);
    const next = items.find((i) => i.status === 'pending' || i.status === 'in_progress') || null;
    res.json({ ok: true, items, next });
  } catch (err) {
    console.error('[agenda] erro ao avançar item:', err);
    res.status(500).json({ error: 'Erro ao concluir e avançar' });
  }
});

adminRouter.post('/tasks/:id/action', async (req, res) => {
  try {
    const existing = await getTask(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Tarefa não encontrada' });

    const action = String(req.body?.action || '').trim();
    if (action === 'done') {
      await markTaskDone(req.params.id);
      return res.json({ ok: true });
    }
    if (action === 'discard') {
      await deleteTask(req.params.id);
      return res.json({ ok: true });
    }

    const next = new Date(existing.remindAt);
    if (action === 'postpone_1h') {
      next.setHours(next.getHours() + 1);
    } else if (action === 'tomorrow') {
      next.setDate(next.getDate() + 1);
      next.setHours(9, 0, 0, 0);
    } else {
      return res.status(400).json({ error: 'Ação inválida' });
    }

    await updateTask(req.params.id, {
      remindAt: next.toISOString(),
      hasReminder: true,
      done: false,
      completedAt: null,
      postponedCount: (existing.postponedCount ?? 0) + 1,
    });
    return res.json({ ok: true, remindAt: next.toISOString() });
  } catch (err) {
    console.error('[tasks] erro ao executar ação rápida:', err);
    res.status(500).json({ error: 'Erro ao executar ação rápida' });
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

    // Agenda e Tarefas representam o mesmo compromisso quando há taskId.
    // Concluir/reabrir em qualquer tela precisa manter os dois lados iguais.
    if (existing.taskId && update.status !== undefined) {
      if (update.status === 'done') {
        await markTaskDone(existing.taskId);
      } else if (update.status === 'pending' && existing.status === 'done') {
        await updateTask(existing.taskId, { done: false, completedAt: null });
      }
    }

    // Propaga para o LEMBRETE que originou este bloco: mover/renomear o bloco
    // pelo painel também move/renomeia o lembrete — mesma regra do
    // editar_item_agenda via WhatsApp (evita o lembrete tocar no dia/horário
    // antigo depois que o bloco já foi movido no cronograma).
    if (existing.taskId && (update.title !== undefined || update.date || update.startTime)) {
      const task = await getTask(existing.taskId);
      if (task && !task.completedAt) {
        const taskUpdate: Record<string, unknown> = {};
        if (update.title !== undefined) taskUpdate.text = update.title;
        if (update.date || update.startTime) {
          const date = update.date || existing.date;
          const startTime = update.startTime || existing.startTime;
          const when = parseLocalIso(`${date}T${startTime}:00`);
          taskUpdate.remindAt = when.toISOString();
          taskUpdate.done = false;
          taskUpdate.firedAt = null;
          taskUpdate.lastNudgeAt = null;
        }
        await updateTask(task.id, taskUpdate);
      }
    }

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
    // Cancela também o LEMBRETE que originou o bloco — mesma regra do
    // remover_item_agenda via WhatsApp. Recorrentes ficam: a ocorrência some,
    // a série continua.
    if (existing.taskId) {
      const task = await getTask(existing.taskId);
      if (task && !task.recurrence && !task.completedAt) {
        await deleteTask(task.id);
      }
    }
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
