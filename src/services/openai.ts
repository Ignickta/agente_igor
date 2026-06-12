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

/**
 * Chamada de chat com Structured Outputs (json_schema estrito): o modelo é
 * OBRIGADO a devolver JSON no formato do schema — elimina a classe de bug
 * "respondeu com texto em volta do JSON e o parse falhou silenciosamente".
 *
 * O schema segue as regras do modo estrito da OpenAI: raiz `object`, todo campo
 * em `required`, `additionalProperties: false` (campos opcionais = união com
 * null). Retorna null se o modelo recusar ou se tudo falhar — o caller trata
 * null como "sem plano utilizável", igual fazia com o parse leniente.
 *
 * Resiliência: se a API rejeitar o response_format (ex: OPENAI_MODEL trocado
 * por um modelo sem suporte), refaz a chamada sem schema e parseia o objeto
 * de forma leniente — comportamento antigo como rede de segurança.
 */
export async function chatJson<T>(
  messages: ChatMessage[],
  options: {
    /** Nome do schema (identificador exigido pela API, ex: "cronograma"). */
    name: string;
    schema: Record<string, unknown>;
    model?: string;
    temperature?: number;
  }
): Promise<T | null> {
  const model = options.model || config.openai.model;
  const temp = supportsCustomTemperature(model)
    ? { temperature: options.temperature ?? 0 }
    : {};
  try {
    const completion = await openai.chat.completions.create({
      model,
      ...temp,
      messages,
      response_format: {
        type: 'json_schema',
        json_schema: { name: options.name, strict: true, schema: options.schema },
      },
    });
    const msg = completion.choices[0]?.message;
    if (msg?.refusal || !msg?.content) return null;
    return JSON.parse(msg.content) as T;
  } catch (err) {
    console.error(
      `[openai] chatJson(${options.name}) com schema falhou; tentando sem schema:`,
      err instanceof Error ? err.message : err
    );
    try {
      const completion = await openai.chat.completions.create({ model, ...temp, messages });
      const raw = completion.choices[0]?.message?.content || '';
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start === -1 || end === -1) return null;
      return JSON.parse(raw.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
}
