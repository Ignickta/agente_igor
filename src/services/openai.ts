import OpenAI from 'openai';
import { config } from '../config';

export const openai = new OpenAI({ apiKey: config.openai.apiKey });

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * Modelos de raciocínio (gpt-5*, o3/o4...) só aceitam a temperature padrão —
 * enviar outro valor dá erro 400. As variantes "-chat" continuam aceitando.
 */
export function supportsCustomTemperature(model: string): boolean {
  if (/^o\d/.test(model)) return false;
  if (model.startsWith('gpt-5') && !model.includes('chat')) return false;
  return true;
}

/** Embedding de um texto, para a memória semântica compartilhada. */
export async function embed(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: config.openai.embeddingModel,
    input: text.slice(0, 8000),
  });
  return res.data[0]?.embedding ?? [];
}

/** Chamada de chat completion simples retornando o texto. */
export async function chat(
  messages: ChatMessage[],
  options: { temperature?: number; model?: string } = {}
): Promise<string> {
  const model = options.model || config.openai.model;
  const completion = await openai.chat.completions.create({
    model,
    ...(supportsCustomTemperature(model)
      ? { temperature: options.temperature ?? 0.7 }
      : {}),
    messages,
  });
  return completion.choices[0]?.message?.content?.trim() || '';
}
