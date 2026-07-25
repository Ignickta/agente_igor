import { config } from '../config';
import { chatJson } from '../services/openai';
import { PendingPrompt, PendingPromptTarget } from '../types';
import {
  setPendingPrompt,
  getPendingPrompt,
  clearPendingPrompt,
  markPendingPromptClarified,
  getAgendaItem,
  getTask,
  updateTask,
  updateAgendaItem,
  markTaskDone,
} from '../services/firebase';
import { recordUndo } from './undo';
import { addDays, dayKey, parseLocalIso, timeKey } from '../services/datetime';

/**
 * Perguntas fechadas com alvo explícito.
 *
 * O modelo antigo classificava CADA mensagem isoladamente, por listas de
 * palavras. Isso funciona para comandos espontâneos ("adia o dentista pra
 * 15h"), mas quebra por definição em RESPOSTA a uma pergunta: "sim", "os dois
 * primeiros", "esse não" só significam algo em relação ao que foi perguntado, e
 * esse contexto era jogado fora. O resultado prático era o agente ignorar as
 * respostas do Igor e continuar cobrando as mesmas tarefas.
 *
 * Aqui a cobrança grava o que perguntou e sobre quais itens; a mensagem
 * seguinte é interpretada CONTRA essa pergunta, antes de qualquer atalho de
 * regex. Os atalhos continuam valendo quando não há pergunta no ar.
 */

/** Por quanto tempo uma cobrança continua "no ar" esperando resposta. */
export const PENDING_PROMPT_TTL_MS = 6 * 60 * 60 * 1000;

/** O que o Igor quis dizer ao responder a uma cobrança de conclusão. */
export interface PromptAnswer {
  /**
   * `concluir` — fez (os itens em `indices`).
   * `adiar` — não fez agora, empurra.
   * `nao_fiz` — não fez; continua pendente, sem empurrar.
   * `ambiguo` — é resposta à pergunta, mas não dá para saber QUAIS itens.
   * `nao_e_resposta` — mudou de assunto; a mensagem segue o fluxo normal.
   */
  acao: 'concluir' | 'adiar' | 'nao_fiz' | 'ambiguo' | 'nao_e_resposta';
  /** Posições (1-based) dos itens visados. Vazio = todos os cobrados. */
  indices: number[];
  /** True quando a resposta abrange explicitamente todos ("sim", "fiz tudo"). */
  todos: boolean;
  /** Parte da mensagem que NÃO é resposta à pergunta (vira mensagem própria). */
  resto: string;
}

/** Lista numerada dos alvos, como aparece na pergunta enviada ao Igor. */
export function formatTargets(targets: PendingPromptTarget[]): string {
  return targets.map((t) => `${t.index}. ${t.title}`).join('\n');
}

/**
 * Registra a cobrança recém-enviada. `targets` já deve vir numerado na MESMA
 * ordem em que foi exibido no WhatsApp — é por esse número que "1 e 3" resolve.
 */
export async function rememberAsk(
  contact: string,
  targets: PendingPromptTarget[]
): Promise<void> {
  if (!contact || targets.length === 0) return;
  const now = Date.now();
  await setPendingPrompt({
    contact,
    kind: 'confirm_done',
    targets,
    askedAt: now,
    expiresAt: now + PENDING_PROMPT_TTL_MS,
    clarifiedAt: null,
  });
}

/**
 * Interpreta a mensagem do Igor à luz da pergunta pendente. Usa o LLM (não
 * regex): a variedade de respostas humanas a uma pergunta fechada — "sim",
 * "fiz o 1 e o 3", "só a chamada", "o resto não deu", "esqueci" — é exatamente
 * o que listas de palavras não cobrem. O structured output mantém o resultado
 * previsível.
 */
