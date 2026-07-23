import { Subagent } from '../types';
import { config } from '../config';
import { chatJson, ChatMessage } from '../services/openai';
import {
  listSubagents,
  getRecentMemory,
  appendMemory,
  recordMessage,
  recordRouteMiss,
  listTasks,
  createTask,
  updateAgendaItem,
  getTask,
  updateTask,
  markTaskDone,
  deleteTask,
} from '../services/firebase';
import { runSubagent, ORCHESTRATOR_NAME } from './subagents';
import { tryHandleCommand } from './commands';
import {
  logExchange,
  recentExchanges,
  relevantPastExchanges,
  formatEntry,
} from '../services/memory';
import { getActiveItem, advanceTask } from './orchestrator';
import { routeByEmbedding, hintFrom, EmbeddingRoute } from './embeddingRouter';
import { routeByLearnedExample, learnRouteExample } from './routeShortcut';
import { beginUndoGroup, recordUndo } from './undo';
import { addDays, dayKey, parseLocalIso } from '../services/datetime';

/** Frases curtas que indicam conclusão da tarefa atual (atalho do híbrido). */
const DONE_PHRASES = [
  'terminei',
  'terminado',
  'concluí',
  'conclui',
  'concluído',
  'concluido',
  'finalizei',
  'pronto',
  'feito',
  'acabei',
  'já fiz',
  'ja fiz',
];

/**
 * Regex que casa qualquer DONE_PHRASE como PALAVRA inteira (não substring), para
 * não confundir "perfeito" com "feito" nem "prontidão" com "pronto". A fronteira
 * é qualquer caractere que não seja letra (inclui acentos) ou a borda do texto.
 */
const DONE_REGEX = new RegExp(
  `(^|[^\\p{L}])(${DONE_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})([^\\p{L}]|$)`,
  'iu'
);

/**
 * Palavras de preenchimento toleradas ao redor de uma confirmação ("sim, já
 * terminei!", "ok pronto"). Não carregam conteúdo, então não impedem o atalho.
 */
const FILLER_WORDS = new Set([
  'sim',
  'ok',
  'okay',
  'já',
  'ja',
  'tudo',
  'agora',
  'então',
  'entao',
  'pois',
  'é',
  'e',
  'isso',
  'aí',
  'ai',
  'tá',
  'ta',
  'está',
  'esta',
  'foi',
  'consegui',
  'a',
  'o',
  'esse',
  'essa',
  'task',
  'tarefa',
  'item',
]);

/**
 * Remove TODAS as ocorrências de frases de conclusão da mensagem e devolve as
 * palavras de conteúdo restantes (descartando pontuação e fillers). Se sobrar
 * vazio, a mensagem é uma confirmação "pura".
 */
