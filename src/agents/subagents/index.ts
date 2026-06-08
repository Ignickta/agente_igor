import { Subagent, MemoryMessage } from '../../types';
import { openai, ChatMessage } from '../../services/openai';
import { config } from '../../config';
import { createTask, saveFact, getFacts } from '../../services/firebase';
import type OpenAI from 'openai';

/** Ferramentas que o agente pode chamar por conta própria (function calling). */
const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'criar_lembrete',
      description:
        'Cria um lembrete/tarefa que será enviado ao Igor no WhatsApp na data e hora indicadas. ' +
        'Use quando o usuário pedir para ser lembrado de algo ou agendar uma tarefa.',
      parameters: {
        type: 'object',
        properties: {
          texto: { type: 'string', description: 'O que lembrar.' },
          quando_iso: {
            type: 'string',
            description:
              'Data e hora do lembrete em ISO 8601 (ex: 2026-06-10T14:00:00). ' +
              'Calcule a partir da data/hora atual fornecida no contexto.',
          },
        },
        required: ['texto', 'quando_iso'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'salvar_fato',
      description:
        'Salva um fato importante e duradouro sobre o Igor ou este projeto para lembrar em ' +
        'conversas futuras (ex: nome de um cliente, uma preferência, um status). NÃO use para ' +
        'coisas triviais ou temporárias.',
      parameters: {
        type: 'object',
        properties: {
          fato: { type: 'string', description: 'O fato a memorizar, conciso.' },
        },
        required: ['fato'],
      },
    },
  },
];

/**
 * Executa um subagente com function calling: monta o system prompt (personalidade
 * + fatos memorizados), injeta o histórico e deixa o modelo usar ferramentas
 * (criar lembrete, salvar fato) antes de produzir a resposta final.
 */
export async function runSubagent(
  subagent: Subagent,
  userText: string,
  memory: MemoryMessage[],
  fromAudio = false,
  contact = ''
): Promise<string> {
  const facts = contact ? await getFacts(contact, subagent.id) : [];
  const now = new Date();
  const nowStr = now.toLocaleString('pt-BR', { timeZone: config.timezone });

  const system = `${subagent.prompt}

Regras gerais:
- Você está conversando pelo WhatsApp, então seja conciso e use formatação leve.
- Responda em português do Brasil.
- Se faltar informação, faça no máximo uma pergunta objetiva.
- Você é o subagente "${subagent.name}" do agente pessoal do Igor.
- O Igor pode escrever ou mandar áudio; áudios já chegam transcritos. Trate-os como
  mensagens normais. NUNCA diga que não consegue ouvir ou processar áudios.${
    fromAudio ? '\n- A mensagem atual foi enviada por áudio (já transcrita).' : ''
  }
- Data e hora atuais: ${nowStr} (fuso ${config.timezone}). Use isto para calcular lembretes.
- Você PODE criar lembretes e salvar fatos usando as ferramentas disponíveis.${
    facts.length
      ? `\n\nFatos que você já sabe sobre este projeto/usuário:\n${facts
          .map((f) => `- ${f}`)
          .join('\n')}`
      : ''
  }`;

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...memory.map((m) => ({ role: m.role, content: m.content } as ChatMessage)),
    { role: 'user', content: userText },
  ];

  // Loop de tool-calling: o modelo pode chamar ferramentas antes da resposta final.
  for (let step = 0; step < 4; step++) {
    const completion = await openai.chat.completions.create({
      model: config.openai.model,
      temperature: 0.7,
      messages,
      tools: TOOLS,
    });

    const choice = completion.choices[0].message;

    if (!choice.tool_calls || choice.tool_calls.length === 0) {
      return choice.content?.trim() || '';
    }

    // Registra a intenção do assistente e executa cada ferramenta.
    messages.push(choice);
    for (const call of choice.tool_calls) {
      const result = await executeTool(call, subagent.id, contact);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  // Salvaguarda: se estourou o limite de passos, faz uma última geração sem tools.
  const finalCompletion = await openai.chat.completions.create({
    model: config.openai.model,
    temperature: 0.7,
    messages,
  });
  return finalCompletion.choices[0].message.content?.trim() || '';
}

/** Executa uma ferramenta chamada pelo modelo e retorna um resumo textual. */
async function executeTool(
  call: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
  subagentId: string,
  contact: string
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return 'Erro: argumentos inválidos.';
  }

  try {
    if (call.function.name === 'criar_lembrete') {
      const texto = String(args.texto || '').trim();
      const quando = String(args.quando_iso || '').trim();
      const when = new Date(quando);
      if (!texto || isNaN(when.getTime())) {
        return 'Não foi possível criar: texto ou data inválidos.';
      }
      await createTask({
        text: texto,
        remindAt: when.toISOString(),
        to: contact || config.ownerPhone,
        subagentId,
      });
      const quandoBr = when.toLocaleString('pt-BR', { timeZone: config.timezone });
      return `Lembrete criado para ${quandoBr}: "${texto}".`;
    }

    if (call.function.name === 'salvar_fato') {
      const fato = String(args.fato || '').trim();
      if (!fato || !contact) return 'Nada para salvar.';
      await saveFact(contact, subagentId, fato);
      return `Fato memorizado: "${fato}".`;
    }
  } catch (err) {
    console.error('[tool] erro ao executar', call.function.name, err);
    return 'Houve um erro ao executar a ação.';
  }

  return 'Ferramenta desconhecida.';
}
