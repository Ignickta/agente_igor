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
export async function sendText(to: string, text: string): Promise<void> {
  const number = normalizeNumber(to);
  try {
    await client.post(`/message/sendText/${config.evolution.instance}`, {
      number,
      text,
    });
  } catch (err) {
    logAxiosError('sendText', err);
    throw err;
  }
}

/**
 * Baixa a mídia (áudio) de uma mensagem em base64 a partir da Evolution API.
 * Usado quando o webhook não traz o áudio embutido.
 */
export async function getBase64FromMediaMessage(messageKey: unknown): Promise<string> {
  const { data } = await client.post(
    `/chat/getBase64FromMediaMessage/${config.evolution.instance}`,
    { message: messageKey }
  );
  return data?.base64 || data?.media || '';
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
