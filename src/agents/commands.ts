import { config } from '../config';
import {
  listSubagents,
  createSubagent,
  updateSubagent,
  deleteSubagent,
  getSubagent,
  createTask,
} from '../services/firebase';

/**
 * Resultado de uma tentativa de processar comando.
 * - handled=false: a mensagem não era um comando; segue para os subagentes.
 * - handled=true: comando tratado; `reply` é a resposta a enviar.
 */
export interface CommandResult {
  handled: boolean;
  reply?: string;
}

const HELP = `🛠️ *Comandos do agente*

/agentes — lista seus subagentes
/criar Nome | palavra1, palavra2 | prompt do subagente
/remover <id>
/ativar <id>
/desativar <id>
/lembrar 2026-06-09T13:00 | texto do lembrete
/ajuda — mostra esta ajuda

_Exemplo:_
/criar Academia | treino, dieta, academia | Você é meu personal trainer pessoal.`;

/** Só o dono (OWNER_PHONE) pode executar comandos administrativos. */
function isOwner(contact: string): boolean {
  if (!config.ownerPhone) return true; // sem dono configurado, libera (dev)
  return contact === config.ownerPhone;
}

/**
 * Processa comandos iniciados por "/". Se a mensagem não for comando,
 * retorna { handled: false } para o agente central seguir o fluxo normal.
 */
export async function tryHandleCommand(
  contact: string,
  text: string
): Promise<CommandResult> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { handled: false };

  if (!isOwner(contact)) {
    return { handled: true, reply: '🔒 Apenas o dono pode usar comandos administrativos.' };
  }

  const [rawCmd, ...rest] = trimmed.slice(1).split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const args = rest.join(' ').trim();

  switch (cmd) {
    case 'ajuda':
    case 'help':
    case 'start':
      return { handled: true, reply: HELP };

    case 'agentes':
    case 'subagentes':
      return { handled: true, reply: await listCommand() };

    case 'criar':
    case 'novo':
      return { handled: true, reply: await createCommand(args) };

    case 'remover':
    case 'deletar':
      return { handled: true, reply: await deleteCommand(args) };

    case 'ativar':
      return { handled: true, reply: await toggleCommand(args, true) };

    case 'desativar':
      return { handled: true, reply: await toggleCommand(args, false) };

    case 'lembrar':
    case 'lembrete':
      return { handled: true, reply: await reminderCommand(contact, args) };

    default:
      return {
        handled: true,
        reply: `Comando /${cmd} não reconhecido. Envie /ajuda para ver os disponíveis.`,
      };
  }
}

// ===================== Implementações =====================

async function listCommand(): Promise<string> {
  const subs = await listSubagents(true);
  if (subs.length === 0) return 'Nenhum subagente cadastrado. Use /criar para adicionar.';
  const lines = subs.map((s) => {
    const status = s.active ? '🟢' : '⚪';
    return `${status} *${s.name}*\n   id: \`${s.id}\`\n   temas: ${s.keywords.join(', ') || '—'}`;
  });
  return `📋 *Seus subagentes:*\n\n${lines.join('\n\n')}`;
}

async function createCommand(args: string): Promise<string> {
  // Formato: Nome | palavras,separadas,por,virgula | prompt
  const parts = args.split('|').map((p) => p.trim());
  if (parts.length < 3 || !parts[0] || !parts[2]) {
    return (
      '❌ Formato inválido. Use:\n' +
      '/criar Nome | palavra1, palavra2 | prompt do subagente'
    );
  }
  const [name, keywordsRaw, prompt] = parts;
  const keywords = keywordsRaw
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  const sub = await createSubagent({ name, keywords, prompt, active: true });
  return `✅ Subagente *${sub.name}* criado!\nid: \`${sub.id}\`\ntemas: ${keywords.join(', ') || '—'}`;
}

async function deleteCommand(id: string): Promise<string> {
  if (!id) return '❌ Informe o id: /remover <id> (veja em /agentes).';
  const existing = await getSubagent(id);
  if (!existing) return `❌ Subagente \`${id}\` não encontrado.`;
  await deleteSubagent(id);
  return `🗑️ Subagente *${existing.name}* removido.`;
}

async function toggleCommand(id: string, active: boolean): Promise<string> {
  if (!id) return `❌ Informe o id: /${active ? 'ativar' : 'desativar'} <id>.`;
  const existing = await getSubagent(id);
  if (!existing) return `❌ Subagente \`${id}\` não encontrado.`;
  await updateSubagent(id, { active });
  return `${active ? '🟢 Ativado' : '⚪ Desativado'}: *${existing.name}*`;
}

async function reminderCommand(contact: string, args: string): Promise<string> {
  // Formato: 2026-06-09T13:00 | texto
  const [whenRaw, ...textParts] = args.split('|');
  const text = textParts.join('|').trim();
  if (!whenRaw || !text) {
    return '❌ Formato: /lembrar 2026-06-09T13:00 | texto do lembrete';
  }
  const when = new Date(whenRaw.trim());
  if (isNaN(when.getTime())) {
    return '❌ Data inválida. Use o formato 2026-06-09T13:00 (ano-mês-diaThora:min).';
  }
  await createTask({
    text,
    remindAt: when.toISOString(),
    to: contact,
  });
  return `⏰ Lembrete agendado para ${when.toLocaleString('pt-BR', {
    timeZone: config.timezone,
  })}:\n"${text}"`;
}
