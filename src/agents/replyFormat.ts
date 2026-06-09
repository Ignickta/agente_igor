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
