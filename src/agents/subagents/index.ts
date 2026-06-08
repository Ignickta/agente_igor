import { Subagent, MemoryMessage } from '../../types';
import { chat, ChatMessage } from '../../services/openai';

/**
 * Executa um subagente: monta o system prompt com sua personalidade,
 * injeta o histórico de memória e gera a resposta.
 */
export async function runSubagent(
  subagent: Subagent,
  userText: string,
  memory: MemoryMessage[],
  fromAudio = false
): Promise<string> {
  const system = `${subagent.prompt}

Regras gerais:
- Você está conversando pelo WhatsApp, então seja conciso e use formatação leve.
- Responda em português do Brasil.
- Se faltar informação, faça no máximo uma pergunta objetiva.
- Você é o subagente "${subagent.name}" do agente pessoal do Igor.
- O Igor pode escrever ou mandar áudio; áudios já chegam até você transcritos em texto.
  Trate-os como mensagens normais. NUNCA diga que não consegue ouvir, escutar ou
  processar áudios — você recebe o conteúdo normalmente.${
    fromAudio
      ? '\n- A mensagem atual foi enviada por áudio e já está transcrita abaixo.'
      : ''
  }`;

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
