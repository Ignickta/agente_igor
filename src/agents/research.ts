import { openai, chat, ChatMessage } from '../services/openai';
import { config } from '../config';

/**
 * Sub-agente de pesquisa. Recebe uma pergunta/tema e responde com base em busca
 * na web, usando a Responses API da OpenAI com a tool nativa `web_search_preview`
 * (não exige chave externa). Formata o resultado para o WhatsApp.
 *
 * Robustez: se a Responses API / web search falhar (modelo incompatível, erro
 * de rede), cai para uma resposta sem web via `chat()`, avisando a limitação —
 * mesmo padrão de degradação suave usado no resto do projeto.
 */
export async function research(question: string): Promise<string> {
  const tema = question.trim();
  if (!tema) return 'Sobre o que você quer que eu pesquise? 🙂';

  const instructions = `Você é o agente de pesquisa do Igor. Pesquise na web e responda em
português do Brasil, de forma objetiva e formatada para WhatsApp:
- Comece com um resumo curto (1–2 linhas).
- Use bullets com os pontos principais.
- Ao final, liste as fontes (títulos/links) que embasaram a resposta.
Seja factual; se a web não trouxer dados confiáveis, diga isso.`;

  try {
    const response = await openai.responses.create({
      model: config.openai.researchModel,
      tools: [{ type: 'web_search_preview' }],
      instructions,
      input: tema,
    });

    const text = response.output_text?.trim();
    if (text) return text;
    console.warn('[research] resposta sem output_text, usando fallback sem web.');
  } catch (err) {
    console.error(
      '[research] web search falhou, usando fallback sem web:',
      err instanceof Error ? err.message : err
    );
  }

  // Fallback: conhecimento do modelo, sem acesso à web.
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'Você é o agente de pesquisa do Igor. Responda em português do Brasil, conciso e ' +
        'formatado para WhatsApp (resumo + bullets). IMPORTANTE: você não conseguiu acessar a ' +
        'web agora, então avise que a resposta é baseada no seu conhecimento e pode estar ' +
        'desatualizada.',
    },
    { role: 'user', content: tema },
  ];
  const fallback = await chat(messages, { temperature: 0.4 });
  return fallback || 'Não consegui pesquisar isso agora. Tenta de novo em instantes? 🙏';
}
