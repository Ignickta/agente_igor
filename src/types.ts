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
}

/** Mensagem normalizada extraída do webhook da Evolution. */
export interface IncomingMessage {
  from: string;
  pushName?: string;
  text?: string;
  audioBase64?: string;
  audioUrl?: string;
  isAudio: boolean;
}
