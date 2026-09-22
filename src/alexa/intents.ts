import { listScheduleEntries, ScheduleEntry } from '../services/agendaActions';
import { dayKey, addDays, timeKey } from '../services/datetime';
import { AlexaIntent, AlexaResponseEnvelope } from './types';
import { ask, SPEECH } from './responses';
import { resolveDateSlot, resolveDayPeriod, relativeLabel, speakAtTime } from './dates';

/**
 * Handlers dos intents da agenda.
 *
 * Só leitura por enquanto. Consulta não altera nada, então não pede
 * confirmação e pode responder direto — é também o caminho mais rápido, o que
 * ajuda a caber no orçamento de tempo da Alexa.
 */

/** Quantos itens são lidos antes de virar "e mais tantos". */
const MAX_FALADOS = 3;

/** Janela padrão de "meus próximos compromissos". */
const DIAS_PROXIMOS = 7;

function slot(intent: AlexaIntent | undefined, name: string): string | undefined {
  return intent?.slots?.[name]?.value;
}

/**
 * Transforma a lista em uma frase curta.
 *
 * Quem ouve não pode reler: ler dez compromissos seguidos não informa, cansa.
 * Por isso lê três e diz quantos sobraram. O dia só entra na fala quando o
 * intervalo cobre mais de um dia — repetir "amanhã" em cada item soa robótico.
 *
 * Lembrete é anunciado como lembrete: sem isso, "pagar o boleto às 18 horas"
 * soa como compromisso marcado, e a pessoa se organiza pelo que ouviu errado.
 */
export function formatAgendaSpeech(
  items: ScheduleEntry[],
  rangeLabel: string,
  multiDay: boolean,
  today = dayKey()
): string {
  if (items.length === 0) return `Você não tem nada ${rangeLabel}.`;

  const diz = (i: ScheduleEntry): string => {
    const quando = multiDay ? `${relativeLabel(i.date, today)}, ` : '';
    const tipo = i.kind === 'reminder' ? 'lembrete de ' : '';
    return `${quando}${tipo}${i.title} ${speakAtTime(i.startTime)}`;
  };

  const lidos = items.slice(0, MAX_FALADOS).map(diz);
  const restantes = items.length - lidos.length;

  if (items.length === 1) {
    return `${capitalize(rangeLabel)} você tem ${lidos[0]}.`;
  }

  const lista =
    lidos.length === 1 ? lidos[0] : `${lidos.slice(0, -1).join(', ')} e ${lidos[lidos.length - 1]}`;

  if (restantes > 0) {
    return (
      `${capitalize(rangeLabel)} você tem ${items.length} compromissos. ` +
      `Os próximos são ${lista}. E mais ${restantes}.`
    );
  }
  return `${capitalize(rangeLabel)} você tem ${items.length} compromissos: ${lista}.`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * "O que eu tenho amanhã?", "tenho algo sexta à tarde?"
 *
 * Lê compromissos e lembretes juntos: quem pergunta quer o dia inteiro, não a
 * coleção onde a coisa foi guardada.
 *
 * Sem data falada, assume hoje — é o que a pessoa quer dizer em 90% das vezes
 * e evita uma pergunta a mais no meio da conversa.
 */
export async function consultarAgenda(intent: AlexaIntent | undefined): Promise<AlexaResponseEnvelope> {
  const hoje = dayKey();
  const range = resolveDateSlot(slot(intent, 'data'), hoje) ?? {
    start: hoje,
    end: hoje,
    label: 'hoje',
  };

  const items = await listScheduleEntries({
    start: range.start,
    end: range.end,
    excludeDone: true,
  });

  const periodo = resolveDayPeriod(slot(intent, 'periodoDia'));
  const filtrados = periodo
    ? items.filter((i) => i.startTime >= periodo.from && i.startTime < periodo.to)
    : items;

  const rotulo = periodo ? `${range.label} ${rotuloPeriodo(periodo.from)}` : range.label;
  const fala = formatAgendaSpeech(filtrados, rotulo, range.start !== range.end, hoje);

  return ask(`${fala} Quer fazer mais alguma coisa?`, 'O que você quer fazer com sua agenda?');
}

function rotuloPeriodo(from: string): string {
  if (from === '00:00') return 'de manhã';
  if (from === '12:00') return 'à tarde';
  return 'à noite';
}

/**
 * "Quais são meus próximos compromissos?"
 *
 * Olha para a frente a partir de AGORA: o que já aconteceu hoje não é próximo
 * compromisso, e ler o que passou faz a Skill parecer desatualizada.
 */
export async function proximosCompromissos(): Promise<AlexaResponseEnvelope> {
  const hoje = dayKey();
  const agora = timeKey();

  const items = (
    await listScheduleEntries({
      start: hoje,
      end: addDays(hoje, DIAS_PROXIMOS),
      excludeDone: true,
    })
  ).filter((i) => i.date > hoje || i.startTime >= agora);

  const fala =
    items.length === 0
      ? 'Você não tem nenhum compromisso nos próximos sete dias.'
      : formatAgendaSpeech(items, 'nos próximos dias', true, hoje);

  return ask(`${fala} Quer fazer mais alguma coisa?`, SPEECH.notUnderstoodReprompt);
}