function leftoverContentWords(lower: string): string[] {
  // Tira as frases de conclusão (com fronteira de palavra).
  let rest = lower;
  for (const p of DONE_PHRASES) {
    rest = rest.replace(
      new RegExp(`(^|[^\\p{L}])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'giu'),
      ' '
    );
  }
  return rest
    .split(/[^\p{L}]+/u)
    .filter((w) => w && !FILLER_WORDS.has(w));
}

/**
 * Decide se a mensagem é uma confirmação PURA de conclusão (somente frases de
 * conclusão + fillers, sem outras palavras de conteúdo). Pura e exportada para
 * os evals de regressão (npm run eval) — falso positivo aqui conclui tarefa
 * errada, então cada mudança nas listas acima precisa passar pelos casos.
 */
export function isPureDoneConfirmation(text: string): boolean {
  const lower = text.trim().toLowerCase();
  // Só dispara para mensagens curtas, evitando falsos positivos em textos longos.
  if (lower.length > 40) return false;
  // Uma pergunta não é uma confirmação de conclusão (ex: "feito o quê?").
  if (lower.includes('?')) return false;
  if (!DONE_REGEX.test(lower)) return false;
  // Blindagem: a mensagem precisa ser SÓ a confirmação. Se sobrar qualquer
  // palavra de conteúdo após remover frases de conclusão e fillers, não dispara.
  return leftoverContentWords(lower).length === 0;
}

/**
 * True quando a mensagem é uma confirmação de conclusão CURTA e quase-pura o
 * suficiente para ser tratada como "concluí um item da agenda" — e portanto
 * roteada ao orquestrador, que tem as ferramentas de concluir. Aceita um resto
 * pequeno de conteúdo ("a tarefa das 9h" → resto ["9h"]) mas rejeita frases de
 * assunto que só por acaso contêm um verbo de conclusão ("acabei de mandar o
 * relatório pro cliente"). Assim a âncora de agenda não sequestra conversa de
 * negócio. Exportada para os evals de regressão.
 */
export function looksLikeAgendaDoneConfirmation(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (lower.includes('?')) return false;
  if (lower.length > 60) return false; // frase longa é assunto, não confirmação
  if (!DONE_REGEX.test(lower)) return false;
  // Depois de tirar as frases de conclusão e os fillers, uma confirmação de
  // agenda deixa no máximo 2 palavras de "alvo" (ex: "tarefa das 9h", "item 2").
  // Uma frase de negócio deixa muito mais ("mandar relatório cliente").
  return leftoverContentWords(lower).length <= 2;
}

/** Quantidade explícita numa confirmação plural ("feito os 2", "fiz ambos"). */
export function explicitDoneCount(text: string): number | null {
  const lower = text.trim().toLowerCase();
  if (!DONE_REGEX.test(lower) || lower.includes('?')) return null;
  if (/\b(ambos|ambas|os dois|as duas)\b/i.test(lower)) return 2;
  const match = lower.match(/\b(?:os|as|esses|essas)?\s*(\d{1,2})\b/i);
  if (!match) return null;
  const count = Number(match[1]);
  return count >= 2 && count <= 10 ? count : null;
}

/**
 * Atalho de conclusão: dispara só quando a mensagem é uma confirmação PURA e há
 * um item em andamento na agenda. Retorna a resposta a enviar, ou null se não
 * se aplica.
 */
async function tryAdvanceAgenda(contact: string, text: string): Promise<string | null> {
  if (!isPureDoneConfirmation(text)) return null;

  const active = await getActiveItem();
  if (!active || active.status !== 'in_progress') return null;

  // Captura o estado anterior (item + task vinculada) para o "desfaz" funcionar
  // se o "feito" tiver sido confirmação de outra coisa e concluído item errado.
  let taskPrev: { remindAt: string; done: boolean; completedAt: number | null } | null = null;
  if (active.taskId) {
    const t = await getTask(active.taskId);
    if (t) taskPrev = { remindAt: t.remindAt, done: t.done, completedAt: t.completedAt ?? null };
  }

  await advanceTask(active);
  const agendaRestore = {
    status: active.status,
    completedAt: active.completedAt ?? null,
  };
  recordUndo(
    contact,
    `a conclusão de "${active.title}" (atalho "feito")`,
    async () => {
      // Restaura também o completedAt: desfazer a conclusão não pode deixar uma
      // "duração medida" órfã contaminando a calibração de estimativas.
      await updateAgendaItem(active.id, agendaRestore);
      if (active.taskId && taskPrev) await updateTask(active.taskId, taskPrev);
    },
    [
      { kind: 'agenda.update', id: active.id, data: agendaRestore },
      ...(active.taskId && taskPrev
        ? [{ kind: 'task.update' as const, id: active.taskId, data: taskPrev }]
        : []),
    ]
  );
  // advanceTask já envia a mensagem de transição; aqui evitamos resposta duplicada.
  return '';
}

function normalizeTaskText(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((w) => w.length >= 3 && !FILLER_WORDS.has(w));
}

function taskScore(queryWords: string[], taskText: string): number {
  if (queryWords.length === 0) return 0;
  const taskWords = normalizeTaskText(taskText);
  const taskSet = new Set(taskWords);
  const hits = queryWords.filter((w) => taskSet.has(w) || taskText.toLowerCase().includes(w));
  return hits.length / queryWords.length;
}

/**
 * Palavras que servem só de "moldura" do comando (verbos de adiar/concluir,
 * advérbios de tempo, preposições) — presentes em quase toda frase de ação e,
 * por isso, INÚTEIS para identificar QUAL tarefa o Igor citou. Sem removê-las,
 * "elexandre amanhã às 10 horas" casaria com qualquer tarefa por causa de
 * "amanhã"/"horas", e o atalho adiaria a errada. Só o resto (o "conteúdo" que
 * aponta para a tarefa) conta no score.
 */
const COMMAND_FRAME_WORDS = new Set([
  'adia', 'adiar', 'adie', 'adiado', 'amanha', 'amanhã', 'hoje', 'agora',
  'mais', 'tarde', 'cedo', 'depois', 'antes', 'hora', 'horas', 'minuto',
  'minutos', 'dia', 'dias', 'semana', 'mes', 'mês', 'para', 'pra', 'pro',
  'concluir', 'concluido', 'concluído', 'feito', 'terminei', 'terminado',
  'apaga', 'apague', 'remove', 'remova', 'descarta', 'descarte', 'cancela',
  'cancele', 'marca', 'marque', 'deixa', 'deixe', 'coloca', 'coloque',
]);

/**
 * Localiza a tarefa que o Igor citou numa frase natural de comando.
 *
 * `requireContentMatch` (padrão): só devolve tarefa quando o texto tem
 * palavras de CONTEÚDO (fora a moldura do comando) que casam com o título de
 * uma tarefa existente. Se a frase não aponta para nenhuma tarefa conhecida —
 * ex: "elexandre amanhã às 10 horas", que é um pedido de CRIAR algo novo —
 * devolve null, e a mensagem segue para a LLM decidir em vez de o atalho
 * adivinhar (e adiar/concluir a tarefa errada).
 *
 * `fallbackToLatestFired` (só para respostas a uma cobrança de lembrete, onde
 * o alvo é óbvio pelo contexto): quando não há conteúdo que case, assume o
 * último lembrete disparado sem confirmação.
 */
async function findTaskByNaturalText(
  query: string,
  opts: { requireContentMatch?: boolean; fallbackToLatestFired?: boolean } = {}
) {
  const { requireContentMatch = true, fallbackToLatestFired = false } = opts;
  // Só as palavras de CONTEÚDO — a moldura do comando não identifica tarefa.
  const queryWords = normalizeTaskText(query).filter((w) => !COMMAND_FRAME_WORDS.has(w));
  const candidates = (await listTasks()).filter((t) => !t.completedAt);
  const latestFired = () =>
    candidates.filter((t) => t.done).sort((a, b) => b.remindAt.localeCompare(a.remindAt))[0] ?? null;

  if (queryWords.length === 0) {
    // Sem conteúdo: só resolve por fallback quando o contexto garante o alvo
    // (resposta a uma cobrança). Caso contrário, deixa a LLM tratar.
    return fallbackToLatestFired ? latestFired() : null;
  }
  const ranked = candidates
    .map((task) => ({ task, score: taskScore(queryWords, task.text) }))
    .filter((item) => item.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.task.remindAt.localeCompare(b.task.remindAt));
  if (ranked[0]?.task) return ranked[0].task;
  // Havia conteúdo, mas nada casou. Só cai no fallback quando explicitamente
  // pedido E não estamos exigindo match de conteúdo — nunca adivinha por conta.
  if (fallbackToLatestFired && !requireContentMatch) return latestFired();
  return null;
}

/**
 * True quando um pedido de adiamento traz um DESTINO temporal específico
 * (horário como "15h"/"14:30", período como "de tarde", ou um dia como "sexta"/
 * "dia 25"/"25/07") — exceto o "+1 hora", que o atalho sabe aplicar sozinho.
 * Quando true, o atalho de adiamento recua para a LLM, que remarca no horário/
 * dia EXATO pedido via editar_lembrete. Exportada para os evals de regressão.
 */
export function postponeHasSpecificTarget(text: string): boolean {
  const isPlusOneHour = /\b(1h|uma hora|1 hora)\b/i.test(text);
  const hasSpecificTime = /\b(\d{1,2}\s*(?:h|hs|horas?|:\s*\d{2})|meio[- ]dia|meia[- ]noite|de\s+(?:manh[ãa]|tarde|noite)|pela\s+(?:manh[ãa]|tarde|noite))\b/i.test(
    text
  );
  const hasSpecificDay = /\b(segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|semana que vem|pr[óo]xima semana|dia\s+\d{1,2}|\d{1,2}[\/.]\d{1,2})\b/i.test(
    text
  );
  return (hasSpecificTime && !isPlusOneHour) || hasSpecificDay;
}

async function tryNaturalTaskCommand(contact: string, text: string): Promise<string | null> {
  const lower = text.trim().toLowerCase();
  if (lower.includes('?')) return null;

  if (/\b(lista|liste|mostra|mostrar|quais)\b.*\b(pend[eê]ncias?|pendentes?|tarefas?|lembretes?)\b/i.test(text)) {
    const tasks = (await listTasks())
      .filter((t) => !t.completedAt)
      .sort((a, b) => a.remindAt.localeCompare(b.remindAt))
      .slice(0, 15);
    if (tasks.length === 0) return 'Você não tem tarefas ou lembretes pendentes agora.';
    const linhas = tasks.map((t) => {
      const status = t.done ? 'tocou sem confirmação' : 'pendente';
      return `• ${t.text} — ${new Date(t.remindAt).toLocaleString('pt-BR', { timeZone: config.timezone })} (${status})`;
    });
    return `📋 *Pendências atuais:*\n${linhas.join('\n')}`;
  }

  if (DONE_REGEX.test(lower)) {
    const explicitCount = explicitDoneCount(text);
    if (explicitCount) {
      const nowIso = new Date().toISOString();
      const candidates = (await listTasks())
        .filter((t) => !t.completedAt && (t.done || t.remindAt <= nowIso))
        .sort(
          (a, b) =>
            Number(b.done) - Number(a.done) ||
            (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
            b.remindAt.localeCompare(a.remindAt)
        )
        .slice(0, explicitCount);
      if (candidates.length === 0) {
        return 'Não encontrei tarefas recentes pendentes para marcar como concluídas.';
      }
      for (const task of candidates) {
        await markTaskDone(task.id);
        recordUndo(
          contact,
          `a conclusão de "${task.text}" por confirmação plural`,
          () => updateTask(task.id, { done: task.done, completedAt: task.completedAt ?? null }),
          [
            {
              kind: 'task.update',
              id: task.id,
              data: { done: task.done, completedAt: task.completedAt ?? null },
            },
          ]
        );
      }
      const lines = candidates.map((task) => `• ${task.text}`).join('\n');
      return `✅ Marquei como ${candidates.length > 1 ? 'concluídos' : 'concluído'}:\n${lines}`;
    }

    // "feito"/"terminei" puro (sem citar tarefa) responde à última cobrança;
    // se citar um título, tem que casar de verdade.
    const task = await findTaskByNaturalText(text, {
      requireContentMatch: true,
      fallbackToLatestFired: true,
    });
    // Nada casou com CERTEZA. Em vez de responder uma negativa fixa ("não achei
    // esse título") — que é o atalho decidindo sem contexto e errando —, RECUA:
    // devolve null para a mensagem seguir à LLM/orquestrador, que enxerga a
    // agenda e o histórico do dia e resolve "concluí a tarefa das 9h" com
    // contexto. Era exatamente o bug: a tarefa citava o cronograma (citação do
    // WhatsApp poluía o texto), o score não batia, e o bot mentia "não achei".
    if (!task) {
      return null;
    }
    await markTaskDone(task.id);
    recordUndo(
      contact,
      `a conclusão de "${task.text}" por frase natural`,
      () => updateTask(task.id, { done: task.done, completedAt: task.completedAt ?? null }),
      [{ kind: 'task.update', id: task.id, data: { done: task.done, completedAt: task.completedAt ?? null } }]
    );
    return `✅ Marquei como concluído: *${task.text}*.`;
  }

  if (/\b(apaga|apague|remove|remova|descarta|descarte|cancela|cancele)\b/i.test(text)) {
    // Apagar exige saber O QUÊ: só age quando o texto casa com uma tarefa. Sem
    // alvo claro, retorna null e a LLM pede o esclarecimento.
    const task = await findTaskByNaturalText(text, { requireContentMatch: true });
    if (!task) return null;
    await deleteTask(task.id);
    recordUndo(
      contact,
      `a remoção de "${task.text}" por frase natural`,
      () => updateTask(task.id, task),
      [{ kind: 'task.create', data: task }]
    );
    return `🗑️ Removi: *${task.text}*.`;
  }

  // Gatilho de adiamento: exige um verbo de adiar EXPLÍCITO (ou "mais tarde").
  // "amanhã" sozinho NÃO ativa — "elexandre amanhã às 10h" é criar algo novo,
  // não adiar; deixar o mero "amanhã" disparar fazia o atalho adiar a tarefa
  // errada. O adiamento também só age sobre uma tarefa que o texto REALMENTE
  // cita; sem alvo claro, passa para a LLM.
  if (/\b(adia|adiar|adie|adiar?\s+(?:pra|para)|remarca|remarcar|empurra|posterga|mais tarde)\b/i.test(text)) {
    // RECUA se o Igor especificou um DESTINO temporal (horário ou dia): o atalho
    // só sabe fazer "+1h" e "+1 dia às 09:00" — qualquer outro alvo ("adia pra
    // 15h", "remarca pra sexta", "de tarde") era DESCARTADO e a tarefa caía nas
    // 9h do dia seguinte, ignorando o pedido. Nesses casos, deixa a LLM tratar
    // via editar_lembrete, que respeita o horário/dia exato. Fica com o atalho
    // só o adiamento genérico ("adia isso", "empurra pra amanhã", "+1h").
    const isPlusOneHour = /\b(1h|uma hora|1 hora)\b/i.test(text);
    if (postponeHasSpecificTarget(text)) return null;

    const task = await findTaskByNaturalText(text, {
      requireContentMatch: true,
      fallbackToLatestFired: true,
    });
    if (!task) return null;
    // Aritmética de data no fuso do Igor (não no do servidor, que é UTC no
    // container): +1h desloca o instante; "amanhã 09:00" recompõe a partir do
    // dia LOCAL do lembrete via parseLocalIso.
    let next: Date;
    if (isPlusOneHour) {
      next = new Date(new Date(task.remindAt).getTime() + 3600_000);
    } else {
      const nextDay = addDays(dayKey(new Date(task.remindAt)), 1);
      next = parseLocalIso(`${nextDay}T09:00:00`);
    }
    await updateTask(task.id, {
      remindAt: next.toISOString(),
      done: false,
      completedAt: null,
      postponedCount: (task.postponedCount ?? 0) + 1,
    });
    recordUndo(
      contact,
      `o adiamento de "${task.text}" por frase natural`,
      () =>
        updateTask(task.id, {
          remindAt: task.remindAt,
          done: task.done,
          completedAt: task.completedAt ?? null,
          postponedCount: task.postponedCount,
        }),
      [
        {
          kind: 'task.update',
          id: task.id,
          data: {
            remindAt: task.remindAt,
            done: task.done,
            completedAt: task.completedAt ?? null,
            postponedCount: task.postponedCount,
          },
        },
      ]
    );
    return `⏰ Adiei *${task.text}* para ${next.toLocaleString('pt-BR', { timeZone: config.timezone })}.`;
  }

  return null;
}

const TASK_ACTION_START = /^(melhorar|mandar|fazer|criar|enviar|ligar|pagar|resolver|revisar|definir|escrever|estudar|organizar|comprar|finalizar|corrigir|integrar|abrir|instalar|preparar|publicar|montar|seguir|atualizar|implementar)\b/i;

/**
 * Cabeçalho de PLANEJAMENTO com um dia: a primeira linha de uma lista que diz
 * PARA QUANDO são as tarefas seguintes — "Planejamento para sábado", "Metas de
 * segunda", "Tarefas de amanhã", "Plano dia 25". Quando existe, a lista NÃO é
 * uma captura sem prazo: as tarefas têm data, e montar o cronograma daquele dia
 * é trabalho da LLM (que resolve "sábado" → data e agenda cada item). Detectar
 * isso faz a captura simples recuar e deixar a LLM assumir.
 */
const PLANNING_HEADER =
  /^\s*(?:planejamento|plano|planej[ae]r|agenda|cronograma|metas?|objetivos?|tarefas?|afazeres|to-?do|lista)\b.*\b(?:hoje|amanh[ãa]|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|semana|fim de semana|dia\s+\d{1,2}|\d{1,2}[\/.]\d{1,2})\b/i;

/**
 * True quando a primeira linha da mensagem é um cabeçalho de planejamento com
 * dia. Nesse caso a mensagem deve ir para a LLM montar o plano, não virar
 * captura de tarefas sem prazo.
 */
export function hasPlanningHeaderWithDay(text: string): boolean {
  const firstLine = text.split(/\r?\n/)[0]?.trim() ?? '';
  return PLANNING_HEADER.test(firstLine);
}

/**
 * Uma lista enviada em linhas separadas no WhatsApp é uma captura de tarefas.
 * Ela não deve cair em um subagente de assunto e virar apenas uma resposta de
 * consultoria. Cada linha vira uma tarefa sem prazo, visível no painel.
 *
 * EXCEÇÃO: se a primeira linha é um cabeçalho de planejamento com um dia
 * ("Planejamento para sábado"), as tarefas TÊM prazo — a LLM monta o
 * cronograma daquele dia. A captura simples recua (retorna null).
 */
export function extractWhatsappTaskList(text: string): string[] | null {
  if (!text.includes('\n') || text.includes('?')) return null;
  if (hasPlanningHeaderWithDay(text)) return null;
  const tasks = text
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^(?:[-•*]|\d+[.)])\s*/, '')
        .replace(/^priorit[áa]ri[oa]\s*[-:–—]\s*/i, '')
    )
    .filter(Boolean);
  if (tasks.length < 2 || tasks.length > 8 || tasks.some((task) => task.length < 3)) return null;
  return tasks.some((task) => TASK_ACTION_START.test(task)) ? tasks : null;
}

async function tryCreateWhatsappTaskList(contact: string, text: string): Promise<string | null> {
  const tasks = extractWhatsappTaskList(text);
  if (!tasks) return null;

  const existing = await listTasks();
  const created: string[] = [];
  for (const taskText of tasks) {
    const alreadyExists = existing.some(
      (task) => !task.completedAt && task.text.trim().toLocaleLowerCase('pt-BR') === taskText.toLocaleLowerCase('pt-BR')
    );
    if (alreadyExists) continue;
    const task = await createTask({
      text: taskText,
      // Tarefa sem horário: aparece em "Sem prazo" no painel, sem disparar WhatsApp.
      remindAt: new Date().toISOString(),
      hasReminder: false,
      to: contact,
      subagentId: 'captura-whatsapp',
    });
    recordUndo(contact, `a criação da tarefa "${task.text}"`, () => deleteTask(task.id), [
      { kind: 'task.delete', id: task.id },
    ]);
    created.push(task.text);
  }
  if (created.length === 0) return '✅ Essas tarefas já estão registradas.';
  const label = created.length === 1 ? 'tarefa' : 'tarefas';
  return `✅ Criei ${created.length} ${label} sem prazo:\n${created.map((task) => `• ${task}`).join('\n')}`;
}

/**
 * Prioridades declaradas para amanhã são lembretes, não pedidos de planejamento.
 * A forma imperativa usada pelo Igor ("primeira coisa que vai fazer amanhã,
 * X") é deliberadamente aceita sem exigir as palavras "me lembra".
 */
export function extractTomorrowReminder(text: string): { text: string; firstThing: boolean } | null {
  if (text.includes('?')) return null;
  const clean = text.trim().replace(/[.!]+$/, '');
  const patterns: Array<{ regex: RegExp; firstThing: boolean }> = [
    {
      regex: /^(?:a\s+)?primeira\s+coisa\s+(?:que\s+)?(?:(?:eu\s+)?vou|vai|tenho\s+que|preciso)\s+fazer\s+amanh[ãa]\s*[,;:—–-]?\s*(.+)$/i,
      firstThing: true,
    },
    {
      regex: /^(?:amanh[ãa]\s*[,;:—–-]?\s*)?primeira\s+coisa\s+amanh[ãa]\s*[,;:—–-]?\s*(.+)$/i,
      firstThing: true,
    },
    {
      regex: /^amanh[ãa]\s+(?:(?:eu\s+)?vou|preciso|tenho\s+que|devo)\s+(.+)$/i,
      firstThing: false,
    },
  ];
  for (const { regex, firstThing } of patterns) {
    const match = clean.match(regex);
    const reminder = match?.[1]?.trim().replace(/^[,;:—–-]+\s*/, '');
    if (reminder && reminder.length >= 3) return { text: reminder, firstThing };
  }
  return null;
}

async function tryCreateTomorrowReminder(contact: string, text: string): Promise<string | null> {
  const intent = extractTomorrowReminder(text);
  if (!intent) return null;

  const tomorrow = addDays(dayKey(), 1);
  const remindAt = parseLocalIso(`${tomorrow}T${config.defaultReminderTime}:00`).toISOString();
  const duplicate = (await listTasks()).find(
    (task) =>
      !task.completedAt &&
      task.remindAt === remindAt &&
      task.text.trim().toLocaleLowerCase('pt-BR') === intent.text.toLocaleLowerCase('pt-BR')
  );
  if (duplicate) {
    return `✅ Esse lembrete já está salvo para amanhã às ${config.defaultReminderTime}: *${duplicate.text}*.`;
  }

  const created = await createTask({
    text: intent.text,
    remindAt,
    to: contact,
    subagentId: 'prioridade-direta',
  });
  recordUndo(
    contact,
    `a criação do lembrete "${created.text}"`,
    () => deleteTask(created.id),
    [{ kind: 'task.delete', id: created.id }]
  );
  const prefix = intent.firstThing ? ' como primeira coisa' : '';
  return `✅ Lembrete salvo para amanhã às ${config.defaultReminderTime}${prefix}: *${created.text}*.`;
}

/**
 * Sinais de que o usuário está CORRIGINDO algo que o agente fez ou disse.
 * Quando detectado, o subagente é instruído a reconhecer, consertar e salvar a
 * lição na memória compartilhada — para o erro não se repetir.
 */
const CORRECTION_REGEX =
  /\b(errado|errada|errou|não era isso|nao era isso|não foi isso|nao foi isso|não é isso|nao é isso|entendeu errado|corrige isso|corrigindo|não pedi isso|nao pedi isso|você tinha dito|voce tinha dito)\b/i;

/**
 * Correção de ROTA: o Igor diz que a mensagem anterior era de outro assunto
 * ("não, isso é de vendas", "manda pro estudos", "isso aí é do blog"). Detecta
 * pela combinação de um SINAL de correção/negação com um de DIRECIONAMENTO a
 * assunto. Mais abrangente que CORRECTION_REGEX de propósito — alimenta o
 * aprendizado de roteamento (routeShortcut), que só age quando a correção MUDA
 * de subagente, então um falso positivo aqui é inofensivo.
 */
// "não," / "não é" / "não era" (correção) — não "não esquece" (negação comum).
const ROUTE_CORRECTION_SIGNAL = /(\bn[ãa]o\s*[,.]|\bn[ãa]o (é|e|era|foi)\b|\bna verdade\b|\bquis dizer\b|\bisso (é|e|a[íi])\b)/i;
const ROUTE_DIRECTION_SIGNAL = /\b(de|do|da|dos|das|pro|pra|para)\b/i;
// Direcionamento imperativo ("manda/joga/põe pro X") já é, sozinho, correção de
// rota — não precisa do sinal de negação.
const ROUTE_IMPERATIVE = /\b(manda|mande|joga|jogue|p[õo]e|coloca|coloque|envia|envie|passa|passe)\b.*\b(pro|pra|para|no|na)\b/i;

function isRouteCorrectionText(text: string): boolean {
  if (ROUTE_IMPERATIVE.test(text)) return true;
  return ROUTE_CORRECTION_SIGNAL.test(text) && ROUTE_DIRECTION_SIGNAL.test(text);
}

/**
 * Pedidos claramente de AGENDA (organizar o dia, horários, lembretes, remarcar).
 * Vão direto para o subagente orquestrador, que é o ÚNICO com as ferramentas de
 * agenda (criar_evento, realocar_agenda...). Sem isso, "organiza minha tarde"
 * pode cair num subagente de negócio que não tem como criar nada — e responde
 * texto bonito sem persistir (foi o bug do bloco da tarde de 10/06/2026).
 */
export const AGENDA_REGEX =
  /\b(agenda|agendar?|agende|cronograma|compromissos?|lembretes?|me lembra|remarcar?|remarque|reagendar?|reagende|adiar?|adia|hor[áa]rios?|encaixar?|encaixe|reorganizar?|reorganize|planeja(r)? (o |meu )?dia|minha (tarde|manh[ãa]|semana|noite)|meu (dia|m[êe]s))\b/i;

/**
 * Cara de AGENDAMENTO por horário explícito: um dia (hoje/amanhã/dia da semana)
 * combinado com uma hora ("às 10h", "10 horas", "14:30"). Frases assim ("falar
 * com o Alexandre amanhã às 10h") são pedidos de criar lembrete/evento, mesmo
 * sem as palavras "agenda"/"lembra" — devem ir ao orquestrador, que tem as
 * ferramentas, e não virar resposta consultiva. Exige os DOIS sinais (dia + hora)
 * para não capturar conversa comum que só menciona um horário de passagem.
 */
export const SCHEDULE_HINT_REGEX =
  /\b(hoje|amanh[ãa]|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|depois de amanh[ãa])\b.*\b(\d{1,2}\s*(?:h|hs|horas?|:\s*\d{2})|meio[- ]dia|meia[- ]noite)\b|\b(\d{1,2}\s*(?:h|hs|horas?|:\s*\d{2}))\b.*\b(hoje|amanh[ãa]|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)\b/i;

/**
 * Última rota por contato, para dar continuidade a mensagens curtas/ambíguas
 * ("e amanhã?", "muda pra 15h") sem perder o assunto da conversa anterior.
 * Em memória: sobrevive entre mensagens, zera num restart (aceitável).
 */
const lastRouteByContact = new Map<string, { subagentId: string; at: number }>();
const LAST_ROUTE_TTL_MS = 30 * 60 * 1000;

/** Janela em que uma correção ainda aponta para a troca anterior (F9). */
const ROUTE_MISS_WINDOW_MS = 5 * 60 * 1000;

/**
 * Tenta um roteamento rápido por palavras-chave antes de gastar uma
 * chamada de LLM. Retorna o melhor candidato com seu score, ou null.
 * Só o caller decide se o score basta — 1 keyword solta ("hoje", "agenda")
 * é fraca demais para decidir sozinha e ia parar no subagente errado.
 */
export function routeByKeywords(
  text: string,
  subagents: Subagent[]
): { sub: Subagent; score: number } | null {
  const lower = text.toLowerCase();
  let best: { sub: Subagent; score: number } | null = null;
  for (const sub of subagents) {
    const score = sub.keywords.reduce(
      (acc, kw) => (lower.includes(kw.toLowerCase()) ? acc + 1 : acc),
      0
    );
    if (score > 0 && (!best || score > best.score)) {
      best = { sub, score };
    }
  }
  return best;
}

/**
 * Usa o LLM para escolher o subagente quando as palavras-chave não bastam.
 * Considera o histórico recente para manter continuidade de assunto.
 */
export async function routeByLLM(
  text: string,
  subagents: Subagent[],
  recentContext: string,
  lastSubagentName?: string,
  keywordHint?: string,
  /** Para onde cair se o LLM responder algo inválido (continuidade > arbitrário). */
  fallback?: Subagent
): Promise<Subagent> {
  const list = subagents
    .map((s, i) => `${i + 1}. ${s.name} — temas: ${s.keywords.join(', ')}`)
    .join('\n');

  const continuidade = lastSubagentName
    ? `\nA última conversa foi com o subagente "${lastSubagentName}". Se a mensagem for curta,
ambígua ou continuação do mesmo assunto (ex: "e amanhã?", "muda pra 15h"), MANTENHA esse subagente.`
    : '';
  const hint = keywordHint
    ? `\nPalavras-chave sugerem "${keywordHint}", mas o contexto vale mais que a sugestão.`
    : '';

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Você é o roteador de um agente pessoal. Dada a mensagem do usuário e o contexto
recente, escolha o subagente mais adequado e responda com o número da opção no campo "numero".

Subagentes disponíveis:
${list}
${continuidade}${hint}

Se nenhum encaixar perfeitamente, escolha o mais próximo.`,
    },
    {
      role: 'user',
      content: `Contexto recente:\n${recentContext || '(sem histórico)'}\n\nMensagem: "${text}"\n\nNúmero do subagente:`,
    },
  ];

  // Structured Output: o modelo é obrigado a devolver UM inteiro — acaba a era
  // de extrair número de texto livre ("1 ou 2" já virou 12 e roteou errado).
  const result = await chatJson<{ numero: number }>(messages, {
    name: 'roteamento',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['numero'],
      properties: {
        numero: { type: 'integer', description: 'Número do subagente escolhido (1-based)' },
      },
    },
    temperature: 0,
    model: config.openai.utilityModel,
  });
  const idx = result ? result.numero - 1 : -1;
  if (idx >= 0 && idx < subagents.length) return subagents[idx];
  return fallback ?? subagents[0];
}

