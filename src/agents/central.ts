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
 * Atalho de conclusão: se a mensagem for uma confirmação curta e houver um item
 * em andamento na agenda de hoje, avança a tarefa e avisa a próxima — sem gastar
 * roteamento por LLM. Retorna a resposta a enviar, ou null se não se aplica.
 */
async function tryAdvanceAgenda(text: string): Promise<string | null> {
  const lower = text.trim().toLowerCase();
  // Só dispara para mensagens curtas, evitando falsos positivos em textos longos.
  if (lower.length > 40) return null;
  // Uma pergunta não é uma confirmação de conclusão (ex: "feito o quê?").
  if (lower.includes('?')) return null;
  if (!DONE_REGEX.test(lower)) return null;

  const active = await getActiveItem();
  if (!active || active.status !== 'in_progress') return null;

  await advanceTask(active);
  // advanceTask já envia a mensagem de transição; aqui evitamos resposta duplicada.
  return '';
}

/**
 * Tenta um roteamento rápido por palavras-chave antes de gastar uma
 * chamada de LLM. Retorna o subagente com mais matches, ou null.
 */
function routeByKeywords(text: string, subagents: Subagent[]): Subagent | null {
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
  return best?.sub ?? null;
}

/**
 * Usa o LLM para escolher o subagente quando as palavras-chave não bastam.
 * Considera o histórico recente para manter continuidade de assunto.
 */
async function routeByLLM(
  text: string,
  subagents: Subagent[],
  recentContext: string
): Promise<Subagent> {
  const list = subagents
    .map((s, i) => `${i + 1}. ${s.name} — temas: ${s.keywords.join(', ')}`)
    .join('\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `Você é o roteador de um agente pessoal. Dada a mensagem do usuário e o contexto
recente, escolha o subagente mais adequado. Responda APENAS com o número da opção, nada mais.

Subagentes disponíveis:
${list}

Se nenhum encaixar perfeitamente, escolha o mais próximo.`,
    },
    {
      role: 'user',
      content: `Contexto recente:\n${recentContext || '(sem histórico)'}\n\nMensagem: "${text}"\n\nNúmero do subagente:`,
    },
  ];

  const answer = await chat(messages, { temperature: 0 });
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

  // 1) Roteamento barato por keyword, com fallback para LLM.
  //    (A memória agora é por subagente, então roteamos antes de carregá-la.)
  let target = routeByKeywords(text, subagents);
  if (!target) {
    target = await routeByLLM(text, subagents, '');
  }

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
