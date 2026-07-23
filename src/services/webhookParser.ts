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

  // Mensagem CITADA (o Igor respondeu marcando outra): o texto do que ele citou
  // fica em contextInfo.quotedMessage, não no texto que ele digitou. Sem isso,
  // "marca esse como feito" citando um item não tem a que se referir. Extrai o
  // texto da citação (vários formatos possíveis) para anexar como contexto.
  const quoted = message.extendedTextMessage?.contextInfo?.quotedMessage;
  const quotedText: string | undefined = quoted
    ? (
        quoted.conversation ||
        quoted.extendedTextMessage?.text ||
        quoted.imageMessage?.caption ||
        quoted.videoMessage?.caption ||
        quoted.documentMessage?.caption ||
        undefined
      )?.slice(0, 800)
    : undefined;

  // Áudio: audioMessage (inclui PTT/voz). O base64 pode vir embutido no webhook
  // em vários lugares dependendo da config da instância, ou precisa ser baixado.
  const audio = message.audioMessage;
  if (audio) {
    let audioBase64: string =
      data.base64 ||
      message.base64 ||
      audio.base64 ||
      data.message?.base64 ||
      '';

    // Se o webhook não trouxe base64, busca pela API passando a mensagem COMPLETA.
    if (!audioBase64) {
      console.log('[webhookParser] áudio sem base64 no webhook, baixando via API...');
      audioBase64 = await getBase64FromMediaMessage(data);
    }

    if (!audioBase64) {
      console.error('[webhookParser] não foi possível obter o base64 do áudio');
    }

    return {
      from,
      pushName,
      isAudio: true,
      audioBase64,
    };
  }

  // Imagem (foto, print): o conteúdo é extraído depois via modelo de visão.
  const image = message.imageMessage;
  if (image) {
    let mediaBase64: string = data.base64 || message.base64 || image.base64 || '';
    if (!mediaBase64) {
      console.log('[webhookParser] imagem sem base64 no webhook, baixando via API...');
      mediaBase64 = await getBase64FromMediaMessage(data);
    }
    return {
      from,
      pushName,
      isAudio: false,
      mediaType: 'image',
      mediaBase64,
      mimeType: image.mimetype || 'image/jpeg',
      caption: image.caption || '',
    };
  }

  // Documento (PDF e afins) — pode vir embrulhado em documentWithCaptionMessage.
  const doc =
    message.documentMessage ||
    message.documentWithCaptionMessage?.message?.documentMessage;
  if (doc) {
    let mediaBase64: string = data.base64 || message.base64 || doc.base64 || '';
    if (!mediaBase64) {
      console.log('[webhookParser] documento sem base64 no webhook, baixando via API...');
      mediaBase64 = await getBase64FromMediaMessage(data);
    }
    return {
      from,
      pushName,
      isAudio: false,
      mediaType: 'document',
      mediaBase64,
      mimeType: doc.mimetype || 'application/pdf',
      fileName: doc.fileName || 'documento.pdf',
      caption: doc.caption || '',
    };
  }

  if (text) {
    return { from, pushName, text, isAudio: false, ...(quotedText ? { quotedText } : {}) };
  }

  return null;
}
