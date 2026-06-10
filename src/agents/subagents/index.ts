import { Subagent, MemoryMessage, Task, AgendaItem } from '../../types';
import { openai, ChatMessage, supportsCustomTemperature } from '../../services/openai';
import { config } from '../../config';
import {
  createTask,
  listTasks,
  getTask,
  updateTask,
  deleteTask,
  getFacts,
  listSubagents,
  getRecentMemory,
  getAgendaForDay,
  updateAgendaItem,
  createAgendaItem,
  getAgendaItem,
  deleteAgendaItem,
} from '../../services/firebase';
import { recordUndo, undoLast } from '../undo';
import { rememberFact, recallFacts } from '../../services/memory';
import { listAutomations, triggerAutomation } from '../../services/n8n';
import { research } from '../research';
import { estimateDurationMinutes } from '../estimate';
import {
  generateDailySchedule,
  formatSchedule,
  sendDailySchedule,
  reorganize,
  getActiveItem,
  advanceTask,
  weeklyView,
  monthlyView,
  upcomingView,
  detectOverload,
  dayKey,
  addDays,
} from '../orchestrator';
import { parseLocalIso, timeKey } from '../../services/datetime';
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
              'Data e hora LOCAIS do lembrete (fuso do Igor), em ISO 8601 sem offset ' +
              '(ex: 2026-06-10T14:00:00). Use as datas de "hoje" e "amanhã" fornecidas ' +
              'no contexto — não calcule dias de cabeça.',
          },
          recorrencia: {
            type: 'string',
            enum: ['diaria', 'semanal', 'mensal', 'dias_uteis'],
            description:
              'Se o lembrete se repete ("todo dia", "toda segunda", "todo mês", "dias úteis"). ' +
              'Omita para lembrete único.',
          },
        },
        required: ['texto', 'quando_iso'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar_lembretes',
      description:
        'Lista os lembretes/tarefas PENDENTES com id, data e hora locais. Use para descobrir ' +
        'o id antes de editar_lembrete/remover_lembrete, ou quando o usuário perguntar quais ' +
        'lembretes existem.',
      parameters: {
        type: 'object',
        properties: {
          data: {
            type: 'string',
            description: 'Filtra por um dia local YYYY-MM-DD. Opcional; sem filtro, lista todos.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'editar_lembrete',
      description:
        'Altera um lembrete existente: o texto, o horário ou ambos. Use quando o usuário pedir ' +
        'para mudar/adiar/renomear um compromisso que é um lembrete. Se não souber o id, chame ' +
        'listar_lembretes primeiro — NUNCA diga que não há o que alterar sem listar antes.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ID do lembrete (obtido em listar_lembretes).' },
          texto: { type: 'string', description: 'Novo texto. Opcional.' },
          quando_iso: {
            type: 'string',
            description:
              'Novo horário LOCAL em ISO 8601 sem offset (ex: 2026-06-10T08:30:00). Opcional.',
          },
          recorrencia: {
            type: 'string',
            enum: ['diaria', 'semanal', 'mensal', 'dias_uteis', 'nenhuma'],
            description:
              'Muda a recorrência; "nenhuma" transforma em lembrete único. Opcional.',
          },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remover_lembrete',
      description:
        'Apaga um lembrete de vez (quando o usuário cancelar o compromisso). Se não souber o ' +
        'id, use listar_lembretes primeiro.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ID do lembrete (obtido em listar_lembretes).' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desfazer_ultima_acao',
      description:
        'Desfaz a última alteração que VOCÊ fez (criar/editar/remover lembrete, reorganizar ' +
        'agenda...). Use quando o Igor pedir para desfazer, voltar atrás ou cancelar o que ' +
        'acabou de ser feito.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'salvar_fato',
      description:
        'Salva, por conta própria, um fato duradouro sobre o Igor ou este projeto para enriquecer ' +
        'conversas futuras: DECISÕES importantes, PREFERÊNCIAS, padrões de comportamento, nomes de ' +
        'clientes, status de projetos. Acione sempre que captar algo assim na conversa, sem o Igor ' +
        'pedir. NÃO use para trivialidades ou coisas temporárias.',
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
        'Pesquisa um tema/pergunta na web e retorna fatos atuais com fontes. Acione por conta ' +
        'própria, SEM o usuário precisar pedir, sempre que pesquisar deixaria sua resposta mais ' +
        'precisa: informação que muda com o tempo (preços, cotações, datas, versões, notícias, ' +
        'novidades), dados que você não sabe com certeza, ou qualquer coisa que valha confirmar. ' +
        'O retorno é material de apoio: NÃO o cole cru — extraia o que importa e incorpore na sua ' +
        'resposta com naturalidade, dentro do seu papel de subagente. Pode pesquisar mais de uma ' +
        'vez se precisar de ângulos diferentes.',
      parameters: {
        type: 'object',
        properties: {
          tema: {
            type: 'string',
            description:
              'A pergunta ou tema a pesquisar, específico o suficiente para uma busca útil.',
          },
        },
        required: ['tema'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_subagente',
      description:
        'Aciona OUTRO subagente especializado para opinar sobre parte da pergunta que pertence à ' +
        'área dele (ex: você é o financeiro e precisa da visão do agente pessoal). Recebe a ' +
        'resposta dele como insumo — combine-a com a sua antes de responder ao Igor. Use só quando ' +
        'a tarefa realmente cruzar duas áreas.',
      parameters: {
        type: 'object',
        properties: {
          area: {
            type: 'string',
            description: 'Nome ou tema do subagente a consultar (ex: "Pessoal", "SaaS Odontológico").',
          },
          pergunta: {
            type: 'string',
            description: 'A pergunta específica para aquele subagente, com o contexto necessário.',
          },
        },
        required: ['area', 'pergunta'],
      },
    },
  },
];

/**
 * Tool de automações n8n — só entra no conjunto quando há webhooks configurados
 * (N8N_WEBHOOKS). A lista de nomes vai na descrição para o modelo escolher.
 */
function n8nTool(): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: 'acionar_automacao',
      description:
        'Dispara um workflow do n8n do Igor. Use quando ele pedir para executar uma automação ' +
        `(ex: "dispara a automação X", "manda a planilha pro cliente"). Disponíveis: ` +
        `${listAutomations().join(', ')}. Em "dados", passe as informações úteis ao workflow.`,
      parameters: {
        type: 'object',
        properties: {
          nome: {
            type: 'string',
            description: 'Nome exato da automação (uma das disponíveis).',
          },
          dados: {
            type: 'string',
            description:
              'Informações para o workflow, em texto livre ou JSON. Opcional.',
          },
        },
        required: ['nome'],
      },
    },
  };
}

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
        'Reorganiza os BLOCOS do cronograma de hoje conforme um pedido em linguagem natural ' +
        '(ex: "adia o dentista pra depois do almoço"). Itens fixos do usuário (prioridade 1) ' +
        'nunca são movidos. Para mudar horário/texto de um LEMBRETE avulso, prefira ' +
        'listar_lembretes + editar_lembrete.',
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
      name: 'criar_evento',
      description:
        'Cria um EVENTO com horário de início e fim na agenda (ex: "reunião amanhã 15h às 16h"). ' +
        'Por padrão o evento é FIXO (prioridade 1, nunca movido pelo reorganizador). Use para ' +
        'compromissos com hora marcada; para um simples "me lembra de X", use criar_lembrete.',
      parameters: {
        type: 'object',
        properties: {
          titulo: { type: 'string', description: 'Título do evento.' },
          data: {
            type: 'string',
            description: 'Dia local YYYY-MM-DD. Opcional; padrão = hoje.',
          },
          inicio: { type: 'string', description: 'Início HH:mm (ex: 15:00).' },
          fim: { type: 'string', description: 'Fim HH:mm (ex: 16:00).' },
          fixo: {
            type: 'boolean',
            description: 'Se false, o evento pode ser remanejado pelo agente. Padrão true.',
          },
        },
        required: ['titulo', 'inicio', 'fim'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar_itens_agenda',
      description:
        'Lista os itens da agenda de um dia COM os ids, para poder editar/remover. Use antes ' +
        'de editar_item_agenda/remover_item_agenda quando não souber o id.',
      parameters: {
        type: 'object',
        properties: {
          data: { type: 'string', description: 'Dia local YYYY-MM-DD. Opcional; padrão = hoje.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'editar_item_agenda',
      description:
        'Altera um item da agenda: título, horários e/ou dia. Se não souber o id, chame ' +
        'listar_itens_agenda primeiro.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ID do item (de listar_itens_agenda).' },
          titulo: { type: 'string', description: 'Novo título. Opcional.' },
          inicio: { type: 'string', description: 'Novo início HH:mm. Opcional.' },
          fim: { type: 'string', description: 'Novo fim HH:mm. Opcional.' },
          data: { type: 'string', description: 'Novo dia YYYY-MM-DD (mover de dia). Opcional.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remover_item_agenda',
      description:
        'Remove um item da agenda (evento cancelado). Se não souber o id, use ' +
        'listar_itens_agenda primeiro.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ID do item (de listar_itens_agenda).' },
        },
        required: ['id'],
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
  {
    type: 'function',
    function: {
      name: 'ver_agenda',
      description:
        'Mostra um resumo consolidado dos próximos itens agendados (padrão: próximos 7 dias), ' +
        'agrupados por dia, com horário, status e prioridade. Use quando o Igor pedir "minha ' +
        'agenda", "o que tenho agendado", "o que vem por aí". Já vem formatado — repasse ao usuário.',
      parameters: {
        type: 'object',
        properties: {
          dias: {
            type: 'number',
            description: 'Quantos dias à frente incluir (incluindo hoje). Padrão 7.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ver_semana',
      description:
        'Mostra o resumo da SEMANA atual (segunda a domingo), organizado por dia, com as tarefas ' +
        'e eventos agendados. Use quando o Igor pedir "me mostra minha semana", "como tá minha ' +
        'semana". Já vem formatado — repasse ao usuário.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ver_mes',
      description:
        'Mostra o resumo do MÊS atual, organizado por dia, com as tarefas e eventos agendados. ' +
        'Use quando o Igor pedir "como tá meu mês", "me mostra o mês". Já vem formatado — repasse ' +
        'ao usuário.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

/** Conjunto de tools efetivo para um subagente (base + n8n + orquestrador). */
function toolsFor(subagent: Subagent): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const base = listAutomations().length > 0 ? [...TOOLS, n8nTool()] : [...TOOLS];
  return subagent.name === ORCHESTRATOR_NAME ? [...base, ...ORCHESTRATOR_TOOLS] : base;
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
  contact = '',
  /** Profundidade de encadeamento (F8). 0 = chamada direta; >=1 = via consultar_subagente. */
  depth = 0,
  opts: { isCorrection?: boolean } = {}
): Promise<string> {
  // Memória de fatos: pool semântico COMPARTILHADO (relevância para a mensagem
  // atual, entre todas as áreas) + fatos legados deste subagente, deduplicados.
  let facts: string[] = [];
  if (contact) {
    const [shared, legacy] = await Promise.all([
      recallFacts(contact, userText, 8).catch(() => [] as string[]),
      getFacts(contact, subagent.id, 8),
    ]);
    facts = [...new Set([...shared, ...legacy])].slice(0, 12);
  }
  const now = new Date();
  const nowStr = now.toLocaleString('pt-BR', { timeZone: config.timezone });
  // Âncoras de data explícitas (dia da semana + hoje/amanhã em ISO) para o
  // modelo não errar aritmética de datas ao interpretar "hoje", "amanhã", etc.
  const hoje = dayKey(now);
  const amanha = addDays(hoje, 1);
  const diaSemana = new Intl.DateTimeFormat('pt-BR', {
    timeZone: config.timezone,
    weekday: 'long',
  }).format(now);

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
- Data e hora atuais: ${diaSemana}, ${nowStr} (fuso ${config.timezone}).
  HOJE é ${hoje} e AMANHÃ é ${amanha} (formato YYYY-MM-DD). Ao interpretar "hoje",
  "amanhã" ou dias da semana, parta SEMPRE destas datas — nunca calcule de cabeça.
  Um compromisso de hoje à noite continua sendo HOJE (${hoje}), mesmo tarde.
- Você PODE criar lembretes e salvar fatos usando as ferramentas disponíveis.
- Memória ativa: sempre que o Igor revelar uma DECISÃO importante, uma PREFERÊNCIA, ou um
  PADRÃO de comportamento relevante para a sua área, salve com a ferramenta "salvar_fato"
  por conta própria (sem ele pedir), de forma concisa. Isso enriquece suas respostas futuras.
  Não salve trivialidades nem coisas temporárias.
- Se a tarefa do Igor envolver claramente OUTRA área (ex: você é o financeiro mas ele toca num
  assunto pessoal/odontológico), use a ferramenta "consultar_subagente" para obter a visão do
  agente daquela área e combine as duas perspectivas numa resposta única e coerente.
${
    opts.isCorrection
      ? `- ATENÇÃO: a mensagem atual parece CORRIGIR um erro seu. Faça três coisas: (1) reconheça
  com naturalidade, sem se desculpar demais; (2) conserte de fato o que foi pedido, usando as
  ferramentas se preciso; (3) salve a lição com "salvar_fato", começando com "Correção:" —
  o que você errou e o que fazer da próxima vez. Assim você não repete o erro.
`
      : ''
  }- Você tem acesso à ferramenta "pesquisar" (busca na web). Use-a por conta própria,
  sem o Igor pedir, sempre que dados atuais ou que você não tenha certeza melhorariam
  sua resposta (preços, cotações, versões, notícias, novidades do seu domínio). Depois
  incorpore os achados naturalmente à sua resposta — falando como o subagente
  "${subagent.name}", sem colar o texto da pesquisa cru e sem dizer "segundo a pesquisa".
  Cite as fontes brevemente só quando fizer sentido.${
    facts.length
      ? `\n\nFatos que você sabe sobre o Igor e os projetos dele (memória compartilhada entre as áreas):\n${facts
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
  // Temperature baixa: agente que chama ferramentas precisa de consistência,
  // não de criatividade. Modelos gpt-5*/o* só aceitam a padrão — omitimos.
  const temp = supportsCustomTemperature(config.openai.model) ? { temperature: 0.3 } : {};

  // Loop de tool-calling: o modelo pode chamar ferramentas antes da resposta final.
  for (let step = 0; step < 4; step++) {
    const completion = await openai.chat.completions.create({
      model: config.openai.model,
      ...temp,
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
      const result = await executeTool(call, subagent.id, contact, depth);
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
    ...temp,
    messages,
  });
  return finalCompletion.choices[0].message.content?.trim() || '';
}

/** Executa uma ferramenta chamada pelo modelo e retorna um resumo textual. */
async function executeTool(
  call: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
  subagentId: string,
  contact: string,
  depth = 0
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
      // ISO sem offset é hora LOCAL do usuário, não do servidor (UTC no container).
      const when = parseLocalIso(quando);
      if (!texto || isNaN(when.getTime())) {
        return 'Não foi possível criar: texto ou data inválidos.';
      }
      const recorrencia = String(args.recorrencia || '').trim() as Task['recurrence'];
      const recValida =
        recorrencia && ['diaria', 'semanal', 'mensal', 'dias_uteis'].includes(recorrencia)
          ? recorrencia
          : null;
      // F5: estima a duração da tarefa (best-effort; não bloqueia se falhar).
      const estimatedMinutes = await estimateDurationMinutes(texto, 'task');
      const created = await createTask({
        text: texto,
        remindAt: when.toISOString(),
        to: contact || config.ownerPhone,
        subagentId,
        ...(estimatedMinutes ? { estimatedMinutes } : {}),
        ...(recValida ? { recurrence: recValida } : {}),
      });
      recordUndo(contact, `a criação do lembrete "${texto}"`, () => deleteTask(created.id));
      const quandoBr = when.toLocaleString('pt-BR', { timeZone: config.timezone });
      const dur = estimatedMinutes
        ? ` Estimo ~${estimatedMinutes} min — me avise se quiser ajustar.`
        : '';
      const rec = recValida ? ` Recorrência: ${recValida.replace('_', ' ')}.` : '';
      return `Lembrete criado para ${quandoBr}: "${texto}".${rec}${dur}`;
    }

    if (call.function.name === 'listar_lembretes') {
      const data = String(args.data || '').trim();
      const pending = (await listTasks()).filter((t) => !t.done);
      const filtered = data
        ? pending.filter((t) => dayKey(new Date(t.remindAt)) === data)
        : pending;
      if (filtered.length === 0) {
        return data ? `Sem lembretes pendentes em ${data}.` : 'Sem lembretes pendentes.';
      }
      return filtered
        .slice(0, 30)
        .map((t) => {
          const d = new Date(t.remindAt);
          const rec = t.recurrence ? ` (${t.recurrence.replace('_', ' ')})` : '';
          return `- id: ${t.id} | ${dayKey(d)} ${timeKey(d)} | ${t.text}${rec}`;
        })
        .join('\n');
    }

    if (call.function.name === 'editar_lembrete') {
      const id = String(args.id || '').trim();
      const texto = String(args.texto || '').trim();
      const quando = String(args.quando_iso || '').trim();
      const recRaw = String(args.recorrencia || '').trim();
      if (!id) return 'Informe o id do lembrete.';
      if (!texto && !quando && !recRaw) {
        return 'Nada para alterar: informe texto, quando_iso e/ou recorrencia.';
      }
      const task = await getTask(id);
      if (!task) return `Lembrete "${id}" não encontrado. Use listar_lembretes para ver os ids.`;

      const updates: Partial<Omit<Task, 'id' | 'createdAt'>> = {};
      if (texto) updates.text = texto;
      if (recRaw) {
        if (recRaw === 'nenhuma') updates.recurrence = null;
        else if (['diaria', 'semanal', 'mensal', 'dias_uteis'].includes(recRaw)) {
          updates.recurrence = recRaw as Task['recurrence'];
        } else {
          return 'Recorrência inválida: use diaria, semanal, mensal, dias_uteis ou nenhuma.';
        }
      }
      if (quando) {
        const when = parseLocalIso(quando);
        if (isNaN(when.getTime())) return 'Horário inválido; use ISO 8601 (2026-06-10T08:30:00).';
        updates.remindAt = when.toISOString();
        // Rearma o disparo: se o lembrete antigo já tinha tocado (done=true sem
        // completedAt), o novo horário deve tocar de novo.
        if (!task.completedAt) updates.done = false;
      }
      await updateTask(id, updates);
      const prev = {
        text: task.text,
        remindAt: task.remindAt,
        done: task.done,
        recurrence: task.recurrence ?? null,
      };
      recordUndo(contact, `a edição do lembrete "${task.text}"`, () => updateTask(id, prev));

      const after = { ...task, ...updates };
      const quandoBr = new Date(after.remindAt).toLocaleString('pt-BR', {
        timeZone: config.timezone,
      });
      return `Lembrete atualizado: "${after.text}" — ${quandoBr}.`;
    }

    if (call.function.name === 'remover_lembrete') {
      const id = String(args.id || '').trim();
      if (!id) return 'Informe o id do lembrete.';
      const task = await getTask(id);
      if (!task) return `Lembrete "${id}" não encontrado. Use listar_lembretes para ver os ids.`;
      await deleteTask(id);
      recordUndo(contact, `a remoção do lembrete "${task.text}"`, async () => {
        await createTask({
          text: task.text,
          remindAt: task.remindAt,
          to: task.to,
          ...(task.subagentId ? { subagentId: task.subagentId } : {}),
          ...(task.estimatedMinutes ? { estimatedMinutes: task.estimatedMinutes } : {}),
        });
      });
      return `Lembrete removido: "${task.text}".`;
    }

    if (call.function.name === 'desfazer_ultima_acao') {
      return await undoLast(contact);
    }

    if (call.function.name === 'salvar_fato') {
      const fato = String(args.fato || '').trim();
      if (!fato || !contact) return 'Nada para salvar.';
      // Pool compartilhado com embedding: todas as áreas enxergam o fato.
      await rememberFact(contact, subagentId, fato);
      return `Fato memorizado: "${fato}".`;
    }

    if (call.function.name === 'acionar_automacao') {
      const nome = String(args.nome || '').trim();
      if (!nome) return 'Informe o nome da automação.';
      const dadosRaw = String(args.dados || '').trim();
      // Aceita JSON ou texto livre nos dados.
      let dados: unknown = dadosRaw || undefined;
      if (dadosRaw.startsWith('{') || dadosRaw.startsWith('[')) {
        try {
          dados = JSON.parse(dadosRaw);
        } catch {
          /* mantém como texto */
        }
      }
      return await triggerAutomation(nome, dados);
    }

    if (call.function.name === 'pesquisar') {
      const tema = String(args.tema || '').trim();
      if (!tema) return 'Tema de pesquisa vazio.';
      // Modo 'findings': material de apoio cru, para o subagente integrar à sua
      // própria resposta (em vez de colar uma resposta pronta).
      return await research(tema, 'findings');
    }

    if (call.function.name === 'consultar_subagente') {
      // F8: encadeamento. Profundidade máxima 1 para evitar loops.
      if (depth >= 1) {
        return 'Encadeamento já em uso; responda com o que tem, sem consultar outro agente.';
      }
      const area = String(args.area || '').trim();
      const pergunta = String(args.pergunta || '').trim();
      if (!area || !pergunta) return 'Informe a área e a pergunta para consultar.';

      const subs = await listSubagents();
      const lower = area.toLowerCase();
      const target =
        subs.find((s) => s.id === area) ||
        subs.find((s) => s.name.toLowerCase() === lower) ||
        subs.find((s) => s.name.toLowerCase().includes(lower)) ||
        subs.find((s) => s.keywords.some((k) => lower.includes(k.toLowerCase())));
      if (!target) return `Não encontrei um subagente para a área "${area}".`;
      if (target.id === subagentId) return 'Essa área é a sua própria; responda diretamente.';

      const mem = contact ? await getRecentMemory(contact, target.id, 6) : [];
      const resposta = await runSubagent(target, pergunta, mem, false, contact, depth + 1);
      return `Resposta do subagente "${target.name}":\n${resposta}`;
    }

    if (call.function.name === 'gerar_cronograma') {
      const data = String(args.data || '').trim() || dayKey();
      const enviar = args.enviar === true;
      if (enviar) {
        await sendDailySchedule(data);
        return `Cronograma de ${data} gerado e enviado pelo WhatsApp.`;
      }
      const items = await generateDailySchedule(data);
      const base = formatSchedule(items, data);
      const overload = await detectOverload(data);
      return overload ? `${base}\n\n${overload}` : base;
    }

    if (call.function.name === 'realocar_agenda') {
      const instrucao = String(args.instrucao || '').trim();
      if (!instrucao) return 'Diga o que devo reorganizar.';
      // Snapshot dos horários do dia para permitir desfazer a reorganização.
      const before = (await getAgendaForDay(dayKey())).map((i) => ({
        id: i.id,
        startTime: i.startTime,
        endTime: i.endTime,
      }));
      const result = await reorganize(instrucao);
      recordUndo(contact, 'a reorganização da agenda de hoje', async () => {
        for (const item of before) {
          await updateAgendaItem(item.id, {
            startTime: item.startTime,
            endTime: item.endTime,
          });
        }
      });
      return result;
    }

    if (call.function.name === 'criar_evento') {
      const titulo = String(args.titulo || '').trim();
      const data = String(args.data || '').trim() || dayKey();
      const inicio = String(args.inicio || '').trim();
      const fim = String(args.fim || '').trim();
      const fixo = args.fixo !== false;
      if (!titulo) return 'Informe o título do evento.';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return 'Data inválida; use YYYY-MM-DD.';
      if (!/^\d{2}:\d{2}$/.test(inicio) || !/^\d{2}:\d{2}$/.test(fim)) {
        return 'Horários inválidos; use HH:mm (ex: 15:00).';
      }
      if (fim <= inicio) return 'O fim deve ser depois do início.';
      const item = await createAgendaItem({
        title: titulo,
        date: data,
        startTime: inicio,
        endTime: fim,
        priority: fixo ? 1 : 3,
        type: 'event',
        createdBy: 'user',
      });
      recordUndo(contact, `a criação do evento "${titulo}"`, () => deleteAgendaItem(item.id));
      return `Evento criado: "${titulo}" em ${data}, ${inicio}–${fim}${fixo ? ' (fixo)' : ''}.`;
    }

    if (call.function.name === 'listar_itens_agenda') {
      const data = String(args.data || '').trim() || dayKey();
      const items = await getAgendaForDay(data);
      if (items.length === 0) return `Sem itens na agenda de ${data}.`;
      return items
        .map(
          (i) =>
            `- id: ${i.id} | ${i.startTime}–${i.endTime} | ${i.title} | prio ${i.priority}` +
            `${i.priority === 1 ? ' (fixo)' : ''} | ${i.status}`
        )
        .join('\n');
    }

    if (call.function.name === 'editar_item_agenda') {
      const id = String(args.id || '').trim();
      if (!id) return 'Informe o id do item.';
      const item = await getAgendaItem(id);
      if (!item) return `Item "${id}" não encontrado. Use listar_itens_agenda para ver os ids.`;

      const titulo = String(args.titulo || '').trim();
      const inicio = String(args.inicio || '').trim();
      const fim = String(args.fim || '').trim();
      const data = String(args.data || '').trim();
      if (inicio && !/^\d{2}:\d{2}$/.test(inicio)) return 'Início inválido; use HH:mm.';
      if (fim && !/^\d{2}:\d{2}$/.test(fim)) return 'Fim inválido; use HH:mm.';
      if (data && !/^\d{4}-\d{2}-\d{2}$/.test(data)) return 'Data inválida; use YYYY-MM-DD.';

      const updates: Partial<Pick<AgendaItem, 'title' | 'startTime' | 'endTime' | 'date'>> = {};
      if (titulo) updates.title = titulo;
      if (inicio) updates.startTime = inicio;
      if (fim) updates.endTime = fim;
      if (data) updates.date = data;
      if (Object.keys(updates).length === 0) {
        return 'Nada para alterar: informe título, horários e/ou data.';
      }
      await updateAgendaItem(id, updates);
      recordUndo(contact, `a edição do item "${item.title}"`, () =>
        updateAgendaItem(id, {
          title: item.title,
          startTime: item.startTime,
          endTime: item.endTime,
          date: item.date,
        })
      );
      const after = { ...item, ...updates };
      return `Item atualizado: "${after.title}" em ${after.date}, ${after.startTime}–${after.endTime}.`;
    }

    if (call.function.name === 'remover_item_agenda') {
      const id = String(args.id || '').trim();
      if (!id) return 'Informe o id do item.';
      const item = await getAgendaItem(id);
      if (!item) return `Item "${id}" não encontrado. Use listar_itens_agenda para ver os ids.`;
      await deleteAgendaItem(id);
      recordUndo(contact, `a remoção do item "${item.title}"`, async () => {
        await createAgendaItem({
          title: item.title,
          date: item.date,
          startTime: item.startTime,
          endTime: item.endTime,
          priority: item.priority,
          type: item.type,
          createdBy: item.createdBy,
          status: item.status,
          ...(item.notes ? { notes: item.notes } : {}),
          ...(item.subagentId ? { subagentId: item.subagentId } : {}),
          ...(item.estimatedMinutes ? { estimatedMinutes: item.estimatedMinutes } : {}),
          ...(item.taskId ? { taskId: item.taskId } : {}),
        });
      });
      return `Item removido da agenda: "${item.title}" (${item.date} ${item.startTime}–${item.endTime}).`;
    }

    if (call.function.name === 'concluir_tarefa_atual') {
      const active = await getActiveItem();
      if (!active) return 'Não há tarefa em andamento na agenda de hoje.';
      await advanceTask(active);
      return `Tarefa "${active.title}" concluída e próxima iniciada.`;
    }

    if (call.function.name === 'ver_agenda') {
      const dias = Number(args.dias);
      return await upcomingView(Number.isFinite(dias) && dias > 0 ? Math.floor(dias) : 7);
    }

    if (call.function.name === 'ver_semana') {
      return await weeklyView();
    }

    if (call.function.name === 'ver_mes') {
      return await monthlyView();
    }
  } catch (err) {
    console.error('[tool] erro ao executar', call.function.name, err);
    return 'Houve um erro ao executar a ação.';
  }

  return 'Ferramenta desconhecida.';
}
