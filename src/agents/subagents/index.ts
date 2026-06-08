import { Subagent, MemoryMessage } from '../../types';
import { chat, ChatMessage } from '../../services/openai';

/**
 * Executa um subagente: monta o system prompt com sua personalidade,
 * injeta o histórico de memória e gera a resposta.
 */
export async function runSubagent(
  subagent: Subagent,
  userText: string,
  memory: MemoryMessage[]
): Promise<string> {
  const system = `${subagent.prompt}

Regras gerais:
- Você está conversando pelo WhatsApp, então seja conciso e use formatação leve.
- Responda em português do Brasil.
- Se faltar informação, faça no máximo uma pergunta objetiva.
- Você é o subagente "${subagent.name}" do agente pessoal do Igor.`;

  const history: ChatMessage[] = memory.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: userText },
  ];

  return chat(messages, { temperature: 0.7 });
}
