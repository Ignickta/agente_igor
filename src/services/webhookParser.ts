import { IncomingMessage } from '../types';
import { getBase64FromMediaMessage, normalizeNumber } from './evolution';

/**
 * Normaliza o payload de webhook da Evolution API (evento messages.upsert)
 * para a nossa estrutura interna. Ignora mensagens enviadas por nós (fromMe).
 *
 * A Evolution pode enviar `data` como objeto único ou array; tratamos o primeiro.
 */
export async function parseWebhook(body: any): Promise<IncomingMessage | null> {
  const event: string | undefined = body?.event;
  if (event && event !== 'messages.upsert') return null;

  const data = Array.isArray(body?.data) ? body.data[0] : body?.data;
  if (!data) return null;

  const key = data.key || {};
  if (key.fromMe) return null; // ignora ecos das nossas próprias mensagens

  const from = normalizeNumber(key.remoteJid || '');
  if (!from) return null;

  const message = data.message || {};
  const pushName = data.pushName;

  // Texto simples ou estendido
  const text: string | undefined =
    message.conversation || message.extendedTextMessage?.text;

  // Áudio (ptt ou audioMessage)
  const audio = message.audioMessage;
  if (audio) {
    let audioBase64 = data.base64 || message.base64 || '';
    // Se o webhook não trouxe base64, busca pela API
    if (!audioBase64) {
      try {
        audioBase64 = await getBase64FromMediaMessage({ key, message });
      } catch (err) {
        console.error('[webhookParser] falha ao baixar áudio:', err);
      }
    }
    return {
      from,
      pushName,
      isAudio: true,
      audioBase64,
    };
  }

  if (text) {
    return { from, pushName, text, isAudio: false };
  }

  return null;
}
