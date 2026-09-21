import { IncomingHttpHeaders } from 'http';
import { SkillRequestSignatureVerifier, TimestampVerifier } from 'ask-sdk-express-adapter';
import { config } from '../config';
import { AlexaRequestEnvelope } from './types';

/**
 * Porteiro da rota da Alexa.
 *
 * A rota é pública na internet: qualquer um pode chegar nela. O que garante
 * que a requisição é legítima são quatro checagens independentes, em ordem do
 * mais barato para o mais caro:
 *
 * 1. a integração está ligada;
 * 2. o corpo é um envelope da Alexa reconhecível;
 * 3. a requisição é para ESTA Skill e de uma conta autorizada;
 * 4. a assinatura e o horário conferem com o certificado da Amazon.
 *
 * A assinatura fica por último porque é a única que faz rede (baixa e valida a
 * cadeia de certificados). Recusar antes disso o que já dá para recusar evita
 * transformar a rota num jeito barato de fazer o servidor trabalhar à toa.
 */

const signatureVerifier = new SkillRequestSignatureVerifier();
/** Tolerância do carimbo de tempo: a Amazon recomenda 150 segundos. */
const timestampVerifier = new TimestampVerifier(150000);

export type RejectionReason =
  | 'disabled'
  | 'malformed_body'
  | 'invalid_skill_id'
  | 'unauthorized_user'
  | 'owner_not_configured'
  | 'invalid_signature'
  | 'stale_timestamp';

export type AuthResult =
  | { ok: true; envelope: AlexaRequestEnvelope; userId: string }
  | { ok: false; reason: RejectionReason; detail?: string };

/**
 * Mostra só as pontas do identificador nos logs.
 *
 * O ID da conta Amazon é longo e é o que autoriza a mexer na agenda. Mascarar
 * mantém o log útil para conferir "é a mesma conta de sempre?" sem deixar o
 * identificador inteiro espalhado pelo histórico do container.
 */
export function maskUserId(userId: string): string {
  if (!userId) return '(vazio)';
  if (userId.length <= 14) return `${userId.slice(0, 4)}…`;
  return `${userId.slice(0, 10)}…${userId.slice(-4)}`;
}

/** Aplica todas as checagens sobre o corpo BRUTO recebido. */
export async function authenticate(
  rawBody: string,
  headers: IncomingHttpHeaders
): Promise<AuthResult> {
  if (!config.alexa.enabled) return { ok: false, reason: 'disabled' };

  let envelope: AlexaRequestEnvelope;
  try {
    envelope = JSON.parse(rawBody) as AlexaRequestEnvelope;
  } catch {
    return { ok: false, reason: 'malformed_body' };
  }
  if (!envelope?.request?.type || !envelope.request.requestId) {
    return { ok: false, reason: 'malformed_body' };
  }

  const applicationId =
    envelope.context?.System?.application?.applicationId ??
    envelope.session?.application?.applicationId ??
    '';
  if (!config.alexa.skillId || applicationId !== config.alexa.skillId) {
    return { ok: false, reason: 'invalid_skill_id' };
  }

  const userId = envelope.context?.System?.user?.userId ?? envelope.session?.user?.userId ?? '';

  // Captura única do ID autorizado. É o ÚNICO ponto do sistema que registra o
  // identificador inteiro, e só quando explicitamente pedido.
  if (config.alexa.captureUserId) {
    console.warn(
      `[alexa] CAPTURA DE ID LIGADA — userId completo: ${userId}\n` +
        '[alexa] copie para ALEXA_ALLOWED_USER_ID e desligue ALEXA_CAPTURE_USER_ID.'
    );
  }

  if (!config.alexa.allowedUserId) return { ok: false, reason: 'owner_not_configured' };
  if (userId !== config.alexa.allowedUserId) return { ok: false, reason: 'unauthorized_user' };

  if (!config.alexa.skipSignature) {
    try {
      await timestampVerifier.verify(rawBody);
    } catch (err) {
      return { ok: false, reason: 'stale_timestamp', detail: String(err) };
    }
    try {
      await signatureVerifier.verify(rawBody, headers);
    } catch (err) {
      return { ok: false, reason: 'invalid_signature', detail: String(err) };
    }
  }

  return { ok: true, envelope, userId };
}

/**
 * Frase falada para cada recusa.
 *
 * Cada motivo tem texto próprio de propósito: quando a Skill parar de
 * funcionar, a frase que a Alexa disser já diz onde olhar — em especial a
 * conta não autorizada, que é o que acontece quando o ID muda depois de
 * reinstalar a Skill.
 */
export function rejectionSpeech(reason: RejectionReason): string {
  switch (reason) {
    case 'disabled':
      return 'A integração com a agenda está desligada no momento.';
    case 'owner_not_configured':
      return 'A conta autorizada ainda não foi configurada no servidor.';
    case 'unauthorized_user':
      return 'Esta skill não está autorizada para esta conta.';
    case 'invalid_skill_id':
      return 'Esta requisição não é desta skill.';
    default:
      return 'Não consegui validar esta requisição.';
  }
}
