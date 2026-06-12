import { Subagent } from '../types';
import { config } from '../config';
import { chatJson, ChatMessage } from '../services/openai';
import {
  listSubagents,
  getRecentMemory,
  appendMemory,
  recordMessage,
  updateAgendaItem,
  getTask,
  updateTask,
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
import { beginUndoGroup, recordUndo } from './undo';

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
  recordUndo(contact, `a conclusão de "${active.title}" (atalho "feito")`, async () => {
    await updateAgendaItem(active.id, { status: active.status });
    if (active.taskId && taskPrev) await updateTask(active.taskId, taskPrev);
  });
  // advanceTask já envia a mensagem de transição; aqui evitamos resposta duplicada.
  return '';
}

/**
 * Sinais de que o usuário está CORRIGINDO algo que o agente fez ou disse.
 * Quando detectado, o subagente é instruído a reconhecer, consertar e salvar a
 * lição na memória compartilhada — para o erro não se repetir.
 */
const CORRECTION_REGEX =
  /\b(errado|errada|errou|não era isso|nao era isso|não foi isso|nao foi isso|não é isso|nao é isso|entendeu errado|corrige isso|corrigindo|não pedi isso|nao pedi isso|você tinha dito|voce tinha dito)\b/i;

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
 * Última rota por contato, para dar continuidade a mensagens curtas/ambíguas
 * ("e amanhã?", "muda pra 15h") sem perder o assunto da conversa anterior.
 * Em memória: sobrevive entre mensagens, zera num restart (aceitável).
 */
const lastRouteByContact = new Map<string, { subagentId: string; at: number }>();
const LAST_ROUTE_TTL_MS = 30 * 60 * 1000;

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
  fromAudio = false
): Promise<string> {
  // 0) Comandos administrativos (/criar, /agentes, /remover, ...) têm prioridade.
  const command = await tryHandleCommand(contact, text);
  if (command.handled) {
    return command.reply || '';
  }

  // Cada mensagem abre um grupo de undo: "desfaz" reverte TUDO que esta
  // mensagem causar (ex: 4 lembretes criados de uma vez), não só a última escrita.
  beginUndoGroup(contact);

  // 0.5) Atalho de conclusão da tarefa atual ("terminei", "pronto", ...).
  //      Só do dono e quando há item em andamento na agenda.
  if (contact === config.ownerPhone || !config.ownerPhone) {
    const advanced = await tryAdvanceAgenda(contact, text);
    if (advanced !== null) return advanced;
  }

  const subagents = await listSubagents();
  if (subagents.length === 0) {
    return 'Nenhum subagente configurado ainda. Crie um pelo painel admin ou pelo WhatsApp.';
  }

  // 1) Roteamento. Pedidos claramente de agenda vão DIRETO para o orquestrador
  //    (único subagente com as ferramentas de agenda); keyword só decide sozinha
  //    com match forte (>= 2); caso contrário o LLM decide com o contexto da
  //    última conversa, para que continuações curtas ("e amanhã?") fiquem no
  //    mesmo assunto.
  let target: Subagent | null = null;
  if (AGENDA_REGEX.test(text)) {
    target =
      subagents.find((s) => s.name === ORCHESTRATOR_NAME) ??
      subagents.find((s) => /agenda/i.test(s.name)) ??
      null;
  }

  const kw = target ? null : routeByKeywords(text, subagents);
  if (!target && kw && kw.score >= 2) target = kw.sub;

  if (!target) {
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
    target = await routeByLLM(
      text,
      subagents,
      recentContext,
      lastSub?.name,
      kw?.sub.name,
      // Se o LLM falhar/responder lixo, continuidade > keyword > primeiro da lista.
      lastSub ?? kw?.sub
    );
  }
  lastRouteByContact.set(contact, { subagentId: target.id, at: Date.now() });

  console.log(`[central] roteado para: ${target.name}`);

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
  const reply = await runSubagent(target, text, memory, fromAudio, contact, 0, {
    isCorrection,
    ...(crossContext ? { crossContext } : {}),
    ...(ragHits.length ? { ragContext: ragHits.join('\n\n') } : {}),
  });

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
  logExchange(contact, target.id, target.name, text, reply, ts).catch((err) =>
    console.error('[central] falha ao registrar log de conversa:', err)
  );

  return reply;
}
