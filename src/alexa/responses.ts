import { AlexaResponseEnvelope, AlexaSessionState } from './types';

/**
 * Montagem das respostas faladas.
 *
 * Voz não é WhatsApp: quem ouve não pode reler, não vê emoji e não aguenta
 * lista longa. Toda resposta daqui é curta e termina de um jeito que deixa
 * claro se a Alexa está esperando algo ou não.
 */

/** Mantém a sessão aberta e espera o Igor falar. */
export function ask(
  speech: string,
  reprompt: string,
  attributes?: AlexaSessionState
): AlexaResponseEnvelope {
  return {
    version: '1.0',
    ...(attributes ? { sessionAttributes: attributes as Record<string, unknown> } : {}),
    response: {
      outputSpeech: { type: 'PlainText', text: speech },
      reprompt: { outputSpeech: { type: 'PlainText', text: reprompt } },
      shouldEndSession: false,
    },
  };
}

/** Fala e encerra a sessão. */
export function tell(speech: string): AlexaResponseEnvelope {
  return {
    version: '1.0',
    response: {
      outputSpeech: { type: 'PlainText', text: speech },
      shouldEndSession: true,
    },
  };
}

export const SPEECH = {
  welcome: 'Olá, Igor. O que você quer fazer com sua agenda?',
  welcomeReprompt: 'Você pode perguntar o que tem hoje, ou pedir para marcar um compromisso.',
  help:
    'Eu cuido da sua agenda. Você pode perguntar o que tem hoje ou amanhã, ' +
    'pedir para marcar um compromisso, remarcar ou cancelar. O que você quer fazer?',
  helpReprompt: 'Por exemplo: o que eu tenho amanhã?',
  goodbye: 'Até mais.',
  nothingChanged: 'Tudo bem. Nada foi alterado.',
  notUnderstood: 'Não entendi. Você pode perguntar o que tem hoje, ou pedir para marcar algo.',
  notUnderstoodReprompt: 'O que você quer fazer com sua agenda?',
  expired: 'A confirmação expirou. Faça o pedido novamente.',
  nothingPending: 'Não há nada esperando confirmação.',
  genericError: 'Não consegui acessar sua agenda agora. Nada foi alterado.',
} as const;
