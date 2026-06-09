import { Subagent, MemoryMessage } from '../../types';
import { openai, ChatMessage } from '../../services/openai';
import { config } from '../../config';
import { createTask, saveFact, getFacts } from '../../services/firebase';
import { research } from '../research';
import {
  generateDailySchedule,
  formatSchedule,
  sendDailySchedule,
  reorganize,
  getActiveItem,
  advanceTask,
  dayKey,
} from '../orchestrator';
import type OpenAI from 'openai';

/** Nome do subagente que recebe as ferramentas de orquestração da agenda. */
export const ORCHESTRATOR_NAME = 'Agenda / Orquestrador';

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
  {
    type: 'function',
    function: {
      name: 'pesquisar',
      description:
        'Pesquisa um tema/pergunta na web e retorna um resumo com fontes. Use quando o usuário ' +
        'pedir informação atual, novidades, dados de mercado, ou algo que você não saiba com ' +
        'certeza. A resposta da ferramenta já vem formatada — repasse-a ao usuário.',
      parameters: {
        type: 'object',
        properties: {
          tema: { type: 'string', description: 'A pergunta ou tema a pesquisar.' },
        },
        required: ['tema'],
      },
    },
  },
];

/**
 * Ferramentas exclusivas do subagente orquestrador (Agenda). Só são oferecidas
 * quando o subagente em execução é o de agenda — os demais seguem com o conjunto
 * base, mantendo compatibilidade.
 */
const ORCHESTRATOR_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'gerar_cronograma',
      description:
        'Gera (ou mostra) o cronograma do dia a partir das tarefas pendentes e prioridade ' +
        'calculada, e envia ao Igor. Use quando ele pedir para planejar/montar/ver o dia.',
      parameters: {
        type: 'object',
        properties: {
          data: {
            type: 'string',
            description: 'Data YYYY-MM-DD. Opcional; padrão = hoje.',
          },
          enviar: {
            type: 'boolean',
            description:
              'Se true, envia o cronograma pelo WhatsApp além de retornar. Padrão false.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'realocar_agenda',
      description:
        'Reorganiza a agenda de hoje conforme um pedido em linguagem natural (ex: "adia o ' +
        'dentista pra depois do almoço"). Itens fixos do usuário (prioridade 1) nunca são movidos.',
      parameters: {
        type: 'object',
        properties: {
          instrucao: {
            type: 'string',
            description: 'O pedido de realocação, em linguagem natural.',
          },
        },
        required: ['instrucao'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'concluir_tarefa_atual',
      description:
        'Marca a tarefa atual (em andamento) como concluída e avança para a próxima, avisando ' +
        'o usuário. Use quando ele disser que terminou/concluiu o item atual.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

/** Conjunto de tools efetivo para um subagente (base + orquestrador, se for o caso). */
function toolsFor(subagent: Subagent): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return subagent.name === ORCHESTRATOR_NAME ? [...TOOLS, ...ORCHESTRATOR_TOOLS] : TOOLS;
}

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

  const tools = toolsFor(subagent);

  // Loop de tool-calling: o modelo pode chamar ferramentas antes da resposta final.
  for (let step = 0; step < 4; step++) {
    const completion = await openai.chat.completions.create({
      model: config.openai.model,
      temperature: 0.7,
      messages,
      tools,
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

    if (call.function.name === 'pesquisar') {
      const tema = String(args.tema || '').trim();
      if (!tema) return 'Tema de pesquisa vazio.';
      return await research(tema);
    }

    if (call.function.name === 'gerar_cronograma') {
      const data = String(args.data || '').trim() || dayKey();
      const enviar = args.enviar === true;
      if (enviar) {
        await sendDailySchedule(data);
        return `Cronograma de ${data} gerado e enviado pelo WhatsApp.`;
      }
      const items = await generateDailySchedule(data);
      return formatSchedule(items, data);
    }

    if (call.function.name === 'realocar_agenda') {
      const instrucao = String(args.instrucao || '').trim();
      if (!instrucao) return 'Diga o que devo reorganizar.';
      return await reorganize(instrucao);
    }

    if (call.function.name === 'concluir_tarefa_atual') {
      const active = await getActiveItem();
      if (!active) return 'Não há tarefa em andamento na agenda de hoje.';
      await advanceTask(active);
      return `Tarefa "${active.title}" concluída e próxima iniciada.`;
    }
  } catch (err) {
    console.error('[tool] erro ao executar', call.function.name, err);
    return 'Houve um erro ao executar a ação.';
  }

  return 'Ferramenta desconhecida.';
}
