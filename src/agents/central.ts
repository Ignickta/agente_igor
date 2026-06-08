import { Subagent } from '../types';
import { chat, ChatMessage } from '../services/openai';
import {
  listSubagents,
  getRecentMemory,
  appendMemory,
} from '../services/firebase';
import { runSubagent } from './subagents';
import { tryHandleCommand } from './commands';

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
 */
export async function handleMessage(
  contact: string,
  text: string
): Promise<string> {
  // 0) Comandos administrativos (/criar, /agentes, /remover, ...) têm prioridade.
  const command = await tryHandleCommand(contact, text);
  if (command.handled) {
    return command.reply || '';
  }

  const subagents = await listSubagents();
  if (subagents.length === 0) {
    return 'Nenhum subagente configurado ainda. Crie um pelo painel admin ou pelo WhatsApp.';
  }

  const memory = await getRecentMemory(contact, 12);
  const recentContext = memory
    .slice(-4)
    .map((m) => `${m.role === 'user' ? 'Igor' : 'Agente'}: ${m.content}`)
    .join('\n');

  // 1) Roteamento barato por keyword, com fallback para LLM.
  let target = routeByKeywords(text, subagents);
  if (!target) {
    target = await routeByLLM(text, subagents, recentContext);
  }

  console.log(`[central] roteado para: ${target.name}`);

  // 2) Executa o subagente escolhido.
  const reply = await runSubagent(target, text, memory);

  // 3) Persiste memória da conversa (usuário + resposta).
  const ts = Date.now();
  await appendMemory(contact, { role: 'user', content: text, timestamp: ts });
  await appendMemory(contact, {
    role: 'assistant',
    content: reply,
    timestamp: ts + 1,
  });

  return reply;
}
