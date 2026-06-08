import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import { config } from '../config';

const openai = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Transcreve um áudio (em base64) usando o Whisper da OpenAI.
 * O áudio do WhatsApp costuma vir como ogg/opus.
 */
export async function transcribeAudioBase64(
  base64: string,
  filename = 'audio.ogg'
): Promise<string> {
  if (!base64) {
    throw new Error('Áudio vazio: nada para transcrever.');
  }

  // Remove prefixo data URI se existir (ex: "data:audio/ogg;base64,....")
  const clean = base64.replace(/^data:.*;base64,/, '');
  const buffer = Buffer.from(clean, 'base64');

  if (buffer.length === 0) {
    throw new Error('Áudio decodificado vazio (base64 inválido).');
  }

  // O WhatsApp manda PTT em OGG/Opus. O Whisper aceita ogg; o content-type
  // é derivado da extensão do filename para casar com o áudio recebido.
  const ext = filename.split('.').pop()?.toLowerCase() || 'ogg';
  const mimeByExt: Record<string, string> = {
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/ogg',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    mp4: 'audio/mp4',
    wav: 'audio/wav',
    webm: 'audio/webm',
  };
  const file = await toFile(buffer, filename, {
    type: mimeByExt[ext] || 'audio/ogg',
  });

  const result = await openai.audio.transcriptions.create({
    file,
    model: config.openai.transcriptionModel,
    language: 'pt',
  });

  return result.text.trim();
}
