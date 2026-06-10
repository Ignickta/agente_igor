import { openai } from './openai';
import { config } from '../config';

/**
 * Leitura de mídias recebidas pelo WhatsApp (imagens e PDFs): extrai o conteúdo
 * com o modelo de visão e devolve texto, que entra no fluxo normal do agente
 * como contexto da mensagem. Foto de boleto vira dados de pagamento; print de
 * pedido vira itens e valores.
 */

const EXTRACT_PROMPT = `Extraia desta mídia TODO o conteúdo útil, em português do Brasil:
- todo texto visível (OCR fiel);
- se for boleto/fatura/cobrança: valor, vencimento, beneficiário e linha digitável se legível;
- se for comprovante: valor, data, pagador e recebedor;
- se for print de conversa ou pedido: itens, quantidades, valores e quem pediu;
- caso geral: descreva objetivamente o que aparece.
Responda só com o conteúdo extraído, organizado, sem comentários.`;

/** Extrai o conteúdo de uma imagem (base64) via modelo de visão. */
export async function extractFromImage(base64: string, mimeType: string): Promise<string> {
  const completion = await openai.chat.completions.create({
    model: config.openai.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: EXTRACT_PROMPT },
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${base64}` },
          },
        ],
      },
    ],
  });
  return completion.choices[0]?.message?.content?.trim() || '';
}

/** Extrai o conteúdo de um PDF (base64) via Responses API com input_file. */
export async function extractFromPdf(base64: string, fileName: string): Promise<string> {
  const response = await openai.responses.create({
    model: config.openai.model,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_file',
            filename: fileName || 'documento.pdf',
            file_data: `data:application/pdf;base64,${base64}`,
          },
          { type: 'input_text', text: EXTRACT_PROMPT },
        ],
      },
    ],
  });
  return response.output_text?.trim() || '';
}
