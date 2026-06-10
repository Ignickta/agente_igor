import { Subagent } from '../types';
import { config } from '../config';
import { chat, ChatMessage } from '../services/openai';
import {
  listSubagents,
  getRecentMemory,
  appendMemory,
  recordMessage,
} from '../services/firebase';
import { runSubagent } from './subagents';
import { tryHandleCommand } from './commands';
import { getActiveItem, advanceTask } from './orchestrator';

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
 * Atalho de conclusão: dispara só quando a mensagem é uma confirmação PURA
 * (somente frases de conclusão + fillers, sem outras palavras de conteúdo) e há
 * um item em andamento na agenda. Evita falsos positivos como "tá pronto pra
 * começar". Retorna a resposta a enviar, ou null se não se aplica.
 */
async function tryAdvanceAgenda(text: string): Promise<string | null> {
  const lower = text.trim().toLowerCase();
  // Só dispara para mensagens curtas, evitando falsos positivos em textos longos.
  if (lower.length > 40) return null;
  // Uma pergunta não é uma confirmação de conclusão (ex: "feito o quê?").
  if (lower.includes('?')) return null;
  if (!DONE_REGEX.test(lower)) return null;
  // Blindagem: a mensagem precisa ser SÓ a confirmação. Se sobrar qualquer
  // palavra de conteúdo após remover frases de conclusão e fillers, não dispara.
  if (leftoverContentWords(lower).length > 0) return null;

  const active = await getActiveItem();
  if (!active || active.status !== 'in_progress') return null;

  await advanceTask(active);
  // advanceTask já envia a mensagem de transição; aqui evitamos resposta duplicada.
  return '';
}

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
function routeByKeywords(
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
async function routeByLLM(
  text: string,
  subagents: Subagent[],
  recentContext: string,
  lastSubagentName?: string,
  keywordHint?: string
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
recente, escolha o subagente mais adequado. Responda APENAS com o número da opção, nada mais.

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

  const answer = await chat(messages, { temperature: 0, model: config.openai.utilityModel });
  const idx = parseInt(answer.replace(/\D/g, ''), 10) - 1;
  if (idx >= 0 && idx < subagents.length) return subagents[idx];
  return subagents[0];
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

  // 0.5) Atalho de conclusão da tarefa atual ("terminei", "pronto", ...).
  //      Só do dono e quando há item em andamento na agenda.
  if (contact === config.ownerPhone || !config.ownerPhone) {
    const advanced = await tryAdvanceAgenda(text);
    if (advanced !== null) return advanced;
  }

  const subagents = await listSubagents();
  if (subagents.length === 0) {
    return 'Nenhum subagente configurado ainda. Crie um pelo painel admin ou pelo WhatsApp.';
  }

  // 1) Roteamento: keyword só decide sozinha com match forte (>= 2); caso
  //    contrário o LLM decide com o contexto da última conversa, para que
  //    continuações curtas ("e amanhã?") fiquem no mesmo assunto.
  const kw = routeByKeywords(text, subagents);
  let target = kw && kw.score >= 2 ? kw.sub : null;

  if (!target) {
    const last = lastRouteByContact.get(contact);
    const lastSub =
      last && Date.now() - last.at < LAST_ROUTE_TTL_MS
        ? subagents.find((s) => s.id === last.subagentId) ?? null
        : null;
    const recent = lastSub ? await getRecentMemory(contact, lastSub.id, 6) : [];
    const recentContext = recent
      .map((m) => `${m.role === 'user' ? 'Igor' : 'Agente'}: ${m.content.slice(0, 200)}`)
      .join('\n');
    target = await routeByLLM(text, subagents, recentContext, lastSub?.name, kw?.sub.name);
  }
  lastRouteByContact.set(contact, { subagentId: target.id, at: Date.now() });

  console.log(`[central] roteado para: ${target.name}`);

  // 2) Carrega a memória DESTE subagente e executa.
  const memory = await getRecentMemory(contact, target.id, 12);
  const reply = await runSubagent(target, text, memory, fromAudio, contact);

  // 3) Persiste memória da conversa nesse subagente (usuário + resposta).
  const ts = Date.now();
  await appendMemory(contact, target.id, { role: 'user', content: text, timestamp: ts });
  await appendMemory(contact, target.id, {
    role: 'assistant',
    content: reply,
    timestamp: ts + 1,
  });

  // 4) Registra métrica de uso (best-effort, não bloqueia a resposta).
  recordMessage(target.id, target.name).catch((err) =>
    console.error('[central] falha ao registrar métrica:', err)
  );

  return reply;
}
