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
  // Remove prefixo data URI se existir
  const clean = base64.replace(/^data:.*;base64,/, '');
  const buffer = Buffer.from(clean, 'base64');

  const file = await toFile(buffer, filename);

  const result = await openai.audio.transcriptions.create({
    file,
    model: config.openai.transcriptionModel,
  });

  return result.text.trim();
}
