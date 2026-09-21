/**
 * Tipos do protocolo da Alexa — só o pedaço que esta Skill usa.
 *
 * O envelope completo da Amazon é enorme e cheio de campos que não interessam
 * aqui. Declarar apenas o que se lê mantém o handler honesto: se um campo novo
 * passar a ser necessário, ele aparece como erro de tipo em vez de virar
 * `any` silencioso.
 */

export type AlexaRequestType =
  | 'LaunchRequest'
  | 'IntentRequest'
  | 'SessionEndedRequest'
  | string;

export interface AlexaSlot {
  name: string;
  value?: string;
  /** Resolução do slot quando ele tem tipo customizado com sinônimos. */
  resolutions?: {
    resolutionsPerAuthority?: Array<{
      status: { code: string };
      values?: Array<{ value: { name: string; id?: string } }>;
    }>;
  };
}

export interface AlexaIntent {
  name: string;
  slots?: Record<string, AlexaSlot>;
}

export interface AlexaRequestEnvelope {
  version: string;
  session?: {
    new: boolean;
    sessionId: string;
    attributes?: Record<string, unknown>;
    application?: { applicationId: string };
    user?: { userId: string };
  };
  context?: {
    System?: {
      application?: { applicationId: string };
      user?: { userId: string };
    };
  };
  request: {
    type: AlexaRequestType;
    requestId: string;
    timestamp: string;
    locale?: string;
    intent?: AlexaIntent;
    /** Presente em SessionEndedRequest. */
    reason?: string;
    error?: { type: string; message: string };
  };
}

export interface AlexaResponseEnvelope {
  version: '1.0';
  sessionAttributes?: Record<string, unknown>;
  response: {
    outputSpeech?: { type: 'PlainText'; text: string };
    reprompt?: { outputSpeech: { type: 'PlainText'; text: string } };
    shouldEndSession: boolean;
  };
}

/** O que a sessão guarda entre uma fala e a próxima. */
export interface AlexaSessionState {
  /** Ação aguardando "sim"/"não", com o que exatamente será feito. */
  pending?: PendingConfirmation;
  /** Candidatos lidos em voz alta, na ordem, esperando escolha. */
  candidates?: Array<{ id: string; label: string }>;
  /** Epoch ms de quando a pendência foi criada (para expirar). */
  at?: number;
}

export type PendingConfirmation =
  | {
      kind: 'create';
      title: string;
      date: string;
      startTime: string;
      endTime: string;
      /** Já avisou do conflito e está pedindo a segunda confirmação. */
      conflictAcknowledged?: boolean;
    }
  | {
      kind: 'reschedule';
      id: string;
      title: string;
      date: string;
      startTime: string;
      endTime: string;
      conflictAcknowledged?: boolean;
    }
  | { kind: 'cancel'; id: string; title: string; date: string; startTime: string };
