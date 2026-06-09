import { openai, chat, ChatMessage } from '../services/openai';
import { config } from '../config';

/**
 * Modo de uso da pesquisa:
 *  - 'direct'   → resposta pronta para o WhatsApp (resumo + bullets + fontes).
 *                 Usada quando o Igor (ou o orquestrador) pede uma pesquisa.
 *  - 'findings' → fatos crus com fontes, material de APOIO para outro subagente
 *                 incorporar à própria resposta. Não é formatado para o usuário.
 */
export type ResearchMode = 'direct' | 'findings';

const DIRECT_INSTRUCTIONS = `Você é o agente de pesquisa do Igor. Pesquise na web e responda em
português do Brasil, de forma objetiva e formatada para WhatsApp:
- Comece com um resumo curto (1–2 linhas).
- Use bullets com os pontos principais.
- Ao final, liste as fontes (títulos/links) que embasaram a resposta.
Seja factual; se a web não trouxer dados confiáveis, diga isso.`;

const FINDINGS_INSTRUCTIONS = `Você é um pesquisador de apoio. Pesquise na web e devolva
APENAS os fatos relevantes em português, de forma enxuta, para que OUTRO assistente use como
fonte ao redigir a resposta final. NÃO escreva uma resposta ao usuário, não use saudações nem
formatação de conversa. Liste:
- Fatos/dados objetivos em bullets (com números, datas, versões quando houver).
- "Fontes:" com os títulos/links no final.
Se a web não trouxer dados confiáveis, diga isso claramente em uma linha.`;

/**
 * Sub-agente de pesquisa. Recebe uma pergunta/tema e busca na web usando a
 * Responses API da OpenAI com a tool nativa `web_search_preview` (sem chave
 * externa).
 *
 * Robustez: se a Responses API / web search falhar (modelo incompatível, erro
 * de rede), cai para uma resposta sem web via `chat()`, avisando a limitação —
 * mesmo padrão de degradação suave usado no resto do projeto.
 *
 * @param mode 'direct' (resposta pronta) ou 'findings' (material de apoio).
 */
export async function research(question: string, mode: ResearchMode = 'direct'): Promise<string> {
  const tema = question.trim();
  if (!tema) return 'Sobre o que você quer que eu pesquise? 🙂';

  const instructions = mode === 'findings' ? FINDINGS_INSTRUCTIONS : DIRECT_INSTRUCTIONS;

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
  const fallbackSystem =
    mode === 'findings'
      ? 'Você é um pesquisador de apoio, mas NÃO conseguiu acessar a web agora. Liste em bullets, ' +
        'em português, o que você sabe sobre o tema a partir do seu conhecimento (pode estar ' +
        'desatualizado — sinalize isso). Não escreva uma resposta ao usuário; é material de apoio.'
      : 'Você é o agente de pesquisa do Igor. Responda em português do Brasil, conciso e ' +
        'formatado para WhatsApp (resumo + bullets). IMPORTANTE: você não conseguiu acessar a ' +
        'web agora, então avise que a resposta é baseada no seu conhecimento e pode estar ' +
        'desatualizada.';
  const messages: ChatMessage[] = [
    { role: 'system', content: fallbackSystem },
    { role: 'user', content: tema },
  ];
  const fallback = await chat(messages, { temperature: 0.4 });
  return fallback || 'Não consegui pesquisar isso agora. Tenta de novo em instantes? 🙏';
}
