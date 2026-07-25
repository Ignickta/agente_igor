/** Definição de um subagente, persistida no Firebase. */
export interface Subagent {
  id: string;
  /** Nome legível, ex: "SaaS Odontológico" */
  name: string;
  /** Palavras-chave que ajudam o agente central a rotear. */
  keywords: string[];
  /** Personalidade / contexto usado como system prompt. */
  prompt: string;
  /** Se false, o subagente é ignorado no roteamento. */
  active: boolean;
  createdAt?: number;
  updatedAt?: number;
}

/** Uma mensagem de memória de conversa. */
export interface MemoryMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/** Recorrência de um lembrete: ao disparar/concluir, reagenda a próxima. */
export type Recurrence = 'diaria' | 'semanal' | 'mensal' | 'dias_uteis';

/** Tarefa / lembrete agendável. */
export interface Task {
  id: string;
  subagentId?: string;
  /** Texto do lembrete. */
  text: string;
  /** ISO date string de quando lembrar. */
  remindAt: string;
  /** false = tarefa sem prazo/lembrete definido; não dispara nem fica atrasada. */
  hasReminder?: boolean;
  /** Para quem enviar (telefone Evolution). */
  to: string;
  done: boolean;
  createdAt: number;
  /** Duração estimada em minutos (sugerida pelo LLM na criação). */
  estimatedMinutes?: number;
  /** Quando foi concluída (epoch ms), para relatórios/aprendizado. null = não. */
  completedAt?: number | null;
  /** Recorrência: o lembrete se reagenda em vez de morrer ao disparar. null = sem. */
  recurrence?: Recurrence | null;
  /** Quantas vezes foi adiado (detector de procrastinação). */
  postponedCount?: number;
  /** Epoch ms de quando o lembrete foi ENVIADO (disparou). null = ainda não. */
  firedAt?: number | null;
  /**
   * Epoch ms do último re-lembrete de turno ("ainda pendente: X"). A fila
   * sequencial re-cobra a tarefa ativa no máximo uma vez por turno
   * (manhã/tarde/noite) enquanto o Igor não confirma. null = nenhum ainda.
   */
  lastNudgeAt?: number | null;
}

/** Tipo de item da agenda. */
export type AgendaType = 'task' | 'event' | 'research';

/** Estado de um item da agenda ao longo do dia. */
export type AgendaStatus = 'pending' | 'in_progress' | 'done';

/** Quem criou o item: o usuário (fixo) ou o agente (calculado). */
export type CreatedBy = 'user' | 'agent';

/**
 * Item do cronograma diário, persistido na collection `agenda`.
 *
 * Convenção de prioridade:
 *  - priority 1  → item fixo do usuário com horário definido; NUNCA é movido
 *    pelo reorganizador.
 *  - priority 2–5 → calculada pelo agente (deadline, tipo e contexto da
 *    memória); reencaixada em volta dos itens fixos.
 */
export interface AgendaItem {
  id: string;
  title: string;
  /** Data ISO no formato YYYY-MM-DD (dia local). */
  date: string;
  /** Horário de início HH:mm. */
  startTime: string;
  /** Horário de fim HH:mm. */
  endTime: string;
  /** 1 (fixo do usuário) a 5 (menos prioritário). */
  priority: number;
  type: AgendaType;
  status: AgendaStatus;
  createdBy: CreatedBy;
  subagentId?: string;
  notes?: string;
  createdAt: number;
  /** Duração estimada em minutos (para detecção de sobrecarga e aprendizado). */
  estimatedMinutes?: number;
  /**
   * Id da Task (lembrete) que originou este item, quando aplicável. Permite
   * propagar a conclusão do item de volta para a Task (markTaskDone).
   */
  taskId?: string;
  /**
   * Epoch ms de quando o agente perguntou "você concluiu?" após o fim do slot.
   * Itens NÃO são concluídos automaticamente por horário — só com confirmação
   * do Igor; este campo garante que a pergunta seja feita uma única vez.
   * null = rearmado (ex: o lembrete de origem mudou de horário).
   */
  nudgedAt?: number | null;
  /** Epoch ms de quando o item entrou em andamento (mede duração real). */
  startedAt?: number;
  /** Quantas vezes foi empurrado para mais tarde (detector de procrastinação). */
  postponedCount?: number;
  /**
   * Epoch ms da conclusão confirmada. O par startedAt→completedAt é a duração
   * REAL da tarefa, usada para calibrar as estimativas do agente. null = não.
   */
  completedAt?: number | null;
  /**
   * Id do evento no Google Calendar quando o item é espelhado (F10). Edições
   * e remoções pelo agente propagam para o Google; o sync usa este id para
   * deduplicar e seguir mudanças feitas direto no calendário.
   */
  gcalEventId?: string;
}

/** Um item concreto que uma pergunta pendente colocou em jogo. */
export interface PendingPromptTarget {
  /** Id do item de agenda, quando o alvo veio da agenda. */
  agendaItemId?: string;
  /** Id da Task (lembrete), quando o alvo veio de um lembrete. */
  taskId?: string;
  /** Título exibido ao Igor — é por ele que a resposta em texto casa. */
  title: string;
  /** Posição na lista numerada enviada no WhatsApp (1-based). */
  index: number;
}

