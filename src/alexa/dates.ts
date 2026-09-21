import { dayKey, addDays, weekdayOf, dateLabelPt } from '../services/datetime';

/**
 * Tradução do que a Alexa devolve em datas para um intervalo concreto.
 *
 * O slot de data da Amazon não devolve só `2026-09-22`. Dependendo do que foi
 * falado, ele devolve uma SEMANA (`2026-W39`), um FIM DE SEMANA
 * (`2026-W39-WE`), um MÊS (`2026-09`), uma ESTAÇÃO (`2026-SU`) ou um ANO. Esses
 * valores não podem ir para o Firestore como se fossem um dia — a consulta
 * voltaria vazia e a Skill diria que não há nada, o que é pior do que um erro.
 *
 * Tudo aqui vira `{ start, end }` em YYYY-MM-DD, resolvido no fuso do Igor.
 */

export interface DateRange {
  /** YYYY-MM-DD inicial, inclusivo. */
  start: string;
  /** YYYY-MM-DD final, inclusivo. */
  end: string;
  /** Como falar esse intervalo em voz alta ("amanhã", "essa semana"). */
  label: string;
}

const DIA = /^\d{4}-\d{2}-\d{2}$/;
const SEMANA = /^(\d{4})-W(\d{1,2})$/;
const FIM_DE_SEMANA = /^(\d{4})-W(\d{1,2})-WE$/;
const MES = /^(\d{4})-(\d{2})$/;
const ANO = /^\d{4}$/;

const MESES_PT = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

/**
 * Converte o valor do slot de data em um intervalo.
 *
 * `today` é injetado em vez de lido do relógio para que o comportamento possa
 * ser testado — e para garantir que "hoje" seja o hoje do Igor, não o do
 * container, que roda em UTC.
 */
export function resolveDateSlot(value: string | undefined, today = dayKey()): DateRange | null {
  const v = (value ?? '').trim();
  if (!v) return null;

  if (DIA.test(v)) return { start: v, end: v, label: relativeLabel(v, today) };

  const we = FIM_DE_SEMANA.exec(v);
  if (we) {
    const segunda = mondayOfIsoWeek(Number(we[1]), Number(we[2]));
    // Sábado e domingo da semana pedida.
    return { start: addDays(segunda, 5), end: addDays(segunda, 6), label: 'no fim de semana' };
  }

  const sem = SEMANA.exec(v);
  if (sem) {
    const segunda = mondayOfIsoWeek(Number(sem[1]), Number(sem[2]));
    const domingo = addDays(segunda, 6);
    // Semana que já começou: não faz sentido ler compromissos que passaram.
    const start = today > segunda && today <= domingo ? today : segunda;
    return { start, end: domingo, label: start === today ? 'de hoje até domingo' : 'nessa semana' };
  }

  const mes = MES.exec(v);
  if (mes) {
    const primeiro = `${mes[1]}-${mes[2]}-01`;
    const start = today > primeiro && today.startsWith(`${mes[1]}-${mes[2]}`) ? today : primeiro;
    return {
      start,
      end: lastDayOfMonth(Number(mes[1]), Number(mes[2])),
      label: `em ${MESES_PT[Number(mes[2]) - 1]}`,
    };
  }

  // Ano, estação do ano, década: vago demais para ler em voz alta. Quem chamar
  // deve pedir uma data específica em vez de despejar meses de agenda.
  if (ANO.test(v)) return null;
  return null;
}

/** "hoje", "amanhã", "depois de amanhã" ou o dia por extenso. */
export function relativeLabel(date: string, today = dayKey()): string {
  if (date === today) return 'hoje';
  if (date === addDays(today, 1)) return 'amanhã';
  if (date === addDays(today, -1)) return 'ontem';
  if (date === addDays(today, 2)) return 'depois de amanhã';

  const [, m, d] = date.split('-');
  const diaSemana = dateLabelPt(date).split(',')[0];
  // Dentro da próxima semana o dia da semana basta; depois disso, a data.
  const dentroDaSemana = date > today && date <= addDays(today, 7);
  return dentroDaSemana
    ? `na ${diaSemana}`
    : `em ${Number(d)} de ${MESES_PT[Number(m) - 1]}`;
}

/**
 * Data por extenso e sem ambiguidade, para a confirmação antes de gravar.
 *
 * "sexta" é o tipo de coisa que a Alexa entende como a sexta errada. Repetir
 * "sexta-feira, vinte e cinco de setembro" dá ao Igor a chance de corrigir
 * antes de qualquer escrita.
 */
export function unambiguousLabel(date: string, today = dayKey()): string {
  const [, m, d] = date.split('-');
  const porExtenso = `${Number(d)} de ${MESES_PT[Number(m) - 1]}`;
  if (date === today) return `hoje, ${porExtenso}`;
  if (date === addDays(today, 1)) return `amanhã, ${porExtenso}`;
  const diaSemana = dateLabelPt(date).split(',')[0];
  return `${diaSemana}, ${porExtenso}`;
}

/** Segunda-feira da semana ISO (a Amazon usa numeração ISO). */
function mondayOfIsoWeek(year: number, week: number): string {
  // 4 de janeiro cai sempre na semana 1 da numeração ISO.
  const quatroDeJaneiro = `${year}-01-04`;
  const diaDaSemana = weekdayOf(quatroDeJaneiro); // 0=domingo
  const offsetSegunda = diaDaSemana === 0 ? -6 : 1 - diaDaSemana;
  const segundaDaSemana1 = addDays(quatroDeJaneiro, offsetSegunda);
  return addDays(segundaDaSemana1, (week - 1) * 7);
}

function lastDayOfMonth(year: number, month: number): string {
  const ultimo = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(ultimo).padStart(2, '0')}`;
}

/**
 * Faixa de horário de um período do dia falado ("de manhã", "à tarde").
 *
 * Devolve `null` para qualquer outra coisa, inclusive vazio — o chamador então
 * lê o dia inteiro.
 */
export function resolveDayPeriod(value: string | undefined): { from: string; to: string } | null {
  const v = (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
  if (!v) return null;
  if (v.includes('manha') || v.includes('cedo')) return { from: '00:00', to: '12:00' };
  if (v.includes('tarde')) return { from: '12:00', to: '18:00' };
  if (v.includes('noite')) return { from: '18:00', to: '23:59' };
  return null;
}

/**
 * Converte o valor do slot de hora da Alexa em HH:mm.
 *
 * Além de horas exatas, o slot devolve períodos (`MO`, `AF`, `EV`, `NI`) quando
 * a pessoa diz "de manhã" no lugar de uma hora. Esses não são um horário e não
 * podem virar um compromisso — devolvem `null` para que a Skill pergunte.
 */
export function resolveTimeSlot(value: string | undefined): string | null {
  const v = (value ?? '').trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d/.test(v)) return null;
  return v.slice(0, 5);
}

/** Fala um horário do jeito que se diz em português. */
export function speakTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const hora = h === 0 ? 'meia-noite' : h === 12 ? 'meio-dia' : `${h}`;
  if (m === 0) return h === 0 || h === 12 ? hora : `${hora} horas`;
  if (m === 30 && (h === 0 || h === 12)) return `${hora} e meia`;
  return `${hora} e ${m}`;
}