export async function interpretAnswer(
  prompt: PendingPrompt,
  text: string
): Promise<PromptAnswer | null> {
  const lista = formatTargets(prompt.targets);
  const system = `Você interpreta a RESPOSTA do Igor a uma pergunta que o agente acabou de fazer.

A pergunta foi: "Quais destes itens você concluiu?", sobre a lista numerada abaixo.

Itens cobrados:
${lista}

Classifique a mensagem do Igor:
- "concluir": ele indica que FEZ um ou mais itens.
- "adiar": ele não fez e quer empurrar para depois.
- "nao_fiz": ele não fez, sem pedir para empurrar.
- "ambiguo": é resposta à pergunta, mas não dá para saber QUAIS itens (ex: "sim" quando há vários itens e nenhum foi citado).
- "nao_e_resposta": mudou de assunto / é um pedido novo, sem relação com a pergunta.

Regras:
- "indices" = os NÚMEROS dos itens visados. Se ele responder de forma abrangente ("sim", "fiz tudo", "todos"), marque "todos": true e deixe "indices" vazio.
- Se ele citar itens pelo TÍTULO (mesmo parcial ou com erro de digitação), devolva os índices correspondentes.
- Uma resposta como "X também" quer dizer que X entra JUNTO com o que já foi dito — inclua o índice de X.
- ATENÇÃO: um item citado pelo título é uma RESPOSTA sobre aquele item, não um pedido novo sobre ele. "Planejamento para sábado também" = concluí o item "Planejamento para sábado", NÃO "monte um plano para sábado".
- "resto": só a parte da mensagem que é um assunto NOVO, sem relação com a pergunta. Se não houver, string vazia.
- Com UM único item cobrado, uma confirmação simples ("sim", "fiz") é "concluir" com "todos": true — não é ambígua.`;

  const answer = await chatJson<PromptAnswer>(
    [
      { role: 'system', content: system },
      { role: 'user', content: `Mensagem do Igor: "${text}"` },
    ],
    {
      name: 'resposta_cobranca',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['acao', 'indices', 'todos', 'resto'],
        properties: {
          acao: {
            type: 'string',
            enum: ['concluir', 'adiar', 'nao_fiz', 'ambiguo', 'nao_e_resposta'],
          },
          indices: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Números (1-based) dos itens visados; vazio quando "todos" é true',
          },
          todos: { type: 'boolean' },
          resto: { type: 'string' },
        },
      },
      temperature: 0,
      model: config.openai.utilityModel,
    }
  );
  return answer;
}

/**
 * Resolve os alvos visados por uma resposta já interpretada. Exportada para os
 * evals de regressão: um erro aqui conclui a tarefa errada.
 */
export function targetsOf(prompt: PendingPrompt, answer: PromptAnswer): PendingPromptTarget[] {
  if (answer.todos || answer.indices.length === 0) return prompt.targets;
  const byIndex = new Map(prompt.targets.map((t) => [t.index, t]));
  const picked = answer.indices
    .map((i) => byIndex.get(i))
    .filter((t): t is PendingPromptTarget => Boolean(t));
  // Índices inválidos (o modelo inventou um número fora da lista) não podem
  // virar "então é tudo": nesse caso não sabemos o alvo, e quem chama trata
  // como ambíguo.
  return picked;
}

/** Conclui um alvo (item de agenda e/ou task), registrando o undo. */
async function completeTarget(contact: string, target: PendingPromptTarget): Promise<void> {
  if (target.agendaItemId) {
    const item = await getAgendaItem(target.agendaItemId);
    if (item && item.status !== 'done') {
      const restore = { status: item.status, completedAt: item.completedAt ?? null };
      await updateAgendaItem(item.id, { status: 'done', completedAt: Date.now() });
      recordUndo(
        contact,
        `a conclusão de "${item.title}"`,
        () => updateAgendaItem(item.id, restore),
        [{ kind: 'agenda.update', id: item.id, data: restore }]
      );
    }
  }
  if (target.taskId) {
    const task = await getTask(target.taskId);
    if (task && !task.completedAt) {
      const restore = {
        done: task.done,
        completedAt: task.completedAt ?? null,
        remindAt: task.remindAt,
      };
      await markTaskDone(task.id);
      recordUndo(
        contact,
        `a conclusão do lembrete "${task.text}"`,
        () => updateTask(task.id, restore),
        [{ kind: 'task.update', id: task.id, data: restore }]
      );
    }
  }
}

/** Empurra um alvo para amanhã no mesmo horário, registrando o undo. */
async function postponeTarget(contact: string, target: PendingPromptTarget): Promise<void> {
  if (!target.taskId) return;
  const task = await getTask(target.taskId);
  if (!task) return;
  const restore = {
    remindAt: task.remindAt,
    done: task.done,
    completedAt: task.completedAt ?? null,
    postponedCount: task.postponedCount,
  };
  const time = timeKey(new Date(task.remindAt));
  const next = parseLocalIso(`${addDays(dayKey(new Date(task.remindAt)), 1)}T${time}:00`);
  await updateTask(task.id, {
    remindAt: next.toISOString(),
    done: false,
    completedAt: null,
    firedAt: null,
    lastNudgeAt: null,
    postponedCount: (task.postponedCount ?? 0) + 1,
  });
  recordUndo(
    contact,
    `o adiamento de "${task.text}"`,
    () => updateTask(task.id, restore),
    [{ kind: 'task.update', id: task.id, data: restore }]
  );
}

