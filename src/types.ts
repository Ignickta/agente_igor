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
   */
  nudgedAt?: number;
  /** Epoch ms de quando o item entrou em andamento (mede duração real). */
  startedAt?: number;
  /** Quantas vezes foi empurrado para mais tarde (detector de procrastinação). */
  postponedCount?: number;
  /**
   * Epoch ms da conclusão confirmada. O par startedAt→completedAt é a duração
   * REAL da tarefa, usada para calibrar as estimativas do agente. null = não.
   */
  completedAt?: number | null;
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
}
