import { openai } from './openai';
import { config } from '../config';

/**
 * Gera áudio (TTS) a partir de um texto usando a OpenAI.
 * Retorna o áudio em base64, pronto para envio via Evolution.
 *
 * Usado quando o usuário pede explicitamente uma resposta em áudio
 * (ex: "responde em áudio"); por padrão o agente responde por texto.
 */
export async function textToSpeechBase64(text: string): Promise<string> {
  const clean = text.trim();
  if (!clean) throw new Error('Texto vazio para TTS.');

  // Limita o tamanho para controlar custo/latência (TTS é cobrado por caractere).
  const input = clean.length > 800 ? clean.slice(0, 800) + '…' : clean;

  const response = await openai.audio.speech.create({
    model: config.openai.ttsModel,
    voice: config.openai.ttsVoice,
    input,
    response_format: 'opus', // compatível com áudio do WhatsApp (ogg/opus)
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString('base64');
}