/** Resultado do tratamento de uma resposta a cobrança. */
export interface PromptOutcome {
  /** Texto a enviar ao Igor. */
  reply: string;
  /** Assunto novo que veio junto e deve seguir o fluxo normal depois. */
  leftover: string;
}

/**
 * Trata a mensagem como resposta à cobrança pendente. Retorna null quando ela
 * NÃO é resposta (mudou de assunto) — aí o chamador segue o fluxo normal.
 *
 * Ambiguidade sobre VÁRIOS itens ("sim" para 4 tarefas) devolve a lista
 * numerada e pergunta quais — uma vez só. Se a resposta seguinte continuar
 * ambígua, encerra a pergunta em vez de insistir: cobrança em loop é o que faz
 * o Igor parar de responder.
 */
export async function handlePendingAnswer(
  contact: string,
  text: string
): Promise<PromptOutcome | null> {
  const prompt = await getPendingPrompt(contact);
  if (!prompt) return null;

  const answer = await interpretAnswer(prompt, text);
  // Sem interpretação utilizável, a pergunta continua no ar e a mensagem segue
  // o fluxo normal — melhor do que agir sobre um palpite.
  if (!answer || answer.acao === 'nao_e_resposta') return null;

  const leftover = answer.resto?.trim() ?? '';
  const alvos = targetsOf(prompt, answer);

  // Com UM item cobrado a resposta nunca é ambígua de verdade: só pode ser
  // sobre ele. Com vários, um "sim" genérico (ou índices que não resolveram)
  // precisa de desambiguação — é a opção (b): perguntar de volta em vez de
  // marcar tudo no chute.
  const unicoAlvo = prompt.targets.length === 1;
  const ambiguo = !unicoAlvo && (answer.acao === 'ambiguo' || alvos.length === 0);

  if (ambiguo) {
    if (prompt.clarifiedAt) {
      // Já perguntamos uma vez e continua ambíguo: encerra sem insistir.
      await clearPendingPrompt(contact);
      return {
        reply:
          'Beleza, vou deixar como estão por enquanto — me diga o número quando quiser que eu marque algum. 🙂',
        leftover,
      };
    }
    await markPendingPromptClarified(contact);
    return {
      reply:
        `Só pra eu não marcar errado — quais destes você fez?\n\n${formatTargets(prompt.targets)}\n\n` +
        `Responda com os números (ex: *1 e 3*) ou *todos*.`,
      leftover,
    };
  }

  // Um item só, ou índices resolvidos: age sobre o que foi identificado.
  const finais = alvos.length > 0 ? alvos : prompt.targets;
  // "ambiguo" com um único alvo é, na prática, uma confirmação sobre ele —
  // mas só concluímos quando a ação diz isso; senão deixamos pendente.
  if (answer.acao === 'ambiguo') {
    await clearPendingPrompt(contact);
    return {
      reply: `Não entendi se você fez *${finais[0].title}* — me diz *fiz* ou *não fiz* que eu marco.`,
      leftover,
    };
  }

  if (answer.acao === 'concluir') {
    for (const t of finais) await completeTarget(contact, t);
    await clearPendingPrompt(contact);
    const lista = finais.map((t) => `• ${t.title}`).join('\n');
    const verbo = finais.length > 1 ? 'concluídos' : 'concluído';
    return { reply: `✅ Marquei como ${verbo}:\n${lista}`, leftover };
  }

  if (answer.acao === 'adiar') {
    for (const t of finais) await postponeTarget(contact, t);
    await clearPendingPrompt(contact);
    const lista = finais.map((t) => `• ${t.title}`).join('\n');
    return { reply: `⏰ Empurrei para amanhã, mesmo horário:\n${lista}`, leftover };
  }

  // nao_fiz: nada muda de estado; a tarefa continua pendente e volta no
  // resumo da noite. Encerra a pergunta para não cobrar de novo em seguida.
  await clearPendingPrompt(contact);
  const lista = finais.map((t) => `• ${t.title}`).join('\n');
  return {
    reply: `Sem problema — deixei ${finais.length > 1 ? 'pendentes' : 'pendente'}:\n${lista}`,
    leftover,
  };
}
