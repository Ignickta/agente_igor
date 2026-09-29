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
  const number = normalizeRecipient(to);
  if (process.env.DISABLE_WHATSAPP === '1') {
    console.log(`[dry-run] sendText → ${number}: ${text.slice(0, 80)}`);
    return;
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      // `delay` faz a Evolution exibir "digitando..." pelo tempo informado
      // antes de entregar a mensagem — feedback natural sem endpoint extra.
      await client.post(`/message/sendText/${config.evolution.instance}`, {
        number,
        text,
        ...(delayMs > 0 ? { delay: delayMs } : {}),
      });
      return;
    } catch (err) {
      logAxiosError('sendText', err);
      const wait = SEND_RETRY_DELAYS_MS[attempt];
      if (wait === undefined || !isEvolutionUnreachable(err)) throw err;
      console.warn(
        `[evolution:sendText] WhatsApp fora do ar; nova tentativa ${attempt + 2} em ${wait / 1000}s → ${number}`
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/**
 * Esperas entre tentativas quando a Evolution está fora do ar (~8 min no
 * total). Em 2026-09-29 a VPS reiniciou e a resposta a um lead se perdeu
 * porque a Evolution ainda estava subindo e devolveu 502.
 */
const SEND_RETRY_DELAYS_MS = [15_000, 45_000, 120_000, 300_000];

/**
 * Só repete quando a mensagem com certeza NÃO saiu: proxy sem destino
 * (502/503) ou conexão recusada. Timeout fica de fora — a mensagem pode ter
 * sido entregue e repetir duplicaria no WhatsApp do contato.
 */
function isEvolutionUnreachable(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const status = err.response?.status;
  if (status === 502 || status === 503) return true;
  return !err.response && (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND');
}

/**
 * Envia um áudio (PTT/voz) a partir de um base64.
 * Usado para responder em áudio (TTS).
 */
export async function sendAudio(to: string, audioBase64: string): Promise<void> {
  const number = normalizeNumber(to);
  if (process.env.DISABLE_WHATSAPP === '1') {
    console.log(`[dry-run] sendAudio → ${number}`);
    return;
  }
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

/**
 * Consulta o estado da conexão da instância.
 * Retorna o estado bruto (ex: 'open', 'connecting', 'close') ou null se falhar.
 * Na Evolution v2 o estado costuma vir em data.instance.state.
 */
export async function getConnectionState(): Promise<string | null> {
  try {
    const { data } = await client.get(
      `/instance/connectionState/${config.evolution.instance}`
    );
    return data?.instance?.state || data?.state || null;
  } catch (err) {
    logAxiosError('getConnectionState', err);
    return null;
  }
}

/** Dispara a (re)conexão da instância (gera novo pareamento se necessário). */
export async function connectInstance(): Promise<boolean> {
  try {
    await client.get(`/instance/connect/${config.evolution.instance}`);
    return true;
  } catch (err) {
    logAxiosError('connectInstance', err);
    return false;
  }
}

/**
 * Verifica a conexão e, se não estiver conectada ('open'), tenta reconectar.
 * Pensada para rodar periodicamente (node-cron). Loga o status.
 */
export async function ensureConnected(): Promise<void> {
  const state = await getConnectionState();

  if (state === 'open') {
    console.log('[evolution] conexão OK (open).');
    return;
  }

  if (state === null) {
    console.warn('[evolution] não foi possível obter o estado da conexão.');
    return;
  }

  console.warn(`[evolution] instância desconectada (estado: ${state}). Tentando reconectar...`);
  const ok = await connectInstance();
  if (ok) {
    const after = await getConnectionState();
    console.log(
      `[evolution] reconexão disparada. Novo estado: ${after ?? 'desconhecido'}` +
        (after !== 'open'
          ? ' (pode exigir leitura de QR Code se a sessão expirou).'
          : '.')
    );
  } else {
    console.error('[evolution] falha ao disparar a reconexão.');
  }
}

/** Remove sufixos do JID (@s.whatsapp.net) e caracteres não numéricos. */
export function normalizeNumber(jidOrNumber: string): string {
  return jidOrNumber.split('@')[0].replace(/\D/g, '');
}

/**
 * Normaliza um destinatário sem destruir JIDs de grupos do WhatsApp.
 * Telefones continuam sendo enviados somente com dígitos, como antes.
 */
export function normalizeRecipient(jidOrNumber: string): string {
  const value = jidOrNumber.trim();
  if (/^\d+(?:-\d+)?@g\.us$/.test(value)) return value;
  return normalizeNumber(value);
}

/**
 * Gera o link oficial para abrir uma conversa no WhatsApp.
 *
 * Alguns JIDs brasileiros ainda chegam com o celular no formato legado de
 * oito dígitos. Para o link externo funcionar, restaura o 9º dígito quando o
 * assinante começa entre 6 e 9. O JID original continua sendo usado internamente
 * para responder à conversa existente.
 */
export function whatsappChatUrl(jidOrNumber: string): string {
  const normalized = normalizeNumber(jidOrNumber);
  const needsBrazilianNinthDigit =
    /^55\d{10}$/.test(normalized) && /^[6-9]$/.test(normalized.charAt(4));
  const linkNumber = needsBrazilianNinthDigit
    ? `${normalized.slice(0, 4)}9${normalized.slice(4)}`
    : normalized;
  return `https://wa.me/${linkNumber}`;
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