/**
 * Ponto de entrada do agente central: identifica o projeto/subagente,
 * roteia, executa e persiste a memória da conversa.
 *
 * @param contact identificador do contato (telefone) para memória
 * @param text texto já transcrito da mensagem do usuário
 * @param fromAudio true se a mensagem original era um áudio (já transcrito)
 */
export async function handleMessage(
  contact: string,
  text: string,
  fromAudio = false,
  quotedText?: string
): Promise<{
  reply: string;
  subagentId: string;
  subagentName: string;
  toolCalls: any[];
  elapsedMs: number;
  routedBy: string;
}> {
  // 0) Comandos administrativos (/criar, /agentes, /remover, ...) têm prioridade.
  const command = await tryHandleCommand(contact, text);
  if (command.handled) {
    return {
      reply: command.reply || '',
      subagentId: 'admin',
      subagentName: 'Comando Administrativo',
      toolCalls: [],
      elapsedMs: 0,
      routedBy: 'command',
    };
  }

  // Cada mensagem abre um grupo de undo: "desfaz" reverte TUDO que esta
  // mensagem causar (ex: 4 lembretes criados de uma vez), não só a última escrita.
  beginUndoGroup(contact);

  // Listas de tarefas do WhatsApp têm precedência sobre o roteamento por tema.
  const whatsappTaskList = await tryCreateWhatsappTaskList(contact, text);
  if (whatsappTaskList !== null) {
    return {
      reply: whatsappTaskList,
      subagentId: 'captura-whatsapp',
      subagentName: 'Tarefas',
      toolCalls: [],
      elapsedMs: 0,
      routedBy: 'whatsapp-task-list',
    };
  }

  // Prioridades declaradas para amanhã têm precedência sobre o roteamento por
  // assunto. Assim, "plano de monetização IA" vira lembrete, não consultoria.
  const tomorrowReminder = await tryCreateTomorrowReminder(contact, text);
  if (tomorrowReminder !== null) {
    return {
      reply: tomorrowReminder,
      subagentId: 'prioridade-direta',
      subagentName: 'Lembretes',
      toolCalls: [],
      elapsedMs: 0,
      routedBy: 'tomorrow-reminder',
    };
  }

  const naturalTaskCommand = await tryNaturalTaskCommand(contact, text);
  if (naturalTaskCommand !== null) {
    return {
      reply: naturalTaskCommand,
      subagentId: 'tasks',
      subagentName: 'Tarefas',
      toolCalls: [],
      elapsedMs: 0,
      routedBy: 'natural-task-command',
    };
  }

  // 0.5) Atalho de conclusão da tarefa atual ("terminei", "pronto", ...).
  //      Só do dono e quando há item em andamento na agenda.
  if (contact === config.ownerPhone || !config.ownerPhone) {
    const advanced = await tryAdvanceAgenda(contact, text);
    if (advanced !== null) {
      return {
        reply: advanced,
        subagentId: 'orchestrator',
        subagentName: 'Orquestrador Geral',
        toolCalls: [],
        elapsedMs: 0,
        routedBy: 'agenda-shortcut',
      };
    }
  }

  const subagents = await listSubagents();
  if (subagents.length === 0) {
    return {
      reply: 'Nenhum subagente configurado ainda. Crie um pelo painel admin ou pelo WhatsApp.',
      subagentId: 'admin',
      subagentName: 'Sistema',
      toolCalls: [],
      elapsedMs: 0,
      routedBy: 'system',
    };
  }

  // 1) Roteamento, do mais barato ao mais caro:
  //    regex de agenda → APRENDIDO (correção do Igor) → keywords (match forte
  //    >= 2) → EMBEDDING (decide quando a similaridade é forte e com folga) →
  //    LLM com contexto de continuidade, para que continuações curtas
  //    ("e amanhã?") fiquem no mesmo assunto.
  let target: Subagent | null = null;
  let via = 'agenda-regex';
  // Confirmação de conclusão ("já fiz", "concluí a tarefa") que o atalho NÃO
  // resolveu com certeza recua até aqui: precisa ir ao ORQUESTRADOR, o único com
  // as ferramentas de concluir tarefa (concluir_lembrete / concluir_tarefa_atual
  // + listar_lembretes para achar a certa). Sem esta âncora, "já foi feito"
  // cairia no roteamento por tema e poderia ir a um subagente de assunto que não
  // consegue concluir nada — foi o bug do "não achei nenhuma tarefa".
  //
  // CRITÉRIO ESTREITO de propósito: só uma confirmação CURTA e quase-pura ("já
  // fiz", "concluí a tarefa das 9h") vira âncora de agenda. Uma frase de negócio
  // que POR ACASO tem "acabei/pronto/já fiz" ("acabei de mandar o relatório pro
  // cliente", "já fiz o orçamento do paciente") continua indo ao subagente de
  // assunto — senão a âncora sequestraria conversa que não é de agenda.
  const isDoneConfirmation = looksLikeAgendaDoneConfirmation(text);
  if (AGENDA_REGEX.test(text) || SCHEDULE_HINT_REGEX.test(text) || isDoneConfirmation) {
    target =
      subagents.find((s) => s.name === ORCHESTRATOR_NAME) ??
      subagents.find((s) => /agenda/i.test(s.name)) ??
      null;
  }

  // 1.1) Atalho APRENDIDO: se a mensagem é muito parecida com alguma que o Igor
  //       já CORRIGIU, vai direto pro subagente certo. Vem ANTES das keywords de
  //       propósito: uma correção explícita do Igor é sinal mais forte que uma
  //       keyword genérica (ex: "predileto" puxa p/ Vendas, mas ele corrigiu p/
  //       Blog). Piso alto de similaridade não desvia mensagem legítima.
  if (!target) {
    const learned = await routeByLearnedExample(contact, text, subagents);
    if (learned) {
      target = learned.sub;
      via = `aprendido ${learned.score.toFixed(2)}`;
    }
  }

  const kw = target ? null : routeByKeywords(text, subagents);
  if (!target && kw && kw.score >= 2) {
    target = kw.sub;
    via = 'keywords';
  }

  // 1.5) Embedding: o vetor da mensagem sai do mesmo cache usado pelo RAG e
  //      pelo recall de fatos logo adiante — não custa chamada extra.
  let embRoute: EmbeddingRoute | null = null;
  if (!target) {
    embRoute = await routeByEmbedding(text, subagents);
    if (embRoute?.decided) {
      target = embRoute.sub;
      via = `embedding ${embRoute.score.toFixed(2)}/+${embRoute.margin.toFixed(2)}`;
    }
  }

  if (!target) {
    via = 'llm';
    const last = lastRouteByContact.get(contact);
    let lastSub =
      last && Date.now() - last.at < LAST_ROUTE_TTL_MS
        ? subagents.find((s) => s.id === last.subagentId) ?? null
        : null;
    // Pós-restart o Map está vazio; recupera a continuidade da última troca
    // persistida no log (mesma janela de 30 min), para um "muda pra 15h" logo
    // após um deploy não cair em subagente aleatório.
    if (!lastSub) {
      const [lastEx] = (await recentExchanges(contact, 1)).slice(-1);
      if (lastEx && Date.now() - lastEx.timestamp < LAST_ROUTE_TTL_MS) {
        lastSub = subagents.find((s) => s.id === lastEx.subagentId) ?? null;
      }
    }
    const recent = lastSub ? await getRecentMemory(contact, lastSub.id, 6) : [];
    const recentContext = recent
      .map((m) => `${m.role === 'user' ? 'Igor' : 'Agente'}: ${m.content.slice(0, 200)}`)
      .join('\n');
    // Dica para o LLM: palpite do embedding só quando confiável (top-1 com
    // margem mínima); senão keyword. Dica ruidosa vicia o LLM no rumo errado.
    const embHint = hintFrom(embRoute);
    target = await routeByLLM(
      text,
      subagents,
      recentContext,
      lastSub?.name,
      embHint?.name ?? kw?.sub.name,
      // Se o LLM falhar/responder lixo, continuidade > embedding > keyword > 1º da lista.
      lastSub ?? embHint ?? kw?.sub
    );
  }
  lastRouteByContact.set(contact, { subagentId: target.id, at: Date.now() });

  console.log(`[central] roteado para: ${target.name} (via ${via})`);

  // 2) Carrega a memória DESTE subagente + as trocas recentes GLOBAIS (qualquer
  //    subagente) + RAG automático: as trocas ANTIGAS mais similares à mensagem,
  //    para o agente "lembrar" sem precisar acertar a tool buscar_no_historico.
  const [memory, globalRecent, ragHits] = await Promise.all([
    getRecentMemory(contact, target.id, 12),
    recentExchanges(contact, 4),
    relevantPastExchanges(contact, text, 3),
  ]);
  const crossContext = globalRecent
    .filter((e) => e.subagentId !== target!.id)
    .map((e) => formatEntry(e, 300))
    .join('\n');
  const isCorrection = CORRECTION_REGEX.test(text);
  // Correção de ROTA (forma natural "não, isso é de X") — mais ampla que a de
  // conteúdo; usada para o aprendizado de roteamento.
  const isRouteCorrection = isCorrection || isRouteCorrectionText(text);

  // F9: correção rápida = possível erro de roteamento da TROCA ANTERIOR.
  // Registro generoso (a correção pode ser de conteúdo); o job semanal usa o
  // LLM para filtrar e sugerir keywords. Se a correção foi roteada para OUTRO
  // subagente, guarda o palpite da rota certa. Best-effort: nunca bloqueia.
  const prevExchange = globalRecent[globalRecent.length - 1];
  const prevInWindow =
    prevExchange && Date.now() - prevExchange.timestamp < ROUTE_MISS_WINDOW_MS;

  if (isCorrection && prevInWindow) {
    recordRouteMiss({
      contact,
      text: prevExchange.user.slice(0, 500),
      routedToId: prevExchange.subagentId,
      routedToName: prevExchange.subagentName,
      correction: text.slice(0, 500),
      ...(prevExchange.subagentId !== target.id
        ? { suggestedCorrectName: target.name }
        : {}),
      at: Date.now(),
    }).catch((err) => console.error('[central] falha ao registrar route miss:', err));
  }

  // Aprendizado imediato de rota: numa correção (conteúdo OU rota) que aponta a
  // troca anterior para OUTRO subagente, a mensagem anterior deveria ter ido
  // para o subagente atual (`target`). Guarda como exemplo rotulado para o
  // atalho de roteamento aprendido agir já no próximo caso parecido.
  if (isRouteCorrection && prevInWindow && prevExchange.subagentId !== target.id) {
    learnRouteExample(contact, prevExchange.user, target).catch((err) =>
      console.error('[central] falha ao aprender exemplo de rota:', err)
    );
  }

  // Se o Igor respondeu CITANDO outra mensagem, dá a referência à LLM: "isso",
  // "essa tarefa", "marca esse como feito" passam a ter a que se referir. Só
  // enriquece o texto que vai ao modelo — os atalhos acima já rodaram com o
  // texto puro, sem o ruído da citação.
  const userText =
    quotedText && quotedText.trim()
      ? `[Respondendo a esta mensagem citada: "${quotedText.trim()}"]\n\n${text}`
      : text;

  const start = Date.now();
  const { reply, toolCalls } = await runSubagent(target, userText, memory, fromAudio, contact, 0, {
    isCorrection,
    ...(crossContext ? { crossContext } : {}),
    ...(ragHits.length ? { ragContext: ragHits.join('\n\n') } : {}),
  });
  const elapsedMs = Date.now() - start;

  // 3) Persiste memória da conversa nesse subagente (usuário + resposta).
  const ts = Date.now();
  await appendMemory(contact, target.id, { role: 'user', content: text, timestamp: ts });
  await appendMemory(contact, target.id, {
    role: 'assistant',
    content: reply,
    timestamp: ts + 1,
  });

  // 4) Registra métrica de uso e o log pesquisável (best-effort, não bloqueia).
  recordMessage(target.id, target.name).catch((err) =>
    console.error('[central] falha ao registrar métrica:', err)
  );
  logExchange(contact, target.id, target.name, text, reply, ts, {
    toolCalls,
    elapsedMs,
    routedBy: via,
  }).catch((err) =>
    console.error('[central] falha ao registrar log de conversa:', err)
  );

  return {
    reply,
    subagentId: target.id,
    subagentName: target.name,
    toolCalls,
    elapsedMs,
    routedBy: via,
  };
}
