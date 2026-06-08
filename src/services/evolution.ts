import axios from 'axios';
import { config } from '../config';

const client = axios.create({
  baseURL: config.evolution.apiUrl,
  headers: {
    apikey: config.evolution.apiKey,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

/**
 * Envia uma mensagem de texto via Evolution API.
 * @param to número no formato internacional sem símbolos, ex: 5511999999999
 */
export async function sendText(
  to: string,
  text: string,
  delayMs = 0
): Promise<void> {
  const number = normalizeNumber(to);
  try {
    // `delay` faz a Evolution exibir "digitando..." pelo tempo informado
    // antes de entregar a mensagem — feedback natural sem endpoint extra.
    await client.post(`/message/sendText/${config.evolution.instance}`, {
      number,
      text,
      ...(delayMs > 0 ? { delay: delayMs } : {}),
    });
  } catch (err) {
    logAxiosError('sendText', err);
    throw err;
  }
}

/**
 * Envia um áudio (PTT/voz) a partir de um base64.
 * Usado para responder em áudio (TTS).
 */
export async function sendAudio(to: string, audioBase64: string): Promise<void> {
  const number = normalizeNumber(to);
  try {
    await client.post(`/message/sendWhatsAppAudio/${config.evolution.instance}`, {
      number,
      audio: audioBase64,
    });
  } catch (err) {
    logAxiosError('sendAudio', err);
    throw err;
  }
}

/**
 * Baixa a mídia (áudio) de uma mensagem em base64 a partir da Evolution API.
 *
 * Na Evolution v2 o endpoint espera o objeto COMPLETO da mensagem
 * (com `key` e `message`) dentro de `{ message: <objeto> }`. Algumas versões
 * exigem `key.id`. Retorna o base64 puro (sem prefixo data URI).
 *
 * @param fullMessage objeto { key, message, ... } vindo do webhook (data)
 */
export async function getBase64FromMediaMessage(
  fullMessage: unknown
): Promise<string> {
  try {
    const { data } = await client.post(
      `/chat/getBase64FromMediaMessage/${config.evolution.instance}`,
      { message: fullMessage, convertToMp4: false }
    );
    // A Evolution pode responder em diferentes chaves dependendo da versão.
    const base64 =
      data?.base64 || data?.media || data?.buffer || data?.data || '';
    if (!base64) {
      console.error(
        '[evolution:getBase64] resposta sem base64:',
        JSON.stringify(data).slice(0, 300)
      );
    }
    return base64;
  } catch (err) {
    logAxiosError('getBase64FromMediaMessage', err);
    return '';
  }
}

/** Remove sufixos do JID (@s.whatsapp.net) e caracteres não numéricos. */
export function normalizeNumber(jidOrNumber: string): string {
  return jidOrNumber.split('@')[0].replace(/\D/g, '');
}

function logAxiosError(context: string, err: unknown): void {
  if (axios.isAxiosError(err)) {
    console.error(
      `[evolution:${context}]`,
      err.response?.status,
      JSON.stringify(err.response?.data) || err.message
    );
  } else {
    console.error(`[evolution:${context}]`, err);
  }
}