/**
 * Pergunta fechada em aberto, aguardando resposta do Igor. Documento único por
 * contato na collection `pending_prompts`.
 *
 * É o estado que faltava: sem ele, "sim" / "os dois primeiros" / "esse não"
 * chegavam ao roteador como mensagens soltas e eram classificadas por regex
 * sobre o texto isolado — que não tem como saber a que pergunta respondem.
 * Guardando O QUE foi perguntado e SOBRE QUAIS itens, a resposta volta a ter
 * referente e é interpretada contra ele.
 */
export interface PendingPrompt {
  /** Contato (telefone) = id do documento. */
  contact: string;
  /** Que pergunta foi feita. Hoje só a cobrança de conclusão. */
  kind: 'confirm_done';
  /** Itens efetivamente cobrados, na ordem em que foram numerados. */
  targets: PendingPromptTarget[];
  askedAt: number;
  /** Depois disso a pergunta caduca e a mensagem volta ao fluxo normal. */
  expiresAt: number;
  /**
   * Epoch ms de quando pedimos desambiguação ("todos?") por causa de um "sim"
   * genérico sobre vários itens. Só pedimos UMA vez: se a resposta seguinte
   * continuar ambígua, não insistimos — vira pergunta em loop, exatamente o
   * excesso de mensagens que faz o Igor parar de responder.
   */
  clarifiedAt?: number | null;
}

/**
 * Sessão de "modo foco": durante [startedAt, endsAt] só mensagens urgentes são
 * processadas. Documento único por contato na collection `focus`.
 */
export interface FocusSession {
  /** Contato (telefone) dono da sessão = id do documento. */
  contact: string;
  startedAt: number;
  /** Fim do foco em epoch ms. */
  endsAt: number;
  /** Se já avisamos o usuário que o foco terminou. */
  ended: boolean;
}

/**
 * Uma operação inversa serializável. É a versão declarativa do que a closure
 * `revert` do undo faria, para sobreviver a um restart do backend (a closure em
 * memória se perde; este payload no Firestore não).
 */
export type UndoOp =
  /** Recria uma task (revert de uma remoção). */
  | { kind: 'task.create'; data: Omit<Task, 'id' | 'createdAt' | 'done'> }
  /** Aplica estes campos de volta na task (revert de uma edição/conclusão). */
  | { kind: 'task.update'; id: string; data: Partial<Omit<Task, 'id' | 'createdAt'>> }
  /** Apaga a task criada (revert de uma criação). */
  | { kind: 'task.delete'; id: string }
  /** Aplica estes campos de volta num item de agenda (revert de uma conclusão/edição). */
  | { kind: 'agenda.update'; id: string; data: Partial<Omit<AgendaItem, 'id' | 'createdAt'>> }
  /** Recria um item de agenda (revert de uma remoção propagada). */
  | { kind: 'agenda.create'; data: Omit<AgendaItem, 'id' | 'createdAt'> };

/**
 * Reversão declarativa de uma ação — uma OU MAIS operações inversas aplicadas
 * em ordem. Uma ação composta (ex: concluir item de agenda + task vinculada)
 * vira várias `UndoOp`. Permite desfazer pelo painel mesmo após restart.
 */
export type PersistedUndo = UndoOp[];

/**
 * Registro de auditoria de uma escrita do agente, persistido na coleção
 * `actions`. Alimenta o feed de auditoria do painel e permite desfazer pelo
 * navegador. `undo` é a reversão declarativa; ausente = ação não-desfazível.
 */
export interface ActionRecord {
  id: string;
  /** Contato (telefone) que originou a ação. */
  contact: string;
  /** Descrição legível, ex: 'a criação do lembrete "Pagar conta"'. */
  description: string;
  /** Agrupa escritas de uma mesma mensagem do usuário. */
  group: number;
  /** Epoch ms de quando a ação ocorreu. */
  at: number;
  /** Reversão declarativa; ausente quando a ação não é desfazível pelo painel. */
  undo?: PersistedUndo;
  /** Epoch ms de quando foi desfeita pelo painel; ausente se ainda ativa. */
  undoneAt?: number;
}

/** Mensagem normalizada extraída do webhook da Evolution. */
export interface IncomingMessage {
  from: string;
  pushName?: string;
  text?: string;
  audioBase64?: string;
  audioUrl?: string;
  isAudio: boolean;
  /** Mídia além de áudio: imagem (foto/print) ou documento (PDF). */
  mediaType?: 'image' | 'document';
  mediaBase64?: string;
  mimeType?: string;
  fileName?: string;
  /** Legenda enviada junto com a mídia. */
  caption?: string;
  /**
   * Texto da mensagem CITADA quando o Igor responde/marca outra mensagem no
   * WhatsApp (extendedTextMessage.contextInfo.quotedMessage). Dá à LLM a
   * referência de "isso", "essa tarefa", "marca esse como feito".
   */
  quotedText?: string;
}
