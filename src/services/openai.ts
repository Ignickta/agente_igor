import OpenAI from 'openai';
import { config } from '../config';

export const openai = new OpenAI({ apiKey: config.openai.apiKey });

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** Chamada de chat completion simples retornando o texto. */
export async function chat(
  messages: ChatMessage[],
  options: { temperature?: number; model?: string } = {}
): Promise<string> {
  const completion = await openai.chat.completions.create({
    model: options.model || config.openai.model,
    temperature: options.temperature ?? 0.7,
    messages,
  });
  return completion.choices[0]?.message?.content?.trim() || '';
}
