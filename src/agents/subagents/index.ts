import { Subagent, MemoryMessage, Task, AgendaItem, UndoOp } from '../../types';
import { openai, ChatMessage, supportsCustomTemperature } from '../../services/openai';
import { config } from '../../config';
import {
  createTask,
  listTasks,
  taskHasReminder,
  getTask,
  updateTask,
  deleteTask,
  markTaskDone,
  listSubagents,
  getRecentMemory,
  getAgendaForDay,
  updateAgendaItem,
  createAgendaItem,
  getAgendaItem,
  deleteAgendaItem,
  getAgendaItemsByTaskId,
  getPendingRouteSuggestion,
  markRouteSuggestionApplied,
  updateSubagent,
  unarchiveSharedFact,
} from '../../services/firebase';
import { recordUndo, undoLast } from '../undo';
import { getProfileCached } from '../maintenance';
import {
  rememberFact,
  recallFacts,
  searchHistory,
  neutralizeCommitmentFact,
} from '../../services/memory';
import { listAutomations, triggerAutomation } from '../../services/n8n';
import { listConnectedApps, describeApp, queryApp } from '../../services/apps';
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
  isLaterSlot,
  procrastinationWarning,
  PROCRASTINATION_THRESHOLD,
  dayKey,
  addDays,
} from '../orchestrator';
import { parseLocalIso, timeKey } from '../../services/datetime';
import {
  calendarEnabled,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from '../../services/googleCalendar';
import type OpenAI from 'openai';
import { proactiveMuted } from '../pause';

/** Nome do subagente que recebe as ferramentas de orquestração da agenda. */
export const ORCHESTRATOR_NAME = 'Agenda / Orquestrador';

/** Ferramentas que o agente pode chamar por conta própria (function calling). */
/** Teto de itens devolvidos por listar_lembretes; o excedente é anunciado, nunca omitido em silêncio. */
const LIST_TASKS_LIMIT = 60;

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
        'Lista lembretes/tarefas com id, data e hora locais. Use para descobrir o id antes de ' +
        'editar_lembrete/remover_lembrete/concluir_lembrete, ou quando o usuário perguntar ' +
        'quais lembretes existem.',
      parameters: {
        type: 'object',
        properties: {
          data: {
            type: 'string',
            description: 'Filtra por um dia local YYYY-MM-DD. Opcional; sem filtro, lista todos.',
          },
          status: {
            type: 'string',
            enum: ['pendentes', 'disparados_hoje'],
            description:
              '"pendentes" (padrão) ou "disparados_hoje": lembretes que tocaram hoje e ainda ' +
              'não foram confirmados como feitos (para o acompanhamento do dia).',
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
        'para mudar/adiar/ANTECIPAR/renomear um compromisso que é um lembrete (ex: "isso é para ' +
        'hoje", "joga pra amanhã"). O bloco correspondente no cronograma é movido JUNTO, ' +
        'automaticamente — NÃO crie um evento novo na agenda para a mesma tarefa. Se não souber ' +
        'o id, chame listar_lembretes primeiro — NUNCA diga que não há o que alterar sem listar antes.',
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
      name: 'concluir_lembrete',
      description:
        'Marca um lembrete como realmente FEITO (confirmado pelo Igor) — usado no acompanhamento ' +
        'do dia, quando ele disser que concluiu algo que tinha tocado. Se não souber o id, use ' +
        'listar_lembretes com status "disparados_hoje". Para a tarefa atual da AGENDA, prefira ' +
        'concluir_tarefa_atual.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ID do lembrete.' },
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
      name: 'buscar_no_historico',
      description:
        'Busca semântica em TODO o histórico de conversas antigas com o Igor (além das últimas ' +
        'mensagens que você já vê). Use sempre que ele referenciar algo do passado: "o que ' +
        'combinamos", "aquele cliente que te falei", "semana passada", "você lembra...". ' +
        'Retorna as trocas mais relevantes com data e contexto.',
      parameters: {
        type: 'object',
        properties: {
          consulta: {
            type: 'string',
            description: 'O que procurar, em linguagem natural (ex: "acordo com o João sobre entrega").',
          },
        },
        required: ['consulta'],
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
      name: 'aplicar_sugestoes_roteamento',
      description:
        'Aplica as sugestões PENDENTES de palavras-chave de roteamento (geradas pelo ' +
        'aprendizado semanal — relatório 🧭). Use SOMENTE quando o Igor confirmar que quer ' +
        'aplicá-las (ex: "aplica as sugestões de roteamento", "pode aplicar").',
      parameters: { type: 'object', properties: {}, required: [] },
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
 * Tools de apps conectados (CRM, SaaS...) — só entram quando há apps em
 * CONNECTED_APPS. Leitura apenas; a lista de apps vai na descrição.
 */
function appsTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const resumo = listConnectedApps()
    .map((a) => `"${a.name}" (${a.description})`)
    .join(', ');
  return [
    {
      type: 'function',
      function: {
        name: 'explorar_app',
        description:
          'Mostra o mapa de um app conectado do Igor: as collections do banco e o que contêm. ' +
          `Use antes de consultar_app quando não souber onde está o dado. Apps: ${resumo}.`,
        parameters: {
          type: 'object',
          properties: {
            app: { type: 'string', description: 'Nome do app (ex: "crm").' },
          },
          required: ['app'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'consultar_app',
        description:
          'Consulta (SOMENTE leitura) dados reais de um app conectado do Igor — clientes, ' +
          'negócios, agendamentos etc. Use para responder perguntas sobre os negócios dele ' +
          `com dados de verdade. Apps: ${resumo}. Filtros são igualdade exata em até 3 campos.`,
        parameters: {
          type: 'object',
          properties: {
            app: { type: 'string', description: 'Nome do app (ex: "crm").' },
            colecao: { type: 'string', description: 'Collection a consultar.' },
            filtros: {
              type: 'string',
              description:
                'JSON de filtros por igualdade, ex: {"empresaId":"abc","status":"aberto"}. Opcional.',
            },
            limite: {
              type: 'number',
              description: 'Máximo de documentos (padrão 10, teto 20).',
            },
          },
          required: ['app', 'colecao'],
        },
      },
    },
  ];
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
        'Reorganiza os BLOCOS do cronograma de um dia conforme um pedido em linguagem natural ' +
        '(ex: "adia o dentista pra depois do almoço"). Por padrão itens fixos (prioridade 1) ' +
        'não são movidos. Para mudar horário/texto de um LEMBRETE avulso, prefira ' +
        'listar_lembretes + editar_lembrete.',
      parameters: {
        type: 'object',
        properties: {
          instrucao: {
            type: 'string',
            description: 'O pedido de realocação, em linguagem natural.',
          },
          data: {
            type: 'string',
            description:
              'Dia local YYYY-MM-DD a reorganizar. Opcional; padrão = hoje. Use a data de ' +
              'AMANHÃ do contexto quando o pedido for sobre amanhã.',
          },
          readaptar_tudo: {
            type: 'boolean',
            description:
              'true quando o Igor pede para READAPTAR/RECOMEÇAR o dia inteiro a partir de um ' +
              'horário (ex: "readapte minha agenda para começar às 9:30", "joga tudo pra depois ' +
              'das 14h"). Nesse caso até os itens fixos podem ser movidos. Padrão false: ajuste ' +
              'pontual que preserva os compromissos fixos.',
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
        'Cria um bloco com horário de início e fim na agenda. Por padrão o bloco é MÓVEL: ' +
        'o reorganizador pode remanejá-lo quando o Igor pedir para readaptar o dia. Marque ' +
        'fixo=true SOMENTE quando for um compromisso real com hora marcada e inegociável ' +
        '(ex: "reunião 15h", "dentista 10h", evento de calendário) — nunca para tarefas que ' +
        'você apenas encaixou num horário sugerido ("terminar os pedidos", "criar os bots"), ' +
        'pois isso travaria a readaptação. Para um simples "me lembra de X", use criar_lembrete.',
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
            description:
              'true SÓ para compromisso real com hora marcada e inegociável (reunião, médico). ' +
              'Padrão false: bloco apenas encaixado num horário, que o agente pode remanejar.',
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
        'Altera um item da agenda: título, horários e/ou dia. Se o item nasceu de um lembrete, ' +
        'o lembrete é movido junto automaticamente (dispara no novo dia/horário). Se não souber ' +
        'o id, chame listar_itens_agenda primeiro.',
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

/** Conjunto de tools efetivo para um subagente (base + n8n + apps + orquestrador). */
function toolsFor(subagent: Subagent): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const base = [...TOOLS];
  if (listAutomations().length > 0) base.push(n8nTool());
  if (listConnectedApps().length > 0) base.push(...appsTools());
  return subagent.name === ORCHESTRATOR_NAME ? [...base, ...ORCHESTRATOR_TOOLS] : base;
}

// ===================== Guarda anti-alucinação de ação =====================

/**
 * Ferramentas que ALTERAM estado (criam/editam/removem algo persistido). Se a
 * resposta final afirma ter agendado/criado/alterado algo e NENHUMA destas foi
 * chamada na rodada, a afirmação é falsa — nada foi salvo.
 */
const WRITE_TOOLS = new Set([
  'criar_lembrete',
  'editar_lembrete',
  'concluir_lembrete',
  'remover_lembrete',
  'criar_evento',
  'editar_item_agenda',
  'remover_item_agenda',
  'concluir_tarefa_atual',
  'realocar_agenda',
  'gerar_cronograma',
  'desfazer_ultima_acao',
  'acionar_automacao',
  'salvar_fato',
  'aplicar_sugestoes_roteamento',
]);

/**
 * Afirmações fortes de ação concluída/prometida sobre agenda e lembretes
 * ("organizei seu bloco", "vou te mandar lembrete", "agendei"). Usado SÓ quando
 * nenhuma WRITE_TOOL foi chamada — aí a resposta promete o que não existe.
 * Exportado para outros pontos que enviam texto de LLM SEM ferramentas
 * (ex: proatividade diária), onde QUALQUER promessa dessas é falsa.
 */
export const CLAIMS_ACTION_REGEX =
  /\b(agendei|criei|marquei|remarquei|adiei|encaixei|reorganizei|organizei|realoquei|atualizei (a |sua )?agenda|vou te lembrar|te lembro (às|as|nesses)|vou (te )?mandar lembrete|vou (organizar|criar|registrar|adicionar|anotar).{0,40}\b(tarefas?|lembretes?)\b|lembretes? (criado|marcado|agendado)s?|(está|tá|fica) agendado|deixei (anotado|agendado|marcado))\b/i;

/** Mensagem injetada quando o modelo afirma ter agendado sem chamar ferramenta. */
const HALLUCINATION_NUDGE =
  'ATENÇÃO: sua resposta afirma que você criou/organizou/agendou algo, mas você NÃO chamou ' +
  'nenhuma ferramenta nesta rodada — NADA foi salvo e nenhum lembrete vai tocar. Faça uma das ' +
  'duas coisas AGORA: (1) chame as ferramentas (criar_lembrete, criar_evento, ...) para criar ' +
  'DE FATO cada item que você prometeu, e só então confirme; ou (2) se não for possível criar, ' +
  'reformule a resposta sem prometer nada que não foi feito.';

/**
 * Executa um subagente com function calling: monta o system prompt (personalidade
 * + fatos memorizados), injeta o histórico e deixa o modelo usar ferramentas
 * (criar lembrete, salvar fato) antes de produzir a resposta final.
 */
export interface ToolCallMetadata {
  name: string;
  args: string;
  result: string;
}

export async function runSubagent(
  subagent: Subagent,
  userText: string,
  memory: MemoryMessage[],
  fromAudio = false,
  contact = '',
  /** Profundidade de encadeamento (F8). 0 = chamada direta; >=1 = via consultar_subagente. */
  depth = 0,
  opts: { isCorrection?: boolean; crossContext?: string; ragContext?: string } = {}
): Promise<{ reply: string; toolCalls: ToolCallMetadata[] }> {
  // Memória de fatos: pool semântico COMPARTILHADO (relevância para a mensagem
  // atual, entre todas as áreas), banco ÚNICO com embedding. Os fatos legados
  // (factsCol, sem embedding e invisíveis no painel) foram unificados nesse pool
  // pela migração; não são mais lidos à parte para não ressuscitarem fatos que
  // o usuário não consegue ver nem apagar. O perfil vivo (resumo consolidado
  // pela manutenção noturna) entra sempre, mesmo sem fato puxado por similaridade.
  let facts: string[] = [];
  let profile = '';
  if (contact) {
    const [shared, prof] = await Promise.all([
      recallFacts(contact, userText, 12).catch(() => [] as string[]),
      getProfileCached(contact),
    ]);
    facts = shared.slice(0, 12);
    profile = prof;
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

Estilo (braço direito do Igor — consultivo, não tagarela):
- Comece pela resposta. Sem abertura ritual ("Claro!", "Com certeza!", "Ótima pergunta!"),
  sem repetir a pergunta dele de volta e sem fechar com oferta vazia ("precisa de mais
  alguma coisa?"). Corte preâmbulo e meta-comentário ("como assistente, vou...").
- Não bajule. Vá ao ponto com a confiança de quem conhece o contexto do Igor.
- Seja consultivo: além de responder, ANTECIPE. Quando agregar valor de verdade, aponte
  em uma linha um risco, um próximo passo óbvio ou a pergunta certa que ele não fez —
  sem inventar trabalho nem alongar à toa. Se a resposta é simples, entregue e pare.
- Use os fatos que você sabe sobre o Igor de forma IMPLÍCITA (aja de acordo com eles),
  não os recite de volta ("Como você prefere X..."). Ele já sabe o que te contou.
- ENXUTO por padrão (é WhatsApp): mesmo em perguntas abertas, dê o essencial em até
  3-4 pontos, SEM sub-bullets aninhados e sem subdividir em muitas seções. Escolha o que
  mais importa em vez de listar tudo que existe. Se houver muito a dizer, entregue o
  núcleo e ofereça aprofundar UM ponto ("quer que eu detalhe a parte de X?") — não
  despeje o manual inteiro de uma vez.
- LIMITE DE TAMANHO: sua resposta final deve ter no máximo 480 caracteres. Comece pela
  decisão, confirmação ou resposta útil; se precisar aprofundar, pare e pergunte antes.
- EXCEÇÃO — LISTA COMPLETA PEDIDA: quando o Igor pedir explicitamente TUDO ("mostre
  todos", "lista completa", "quero ver o resto", ou um "sim" respondendo à sua oferta de
  mostrar o restante), liste TODOS os itens que a ferramenta devolveu, um por linha, e
  ignore o limite de 480 — a entrega é quebrada em várias mensagens automaticamente.
  NÃO pagine de novo, não ofereça "quer ver o resto?" pela segunda vez e não prometa
  mandar em blocos: é só listar. Antes de listar, confira o "Total:" que a ferramenta
  informou e entregue essa quantidade exata.
- Formatação a serviço da clareza: listas só quando há itens de verdade; senão, frases.
  Nada de encher de bullets nem de negrito decorativo.
- NUNCA FUNDA ITENS DISTINTOS PARA CABER NO LIMITE. Tarefas, lembretes e eventos são
  registros separados, cada um com o texto que o Igor escreveu: cite cada um no seu
  próprio item, com o título original. É ERRADO colar vários num só com barra, "e" ou
  vírgula ("Logística / custos / hotel", "cobrar clientes e trocar hotel") — isso inventa
  uma tarefa que não existe e ele não consegue mais casar com a lista dele. Se não couber,
  encurte de outro jeito: mostre os 3-4 mais relevantes, cada um inteiro, e diga quantos
  ficaram de fora ("+6 pendentes, quer ver o resto?"). Melhor listar menos itens completos
  do que todos espremidos. Isso vale para a PRIMEIRA resposta; se ele pedir o resto,
  vale a exceção acima e você lista tudo.
- O Igor pode escrever ou mandar áudio; áudios já chegam transcritos. Trate-os como
  mensagens normais. NUNCA diga que não consegue ouvir ou processar áudios.${
    fromAudio ? '\n- A mensagem atual foi enviada por áudio (já transcrita).' : ''
  }
- Data e hora atuais: ${diaSemana}, ${nowStr} (fuso ${config.timezone}).
  HOJE é ${hoje} e AMANHÃ é ${amanha} (formato YYYY-MM-DD). Ao interpretar "hoje",
  "amanhã" ou dias da semana, parta SEMPRE destas datas — nunca calcule de cabeça.
  Um compromisso de hoje à noite continua sendo HOJE (${hoje}), mesmo tarde.
- DIA PADRÃO = HOJE. Quando o Igor der só um horário, sem dizer o dia ("Alexandre às
  10h", "reunião 15h", "me lembra às 18h"), o dia é HOJE (${hoje}) — a menos que esse
  horário JÁ TENHA PASSADO hoje, caso em que use AMANHÃ (${amanha}). NUNCA pule para um
  dia mais distante (sábado, semana que vem) por conta própria, nem para "não sobrecarregar"
  o dia: se o dia estiver cheio, CRIE no horário pedido mesmo assim e, se quiser, comente
  que ficou apertado — a escolha do dia é do Igor, não sua. Só pergunte o dia se ele for
  genuinamente ambíguo no pedido (ex: "semana que vem" sem dizer qual dia).
- Você PODE criar lembretes e salvar fatos usando as ferramentas disponíveis.
- Você vê apenas as ÚLTIMAS mensagens desta conversa. Se o Igor citar algo combinado antes
  que não esteja no histórico acima, use buscar_no_historico ANTES de dizer que não sabe ou
  de assumir que não existe.
- As mensagens do histórico começam com um carimbo [YYYY-MM-DD HH:mm] de quando foram ditas.
  É metadado para a sua leitura: NUNCA inclua carimbos assim nas suas respostas.
- O histórico pode conter planos e horários que JÁ PASSARAM. Antes de repetir, propor ou
  confirmar qualquer horário vindo do histórico, compare o carimbo dele com a data e hora
  atuais: nunca proponha um bloco que começa antes de agora — reancore a partir da hora atual
  e dos lembretes/agenda reais (listar_lembretes / agenda), não do que foi dito antes.
- NUNCA sugira, proponha ou reencaixe uma tarefa/lembrete que você viu APENAS no histórico
  da conversa sem antes confirmar, via listar_lembretes/agenda, que ela ainda está PENDENTE.
  Uma tarefa que apareceu antes pode já ter sido concluída ou apagada — o histórico não
  reflete o estado atual. Ex: não ofereça "encaixar X no sábado" se X não está na lista de
  pendências agora. Na dúvida, não mencione o item.
- CONCLUSÃO DE TAREFA: quando o Igor disser que fez/terminou/concluiu algo ("já fiz",
  "já foi feito", "concluí a tarefa das 9h", "terminei aquele item"), a resposta certa é
  MARCAR como concluído — nunca responder "não achei essa tarefa" e parar. Se ele citou o
  item da agenda em andamento, use concluir_tarefa_atual. Se citou um lembrete (ou não deu
  o título exato), chame listar_lembretes (status "disparados_hoje" e, se preciso,
  "pendentes"), identifique o item pelo contexto do dia/horário e conclua com
  concluir_lembrete. Só peça esclarecimento se houver DE FATO mais de um candidato plausível
  e você não conseguir decidir — e aí liste as opções para ele escolher, em vez de negar.
- REGRA INEGOCIÁVEL: NUNCA afirme que criou, agendou, alterou ou removeu lembrete/evento/
  agenda sem ter chamado a ferramenta correspondente NESTA conversa e visto a confirmação.
  Frases como "agendei", "organizei seu dia", "vou te mandar lembrete às X" só podem aparecer
  DEPOIS de a ferramenta confirmar. Se o Igor pedir para organizar um bloco de tarefas com
  horários, chame criar_lembrete (ou criar_evento) para CADA item ANTES de responder. Se você
  não tem a ferramenta necessária, diga isso — não finja que fez.
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
    profile
      ? `\n\nPerfil do Igor (resumo consolidado da memória — contexto de fundo, considere sempre):\n${profile}`
      : ''
  }${
    facts.length
      ? `\n\nFatos que você sabe sobre o Igor e os projetos dele (memória compartilhada entre as áreas):\n${facts
          .map((f) => `- ${f}`)
          .join('\n')}`
      : ''
  }${
    opts.crossContext
      ? `\n\nTrocas recentes desta MESMA conversa que foram atendidas por outras áreas do agente
(use para manter o fio do assunto; mas a fonte da verdade sobre agenda/lembretes são SEMPRE as
ferramentas — se outra área PROMETEU agendar algo, confirme com listar_lembretes antes de assumir
que existe):\n${opts.crossContext}`
      : ''
  }${
    opts.ragContext
      ? `\n\nTrechos de conversas ANTIGAS possivelmente relevantes (recuperados automaticamente por
similaridade — use se ajudarem a responder; podem estar DESATUALIZADOS: horários e planos antigos
não valem mais, e a fonte da verdade sobre agenda/lembretes são sempre as ferramentas):\n${opts.ragContext}`
      : ''
  }`;

  // Cada mensagem do histórico leva um carimbo [data hora] de quando foi dita.
  // Sem isso, um plano montado às 13:50 parece recém-combinado às 15:12 e o
  // modelo repete horários que já passaram.
  const stamp = (ts: number): string => {
    const d = new Date(ts);
    return `[${dayKey(d)} ${timeKey(d)}]`;
  };
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...memory.map(
      (m) =>
        ({
          role: m.role,
          content: m.timestamp ? `${stamp(m.timestamp)} ${m.content}` : m.content,
        } as ChatMessage)
    ),
    { role: 'user', content: userText },
  ];

  const tools = toolsFor(subagent);
  // Temperature baixa: agente que chama ferramentas precisa de consistência,
  // não de criatividade. Modelos gpt-5*/o* só aceitam a padrão — omitimos.
  const temp = supportsCustomTemperature(config.openai.model) ? { temperature: 0.3 } : {};

  // Guarda anti-alucinação: rastreia se alguma ferramenta de ESCRITA rodou.
  let usedWriteTool = false;
  let nudged = false;
  const toolCalls: ToolCallMetadata[] = [];

  // Loop de tool-calling: o modelo pode chamar ferramentas antes da resposta final.
  // (6 passos: até 4 de ferramentas + 1 possível correção anti-alucinação + resposta.)
  for (let step = 0; step < 6; step++) {
    const completion = await openai.chat.completions.create({
      model: config.openai.model,
      ...temp,
      messages,
      tools,
    });

    const choice = completion.choices[0].message;

    if (!choice.tool_calls || choice.tool_calls.length === 0) {
      const content = choice.content?.trim() || '';
      // Se a resposta AFIRMA ter agendado/criado algo mas nenhuma ferramenta de
      // escrita rodou, devolve a bola para o modelo: criar de verdade ou recuar.
      // Uma única tentativa, para não entrar em loop.
      if (!usedWriteTool && !nudged && CLAIMS_ACTION_REGEX.test(content)) {
        console.warn(`[subagent:${subagent.name}] resposta prometeu ação sem tool call — corrigindo.`);
        nudged = true;
        messages.push(choice);
        messages.push({ role: 'system', content: HALLUCINATION_NUDGE });
        continue;
      }
      return { reply: content, toolCalls };
    }

    // Registra a intenção do assistente e executa cada ferramenta.
    messages.push(choice);
    for (const call of choice.tool_calls) {
      if (WRITE_TOOLS.has(call.function.name)) usedWriteTool = true;
      const result = await executeTool(call, subagent.id, contact, depth);
      
      toolCalls.push({
        name: call.function.name,
        args: call.function.arguments || '{}',
        result,
      });

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
  return { reply: finalCompletion.choices[0].message.content?.trim() || '', toolCalls };
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
      // Idempotência: mesma proteção do criar_evento — texto igual no mesmo
      // minuto é chamada repetida do modelo, não um lembrete novo.
      const normLem = (s: string) => s.trim().toLowerCase();
      const duplicado = (await listTasks()).find(
        (t) =>
          !t.done &&
          normLem(t.text) === normLem(texto) &&
          Math.abs(new Date(t.remindAt).getTime() - when.getTime()) < 60000
      );
      if (duplicado) {
        const quandoDup = new Date(duplicado.remindAt).toLocaleString('pt-BR', {
          timeZone: config.timezone,
        });
        return (
          `Esse lembrete JÁ EXISTE para ${quandoDup}: "${duplicado.text}" (id: ${duplicado.id}). ` +
          `Nada foi criado de novo. Para alterar, use editar_lembrete com esse id.`
        );
      }
      // F5: estima a duração da tarefa (best-effort; não bloqueia se falhar).
      const estimatedMinutes = await estimateDurationMinutes(texto, 'task');
      // Pedir um novo lembrete durante uma pausa é autorização explícita para
      // ESTE item tocar. A pausa das cobranças antigas continua intacta.
      const bypassPause = await proactiveMuted(contact || config.ownerPhone);
      const created = await createTask({
        text: texto,
        remindAt: when.toISOString(),
        to: contact || config.ownerPhone,
        subagentId,
        ...(bypassPause ? { bypassPause: true } : {}),
        ...(estimatedMinutes ? { estimatedMinutes } : {}),
        ...(recValida ? { recurrence: recValida } : {}),
      });
      recordUndo(contact, `a criação do lembrete "${texto}"`, () => deleteTask(created.id), [
        { kind: 'task.delete', id: created.id },
      ]);
      const quandoBr = when.toLocaleString('pt-BR', { timeZone: config.timezone });
      const dur = estimatedMinutes
        ? ` Estimo ~${estimatedMinutes} min — me avise se quiser ajustar.`
        : '';
      const rec = recValida ? ` Recorrência: ${recValida.replace('_', ' ')}.` : '';
      const pauseNote = bypassPause
        ? ' A pausa geral continua ativa, mas este novo lembrete está autorizado a tocar.'
        : '';
      return `Lembrete criado para ${quandoBr}: "${texto}".${rec}${dur}${pauseNote}`;
    }

    if (call.function.name === 'listar_lembretes') {
      const data = String(args.data || '').trim();
      const status = String(args.status || 'pendentes').trim();
      const all = await listTasks();
      // Pendente = o Igor ainda não confirmou que fez (completedAt vazio). Não
      // dá para filtrar por `done`: esse campo diz que o lembrete DISPAROU no
      // WhatsApp, não que foi concluído — usá-lo sumia com tudo que tocou e
      // ficou sem resposta, que é justamente o que ele mais precisa ver.
      const byStatus =
        status === 'disparados_hoje'
          ? all.filter(
              (t) => t.done && !t.completedAt && dayKey(new Date(t.remindAt)) === dayKey()
            )
          : all.filter((t) => !t.completedAt);
      const filtered = data
        ? byStatus.filter((t) => dayKey(new Date(t.remindAt)) === data)
        : byStatus;
      if (filtered.length === 0) {
        if (status === 'disparados_hoje') return 'Nenhum lembrete disparado hoje sem confirmação.';
        return data ? `Sem lembretes pendentes em ${data}.` : 'Sem lembretes pendentes.';
      }
      const shown = filtered.slice(0, LIST_TASKS_LIMIT);
      const linhas = shown.map((t) => {
        const d = new Date(t.remindAt);
        const rec = t.recurrence ? ` (${t.recurrence.replace('_', ' ')})` : '';
        const tocou = t.done && !t.completedAt ? ' [já disparou, sem confirmação]' : '';
        // Tarefa sem prazo guarda em remindAt o instante da criação: mostrar
        // isso como horário faz o agente afirmar um prazo que não existe.
        const quando = taskHasReminder(t) ? `${dayKey(d)} ${timeKey(d)}` : 'sem prazo';
        return `- id: ${t.id} | ${quando} | ${t.text}${rec}${tocou}`;
      });
      // O corte precisa ser DITO: calado, o agente listava o pedaço e afirmava
      // que era tudo.
      const restante = filtered.length - shown.length;
      const rodape = restante > 0 ? `\n(+${restante} não listados — total de ${filtered.length})` : '';
      return `Total: ${filtered.length}\n${linhas.join('\n')}${rodape}`;
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
      let adiamentos = 0;
      if (quando) {
        const when = parseLocalIso(quando);
        if (isNaN(when.getTime())) return 'Horário inválido; use ISO 8601 (2026-06-10T08:30:00).';
        updates.remindAt = when.toISOString();
        // Rearma o disparo: se o lembrete antigo já tinha tocado (done=true sem
        // completedAt), o novo horário deve tocar de novo.
        if (!task.completedAt) updates.done = false;
        // F8: empurrar para MAIS TARDE conta como adiamento (ISO UTC compara
        // lexicograficamente); antecipar não conta.
        if (updates.remindAt > task.remindAt) {
          adiamentos = (task.postponedCount ?? 0) + 1;
          updates.postponedCount = adiamentos;
        }
      }
      // Mudou o horário: rearma também os marcadores da fila sequencial —
      // adiar/antecipar tira a tarefa do estado "aguardando confirmação".
      if (quando) {
        updates.firedAt = null;
        updates.lastNudgeAt = null;
      }
      await updateTask(id, updates);
      const prev = {
        text: task.text,
        remindAt: task.remindAt,
        done: task.done,
        recurrence: task.recurrence ?? null,
        postponedCount: task.postponedCount ?? 0,
      };
      const undoOps: UndoOp[] = [{ kind: 'task.update', id, data: prev }];

      // Propaga para os BLOCOS da agenda que nasceram deste lembrete: mover o
      // lembrete sem mover o bloco deixava o cronograma no dia/horário antigo
      // (era o bug do "antecipei e ele continuou lembrando no dia seguinte").
      const linked = (await getAgendaItemsByTaskId(id)).filter((i) => i.status !== 'done');
      const after = { ...task, ...updates };
      for (const item of linked) {
        const itemUpdates: Partial<
          Pick<AgendaItem, 'title' | 'date' | 'startTime' | 'endTime' | 'nudgedAt'>
        > = {};
        if (texto) itemUpdates.title = texto;
        if (quando) {
          const when = new Date(after.remindAt);
          const [sh, sm] = item.startTime.split(':').map(Number);
          const [eh, em] = item.endTime.split(':').map(Number);
          const dur = Math.max(5, (eh * 60 + em - (sh * 60 + sm) + 1440) % 1440);
          const startTime = timeKey(when);
          const [nh, nm] = startTime.split(':').map(Number);
          const endMin = nh * 60 + nm + dur;
          itemUpdates.date = dayKey(when);
          itemUpdates.startTime = startTime;
          itemUpdates.endTime = `${String(Math.floor(endMin / 60) % 24).padStart(2, '0')}:${String(
            endMin % 60
          ).padStart(2, '0')}`;
          itemUpdates.nudgedAt = null;
        }
        if (Object.keys(itemUpdates).length === 0) continue;
        await updateAgendaItem(item.id, itemUpdates);
        undoOps.push({
          kind: 'agenda.update',
          id: item.id,
          data: {
            title: item.title,
            date: item.date,
            startTime: item.startTime,
            endTime: item.endTime,
          },
        });
      }

      recordUndo(
        contact,
        `a edição do lembrete "${task.text}"`,
        async () => {
          await updateTask(id, prev);
          for (const item of linked) {
            await updateAgendaItem(item.id, {
              title: item.title,
              date: item.date,
              startTime: item.startTime,
              endTime: item.endTime,
            });
          }
        },
        undoOps
      );

      const quandoBr = new Date(after.remindAt).toLocaleString('pt-BR', {
        timeZone: config.timezone,
      });
      const alerta =
        adiamentos >= PROCRASTINATION_THRESHOLD
          ? `\n\n${procrastinationWarning(after.text, adiamentos)}`
          : '';
      const blocos = linked.length
        ? ` (bloco da agenda ${linked.length > 1 ? 'movidos' : 'movido'} junto)`
        : '';
      return `Lembrete atualizado: "${after.text}" — ${quandoBr}${blocos}.${alerta}`;
    }

    if (call.function.name === 'concluir_lembrete') {
      const id = String(args.id || '').trim();
      if (!id) return 'Informe o id do lembrete.';
      const task = await getTask(id);
      if (!task) return `Lembrete "${id}" não encontrado. Use listar_lembretes para ver os ids.`;
      if (task.completedAt) return `O lembrete "${task.text}" já estava concluído.`;
      await markTaskDone(id);
      // Conclui também os blocos da agenda ligados — senão o cronograma e o
      // follow-up das 20:30 continuariam cobrando um item já confirmado.
      const linkedDone = (await getAgendaItemsByTaskId(id)).filter((i) => i.status !== 'done');
      for (const item of linkedDone) {
        await updateAgendaItem(item.id, { status: 'done', completedAt: Date.now() });
      }
      // Arquiva o fato de memória que descreve o MESMO compromisso, se houver —
      // assim a proatividade e o recall param de cobrar algo já feito (era o caso
      // do "fornecedor de móveis"). Best-effort; nunca bloqueia a conclusão.
      const archivedFact = contact
        ? await neutralizeCommitmentFact(contact, task.text)
        : null;
      recordUndo(
        contact,
        `a conclusão do lembrete "${task.text}"`,
        async () => {
          await updateTask(id, { done: task.done, completedAt: null });
          for (const item of linkedDone) {
            await updateAgendaItem(item.id, {
              status: item.status,
              completedAt: item.completedAt ?? null,
            });
          }
          if (archivedFact) await unarchiveSharedFact(archivedFact.id);
        },
        [
          { kind: 'task.update', id, data: { done: task.done, completedAt: null } },
          ...linkedDone.map(
            (item): UndoOp => ({
              kind: 'agenda.update',
              id: item.id,
              data: { status: item.status, completedAt: item.completedAt ?? null },
            })
          ),
        ]
      );
      return `Concluído ✅: "${task.text}".`;
    }

    if (call.function.name === 'remover_lembrete') {
      const id = String(args.id || '').trim();
      if (!id) return 'Informe o id do lembrete.';
      const task = await getTask(id);
      if (!task) return `Lembrete "${id}" não encontrado. Use listar_lembretes para ver os ids.`;
      await deleteTask(id);
      // Remove também os blocos da agenda que nasceram deste lembrete — apagar
      // o lembrete e deixar o bloco fazia o cronograma cobrar um compromisso
      // que não existe mais.
      const linkedItems = (await getAgendaItemsByTaskId(id)).filter((i) => i.status !== 'done');
      for (const item of linkedItems) {
        await deleteAgendaItem(item.id);
      }
      // Recriar a task removida = a reversão (mesmo payload na closure e na
      // versão declarativa para o painel).
      const restorePayload = {
        text: task.text,
        remindAt: task.remindAt,
        to: task.to,
        ...(task.subagentId ? { subagentId: task.subagentId } : {}),
        ...(task.estimatedMinutes ? { estimatedMinutes: task.estimatedMinutes } : {}),
      };
      const itemPayloads = linkedItems.map((item) => ({
        title: item.title,
        date: item.date,
        startTime: item.startTime,
        endTime: item.endTime,
        priority: item.priority,
        type: item.type,
        status: item.status,
        createdBy: item.createdBy,
        ...(item.notes ? { notes: item.notes } : {}),
        ...(item.subagentId ? { subagentId: item.subagentId } : {}),
        ...(item.estimatedMinutes ? { estimatedMinutes: item.estimatedMinutes } : {}),
        ...(item.taskId ? { taskId: item.taskId } : {}),
      }));
      recordUndo(
        contact,
        `a remoção do lembrete "${task.text}"`,
        async () => {
          await createTask(restorePayload);
          for (const payload of itemPayloads) {
            await createAgendaItem(payload);
          }
        },
        [
          { kind: 'task.create', data: restorePayload },
          ...itemPayloads.map((data): UndoOp => ({ kind: 'agenda.create', data })),
        ]
      );
      const blocos = linkedItems.length
        ? ` (e ${linkedItems.length} bloco${linkedItems.length > 1 ? 's' : ''} da agenda)`
        : '';
      return `Lembrete removido: "${task.text}"${blocos}.`;
    }

    if (call.function.name === 'buscar_no_historico') {
      const consulta = String(args.consulta || '').trim();
      if (!consulta) return 'Diga o que devo procurar no histórico.';
      if (!contact) return 'Sem contato identificado para buscar histórico.';
      const hits = await searchHistory(contact, consulta);
      return hits.length
        ? `Trechos relevantes do histórico:\n\n${hits.join('\n\n')}`
        : 'Não encontrei nada relacionado no histórico de conversas.';
    }

    if (call.function.name === 'desfazer_ultima_acao') {
      return await undoLast(contact);
    }

    if (call.function.name === 'salvar_fato') {
      const fato = String(args.fato || '').trim();
      if (!fato || !contact) return 'Nada para salvar.';
      // Pool compartilhado com embedding: todas as áreas enxergam o fato.
      // A dedup semântica pode descartar um fato quase-igual a um já existente.
      const res = await rememberFact(contact, subagentId, fato);
      return res.saved
        ? `Fato memorizado: "${fato}".`
        : `Já sabia disso (algo equivalente já estava na memória); não dupliquei.`;
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

    if (call.function.name === 'explorar_app') {
      return await describeApp(String(args.app || '').trim());
    }

    if (call.function.name === 'consultar_app') {
      const app = String(args.app || '').trim();
      const colecao = String(args.colecao || '').trim();
      const limite = Number(args.limite) || 10;
      let filtros: Record<string, unknown> = {};
      const filtrosRaw = String(args.filtros || '').trim();
      if (filtrosRaw) {
        try {
          const parsed = JSON.parse(filtrosRaw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            filtros = parsed as Record<string, unknown>;
          }
        } catch {
          return 'Filtros inválidos: envie um JSON de igualdades, ex: {"status":"aberto"}.';
        }
      }
      return await queryApp(app, colecao, filtros, limite);
    }

    if (call.function.name === 'aplicar_sugestoes_roteamento') {
      const sug = await getPendingRouteSuggestion();
      if (!sug) return 'Não há sugestões de roteamento pendentes para aplicar.';
      const subs = await listSubagents(true);
      const aplicadas: string[] = [];
      const anteriores = new Map<string, string[]>();
      for (const item of sug.items) {
        const sub = subs.find((s) => s.id === item.subagentId);
        if (!sub) continue;
        const atuais = new Set(sub.keywords.map((k) => k.toLowerCase()));
        const novas = item.keywords.filter((k) => !atuais.has(k.toLowerCase()));
        if (novas.length === 0) continue;
        anteriores.set(sub.id, sub.keywords);
        await updateSubagent(sub.id, { keywords: [...sub.keywords, ...novas] });
        aplicadas.push(`${sub.name}: +${novas.join(', +')}`);
      }
      await markRouteSuggestionApplied(sug.id);
      if (aplicadas.length === 0) {
        return 'As sugestões pendentes já estavam cobertas pelas keywords atuais — nada a aplicar.';
      }
      recordUndo(contact, 'a aplicação das sugestões de roteamento', async () => {
        for (const [id, kw] of anteriores) {
          await updateSubagent(id, { keywords: kw });
        }
      });
      // O descritor do roteador por embedding inclui as keywords, então ele se
      // recalibra sozinho na próxima mensagem (a chave do cache muda).
      return `Sugestões aplicadas ✅:\n${aplicadas.join('\n')}`;
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
      const resSub = await runSubagent(target, pergunta, mem, false, contact, depth + 1);
      return `Resposta do subagente "${target.name}":\n${resSub.reply}`;
    }

    if (call.function.name === 'gerar_cronograma') {
      const data = String(args.data || '').trim() || dayKey();
      const enviar = args.enviar === true;
      if (enviar) {
        await sendDailySchedule(data);
        return `Cronograma de ${data} gerado e enviado pelo WhatsApp.`;
      }
      const { items, skipped } = await generateDailySchedule(data);
      const base = formatSchedule(items, data);
      // O que não coube precisa ser dito: calado, o dia só "terminava cedo".
      const fora = skipped.length
        ? `\n\n⚠️ Não couberam no limite de carga do dia (${skipped.length}): ` +
          skipped.map((t) => `${t.title} (${t.minutes}min)`).join('; ') +
          '. Diga se quer esticar o dia ou passar para amanhã.'
        : '';
      const overload = await detectOverload(data);
      return overload ? `${base}${fora}\n\n${overload}` : `${base}${fora}`;
    }

    if (call.function.name === 'realocar_agenda') {
      const instrucao = String(args.instrucao || '').trim();
      if (!instrucao) return 'Diga o que devo reorganizar.';
      const data = String(args.data || '').trim() || dayKey();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return 'Data inválida; use YYYY-MM-DD.';
      // Snapshot dos horários do dia para permitir desfazer a reorganização
      // (inclui o contador de adiamentos, que a realocação pode incrementar).
      const before = (await getAgendaForDay(data)).map((i) => ({
        id: i.id,
        startTime: i.startTime,
        endTime: i.endTime,
        postponedCount: i.postponedCount ?? 0,
      }));
      const forceAll = args.readaptar_tudo === true;
      const result = await reorganize(instrucao, data, forceAll);
      recordUndo(contact, `a reorganização da agenda de ${data}`, async () => {
        for (const item of before) {
          await updateAgendaItem(item.id, {
            startTime: item.startTime,
            endTime: item.endTime,
            postponedCount: item.postponedCount,
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
      const fixo = args.fixo === true;
      if (!titulo) return 'Informe o título do evento.';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return 'Data inválida; use YYYY-MM-DD.';
      if (!/^\d{2}:\d{2}$/.test(inicio) || !/^\d{2}:\d{2}$/.test(fim)) {
        return 'Horários inválidos; use HH:mm (ex: 15:00).';
      }
      if (fim <= inicio) return 'O fim deve ser depois do início.';
      // Idempotência: com plano de muitos itens, o modelo às vezes repete a
      // chamada para um evento que já criou em rodada anterior do tool-calling
      // (foi assim que a agenda ganhou itens duplicados). Mesmo título no mesmo
      // dia com horário sobreposto = já existe; não cria de novo.
      const normEv = (s: string) => s.trim().toLowerCase();
      const jaExiste = (await getAgendaForDay(data)).find(
        (i) => normEv(i.title) === normEv(titulo) && i.startTime < fim && inicio < i.endTime
      );
      if (jaExiste) {
        return (
          `Esse evento JÁ ESTÁ na agenda: "${jaExiste.title}" em ${data}, ` +
          `${jaExiste.startTime}–${jaExiste.endTime} (id: ${jaExiste.id}). Nada foi criado de novo. ` +
          `Para mudar horário ou título, use editar_item_agenda com esse id.`
        );
      }
      const item = await createAgendaItem({
        title: titulo,
        date: data,
        startTime: inicio,
        endTime: fim,
        priority: fixo ? 1 : 3,
        type: 'event',
        // Fixo = compromisso do usuário (imutável); móvel = bloco de planejamento
        // que o reorganizador pode remanejar. O createdBy precisa acompanhar o
        // fixo, senão a readaptação trava (reorganize pula createdBy === 'user').
        createdBy: fixo ? 'user' : 'agent',
      });
      // F10: evento FIXO também vai para o Google Calendar (best-effort — a
      // agenda local funciona igual se o Google falhar). Blocos não-fixos são
      // planejamento interno e não poluem o calendário.
      let gcalEventId: string | null = null;
      if (fixo && calendarEnabled()) {
        try {
          gcalEventId = await createCalendarEvent({ title: titulo, date: data, startTime: inicio, endTime: fim });
          if (gcalEventId) await updateAgendaItem(item.id, { gcalEventId });
        } catch (err) {
          console.error('[tool] criar_evento: falha ao criar no Google Calendar:', err);
        }
      }
      recordUndo(contact, `a criação do evento "${titulo}"`, async () => {
        await deleteAgendaItem(item.id);
        if (gcalEventId) await deleteCalendarEvent(gcalEventId).catch(() => undefined);
      });
      return (
        `Evento criado: "${titulo}" em ${data}, ${inicio}–${fim}${fixo ? ' (fixo)' : ''}` +
        `${gcalEventId ? ' — também adicionado ao seu Google Calendar' : ''}.`
      );
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

      const updates: Partial<
        Pick<AgendaItem, 'title' | 'startTime' | 'endTime' | 'date' | 'postponedCount'>
      > = {};
      if (titulo) updates.title = titulo;
      if (inicio) updates.startTime = inicio;
      if (fim) updates.endTime = fim;
      if (data) updates.date = data;
      if (Object.keys(updates).length === 0) {
        return 'Nada para alterar: informe título, horários e/ou data.';
      }
      // F8: mover para um slot MAIS TARDE (outro dia ou hora maior) é adiamento.
      let adiamentosItem = 0;
      if (
        (inicio || data) &&
        isLaterSlot(item.date, item.startTime, data || item.date, inicio || item.startTime)
      ) {
        adiamentosItem = (item.postponedCount ?? 0) + 1;
        updates.postponedCount = adiamentosItem;
      }
      await updateAgendaItem(id, updates);
      const after = { ...item, ...updates };
      // F10: item espelhado → propaga a edição para o Google Calendar.
      if (item.gcalEventId && calendarEnabled()) {
        try {
          await updateCalendarEvent(item.gcalEventId, {
            ...(titulo ? { title: after.title } : {}),
            date: after.date,
            startTime: after.startTime,
            endTime: after.endTime,
          });
        } catch (err) {
          console.error('[tool] editar_item_agenda: falha ao propagar para o Google Calendar:', err);
        }
      }
      // Propaga para o LEMBRETE que originou o bloco: mover o bloco sem mover a
      // task deixava o lembrete tocando no dia/horário antigo (o "antecipei e
      // ele continuou lembrando"). Rearma o disparo para o novo horário.
      let linkedTask: Task | null = null;
      let linkedTaskPrev: Partial<Omit<Task, 'id' | 'createdAt'>> | null = null;
      if (item.taskId && (data || inicio || titulo)) {
        linkedTask = await getTask(item.taskId);
        if (linkedTask && !linkedTask.completedAt) {
          linkedTaskPrev = {
            text: linkedTask.text,
            remindAt: linkedTask.remindAt,
            done: linkedTask.done,
            firedAt: linkedTask.firedAt ?? null,
            lastNudgeAt: linkedTask.lastNudgeAt ?? null,
          };
          await updateTask(linkedTask.id, {
            ...(titulo ? { text: titulo } : {}),
            ...(data || inicio
              ? {
                  remindAt: parseLocalIso(`${after.date}T${after.startTime}:00`).toISOString(),
                  done: false,
                  firedAt: null,
                  lastNudgeAt: null,
                }
              : {}),
          });
        } else {
          linkedTask = null;
        }
      }
      recordUndo(
        contact,
        `a edição do item "${item.title}"`,
        async () => {
          await updateAgendaItem(id, {
            title: item.title,
            startTime: item.startTime,
            endTime: item.endTime,
            date: item.date,
            postponedCount: item.postponedCount ?? 0,
          });
          if (linkedTask && linkedTaskPrev) {
            await updateTask(linkedTask.id, linkedTaskPrev);
          }
          if (item.gcalEventId && calendarEnabled()) {
            await updateCalendarEvent(item.gcalEventId, {
              title: item.title,
              date: item.date,
              startTime: item.startTime,
              endTime: item.endTime,
            }).catch(() => undefined);
          }
        },
        [
          {
            kind: 'agenda.update',
            id,
            data: {
              title: item.title,
              startTime: item.startTime,
              endTime: item.endTime,
              date: item.date,
              postponedCount: item.postponedCount ?? 0,
            },
          },
          ...(linkedTask && linkedTaskPrev
            ? [{ kind: 'task.update', id: linkedTask.id, data: linkedTaskPrev } as UndoOp]
            : []),
        ]
      );
      const alertaItem =
        adiamentosItem >= PROCRASTINATION_THRESHOLD
          ? `\n\n${procrastinationWarning(after.title, adiamentosItem)}`
          : '';
      const lembreteMovido = linkedTask ? ' O lembrete ligado foi movido junto.' : '';
      return `Item atualizado: "${after.title}" em ${after.date}, ${after.startTime}–${after.endTime}.${lembreteMovido}${alertaItem}`;
    }

    if (call.function.name === 'remover_item_agenda') {
      const id = String(args.id || '').trim();
      if (!id) return 'Informe o id do item.';
      const item = await getAgendaItem(id);
      if (!item) return `Item "${id}" não encontrado. Use listar_itens_agenda para ver os ids.`;
      await deleteAgendaItem(id);
      // Cancela também o LEMBRETE que originou o bloco (compromisso cancelado
      // = lembrete não deve mais tocar). Recorrentes ficam: a ocorrência some,
      // a série continua.
      let removedTask: Task | null = null;
      if (item.taskId) {
        const t = await getTask(item.taskId);
        if (t && !t.recurrence && !t.completedAt) {
          await deleteTask(t.id);
          removedTask = t;
        }
      }
      // F10: item espelhado → cancela o evento no Google Calendar também
      // (senão o próximo sync recriaria o item aqui).
      let gcalRemovido = false;
      if (item.gcalEventId && calendarEnabled()) {
        try {
          await deleteCalendarEvent(item.gcalEventId);
          gcalRemovido = true;
        } catch (err) {
          console.error('[tool] remover_item_agenda: falha ao remover do Google Calendar:', err);
        }
      }
      recordUndo(contact, `a remoção do item "${item.title}"`, async () => {
        if (removedTask) {
          await createTask({
            text: removedTask.text,
            remindAt: removedTask.remindAt,
            to: removedTask.to,
            ...(removedTask.subagentId ? { subagentId: removedTask.subagentId } : {}),
            ...(removedTask.estimatedMinutes
              ? { estimatedMinutes: removedTask.estimatedMinutes }
              : {}),
          });
        }
        // Recria no Google primeiro (id novo) para religar o espelho.
        let novoGcalId: string | null = null;
        if (gcalRemovido) {
          novoGcalId = await createCalendarEvent({
            title: item.title,
            date: item.date,
            startTime: item.startTime,
            endTime: item.endTime,
          }).catch(() => null);
        }
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
          ...(novoGcalId ? { gcalEventId: novoGcalId } : {}),
        });
      });
      return (
        `Item removido da agenda: "${item.title}" (${item.date} ${item.startTime}–${item.endTime})` +
        `${removedTask ? ' — o lembrete ligado foi cancelado junto' : ''}` +
        `${gcalRemovido ? ' — removido também do Google Calendar' : ''}.`
      );
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
