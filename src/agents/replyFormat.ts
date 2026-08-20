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

/**
 * Número máximo de mensagens em que uma resposta longa pode ser quebrada.
 * Evita transformar um pedido de lista em enxurrada de notificações.
 */
export const MAX_REPLY_PARTS = 6;

/** Uma linha de item de lista: "- x", "• x", "* x" ou "1. x". */
const LIST_ITEM = /^\s*(?:[-•*]|\d+[.)])\s+\S/;

/**
 * True quando a resposta é uma LISTAGEM de verdade (3+ itens), e não um
 * parágrafo com um bullet solto. Só nesse caso vale a pena gastar várias
 * mensagens: cortar uma lista pela metade esconde registros que existem.
 */
export function isListReply(reply: string): boolean {
  const items = reply.split('\n').filter((line) => LIST_ITEM.test(line));
  return items.length >= 3;
}

/**
 * Divide a resposta nas mensagens que serão enviadas no WhatsApp.
 *
 * Conversa normal continua com UMA mensagem cortada em MAX_WHATSAPP_REPLY_CHARS
 * — o limite existe para o agente não ser prolixo. Mas listar lembretes não é
 * prolixidade: se o Igor tem 16 pendências, as 16 são a resposta certa. Aí a
 * lista é quebrada em blocos que respeitam a fronteira de cada item, para nenhum
 * registro aparecer pela metade (era o que produzia "no asaas.…").
 */
export function splitWhatsAppReply(reply: string): string[] {
  const normalized = reply.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (normalized.length <= MAX_WHATSAPP_REPLY_CHARS) return [normalized];
  if (!isListReply(normalized)) return [compactWhatsAppReply(normalized)];

  const parts: string[] = [];
  let current = '';
  for (const line of normalized.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= MAX_WHATSAPP_REPLY_CHARS) {
      current = candidate;
      continue;
    }
    if (current) parts.push(current);
    // Linha sozinha maior que o limite: não há fronteira de item para respeitar,
    // então cai no corte por palavra em vez de estourar a mensagem.
    current = line.length > MAX_WHATSAPP_REPLY_CHARS ? compactWhatsAppReply(line) : line;
  }
  if (current) parts.push(current);

  if (parts.length <= MAX_REPLY_PARTS) return parts;
  const kept = parts.slice(0, MAX_REPLY_PARTS - 1);
  const omitted = parts
    .slice(MAX_REPLY_PARTS - 1)
    .reduce((total, part) => total + part.split('\n').filter((l) => LIST_ITEM.test(l)).length, 0);
  kept.push(`…e mais ${omitted} ${omitted === 1 ? 'item' : 'itens'}. Ver tudo no painel.`);
  return kept;
}
