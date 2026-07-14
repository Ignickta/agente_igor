/**
 * Detecta se o usuário pediu explicitamente uma resposta em ÁUDIO nesta
 * mensagem (ex: "responde em áudio", "manda em áudio", "me manda um áudio").
 *
 * É um pedido pontual (one-shot): o webhook responde aquela mensagem em áudio e
 * volta ao padrão texto automaticamente, sem guardar estado.
 */
export function wantsAudioReply(text: string): boolean {
  const t = text.toLowerCase();
  // Palavra "áudio"/"audio" (com ou sem acento) como token.
  const hasAudio = /(^|[^\p{L}])(áudio|audio)([^\p{L}]|$)/u.test(t);
  if (!hasAudio) return false;
  // Combinada com um verbo de pedir/responder/mandar/falar/gravar, ou uma
  // preposição de formato ("em/por/de áudio").
  return /(responde|responda|respond[ae]r|manda|mande|mandar|envia|envie|enviar|fala|fale|falar|grava|grave|gravar|(em|por|de)\s+(áudio|audio))/.test(
    t
  );
}

/** Limite rígido para respostas conversacionais enviadas pelo WhatsApp. */
export const MAX_WHATSAPP_REPLY_CHARS = 480;

/**
 * Última camada de proteção contra respostas prolixas: mantém a resposta inteira
 * quando ela já é curta e, caso contrário, preserva o último encerramento de
 * frase que couber. O prompt manda começar pelo essencial, então o corte nunca
 * depende de um segundo modelo nem inventa conteúdo novo.
 */
export function compactWhatsAppReply(reply: string): string {
  const normalized = reply.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (normalized.length <= MAX_WHATSAPP_REPLY_CHARS) return normalized;

  const available = MAX_WHATSAPP_REPLY_CHARS - 1; // espaço para reticências
  const excerpt = normalized.slice(0, available + 1);
  const sentenceEnd = Math.max(excerpt.lastIndexOf('.'), excerpt.lastIndexOf('!'), excerpt.lastIndexOf('?'));
  if (sentenceEnd >= 80) return `${excerpt.slice(0, sentenceEnd + 1).trim()}…`;

  const wordEnd = excerpt.lastIndexOf(' ');
  const safeEnd = wordEnd >= 80 ? wordEnd : available;
  return `${excerpt.slice(0, safeEnd).trim()}…`;
}
