import { AlexaRequestEnvelope, AlexaResponseEnvelope } from './types';
import { ask, tell, silent, SPEECH } from './responses';
import { consultarAgenda, proximosCompromissos } from './intents';

/**
 * Despachante dos pedidos da Alexa.
 *
 * Recebe o envelope JÁ autenticado e devolve o que falar. Tudo o que este
 * arquivo faz tem de caber no orçamento de poucos segundos da Alexa: nada de
 * LLM, nada de chamada externa.
 *
 * Por enquanto só lê a agenda. Nenhum intent aqui escreve nada, o que deixa
 * conferir autenticação, diálogo e consulta no dispositivo real antes de
 * existir qualquer operação capaz de estragar a agenda.
 */
export async function handleAlexaRequest(
  envelope: AlexaRequestEnvelope
): Promise<AlexaResponseEnvelope> {
  const { request } = envelope;

  if (request.type === 'LaunchRequest') {
    return ask(SPEECH.welcome, SPEECH.welcomeReprompt);
  }

  if (request.type === 'SessionEndedRequest') {
    // A Amazon encerrou a sessão (silêncio, "para", ou erro). Nada a falar:
    // responder com fala aqui é erro de protocolo.
    if (request.error) {
      console.error(`[alexa] sessão encerrada com erro: ${request.error.type} ${request.error.message}`);
    }
    return silent();
  }

  if (request.type === 'IntentRequest') {
    const intent = request.intent?.name ?? '';

    switch (intent) {
      case 'ConsultarAgendaIntent':
        return await consultarAgenda(request.intent);

      case 'ProximosCompromissosIntent':
        return await proximosCompromissos();

      case 'AMAZON.HelpIntent':
        return ask(SPEECH.help, SPEECH.helpReprompt);

      case 'AMAZON.StopIntent':
      case 'AMAZON.CancelIntent':
        return tell(SPEECH.goodbye);

      case 'AMAZON.FallbackIntent':
        return ask(SPEECH.notUnderstood, SPEECH.notUnderstoodReprompt);

      default:
        // Criar, remarcar e cancelar entram na fase seguinte.
        return ask(
          'Ainda não sei fazer isso. Por enquanto eu consigo consultar sua agenda.',
          SPEECH.notUnderstoodReprompt
        );
    }
  }

  console.warn(`[alexa] tipo de requisição não suportado: ${request.type}`);
  return tell('Não consigo tratar esse tipo de pedido.');
}
