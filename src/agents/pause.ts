import { config } from '../config';
import { dayKey, timeKey } from '../services/datetime';
import {
  startPause,
  getActivePause,
  endPause,
  getDueTasks,
  getFiredUnconfirmed,
} from '../services/firebase';
import { Task } from '../types';

/**
 * PAUSA DAS MENSAGENS PROATIVAS.
 *
 * "Segura tudo aí" precisava virar uma AÇÃO. Antes só existia o modo foco — que
 * resolve o problema oposto (barra o que entra) e expira sozinho — então o
 * pedido caía na conversa comum: a LLM respondia "entendido, tudo pausado" e o
 * scheduler continuava disparando lembrete, porque nada tinha sido gravado.
 *
 * Regras, nesta ordem de importância:
 *  1) NADA é adiado ou remarcado. Os horários originais ficam intactos — o que
 *     vencer durante a pausa é engolido na hora e reaparece como lista no
 *     retomar. Adiar por conta própria foi reclamação explícita do dono.
 *  2) Não tem prazo. Só termina quando ele mandar voltar — nenhuma expiração
 *     automática vai "achar" que já pode voltar a cobrar.
 *  3) O agente não perde a voz. A pausa vale para o que ele envia SOZINHO;
 *     responder ao que o dono pergunta continua normal.
 */

/** True se a mensagem pede para SEGURAR/PAUSAR as proativas. */
export function isPauseRequest(text: string): boolean {
  // Um pedido de RETOMAR nunca é um pedido de pausar ("volta a me lembrar").
  if (isResumeRequest(text)) return false;
  const t = text.toLowerCase();

  // "segura/suspende/pausa" + algo que indique o conjunto de atividades.
  const verbo =
    /\b(segura(r)?|segure|suspende(r)?|suspenda|pausa(r)?|pause|congela(r)?|congele|para(r)?\s+de\s+me\s+(lembrar|cobrar|mandar))\b/;
  if (!verbo.test(t)) return false;

  // O alvo: tudo/todas as atividades, os lembretes, as cobranças, as mensagens.
  const alvo =
    /\b(tudo|todas?|geral|atividades?|lembretes?|cobran[çc]as?|mensagens?|tarefas?|agenda|not[ií]fica[çc][õo]es?|me\s+(lembrar|cobrar|mandar))\b/;
  return alvo.test(t);
}

/** True se a mensagem pede para RETOMAR as proativas. */
export function isResumeRequest(text: string): boolean {
  const t = text.toLowerCase().trim();
  // Sem pontuação de borda: "pode voltar!" e "pode voltar." são a mesma frase.
  const curto = t.replace(/[!.…?,;\s]+$/g, '').trim();

  // Formas curtas e inequívocas, que valem sozinhas — sem exigir alvo. É o
  // caminho comum: "pode voltar" é exatamente o que a mensagem de pausa ensina
  // a responder, e chega sem complemento nenhum.
  if (
    /^(pode\s+)?(voltar|volta|retomar|retoma|continuar|continua)$/.test(curto) ||
    /^(des)?(pausa(r)?|congela(r)?)$/.test(curto) ||
    /^(voltou|voltei|retomei|pode\s+(voltar|retomar)\s+(tudo|agora))$/.test(curto)
  ) {
    return true;
  }

  const verbo =
    /\b(retoma(r)?|retome|volta(r)?|volte|despausa(r)?|despause|descongela(r)?|reativa(r)?|reative|libera(r)?|libere|continua(r)?|continue)\b/;
  if (!verbo.test(t)) return false;
  const alvo =
    /\b(tudo|todas?|atividades?|lembretes?|cobran[çc]as?|mensagens?|tarefas?|agenda|not[ií]fica[çc][õo]es?|pausa|normal|me\s+(lembrar|cobrar|mandar))\b/;
  return alvo.test(t);
}

/**
 * O contato está com as proativas pausadas? É a checagem que TODO envio
 * espontâneo (lembrete, transição de agenda, cobrança, relatório) faz antes de
 * mandar qualquer coisa.
 */
export async function proactiveMuted(contact: string): Promise<boolean> {
  return (await getActivePause(contact)) !== null;
}

/** Lembretes criados durante a pausa são exceções pontuais autorizadas. */
export function taskAllowedDuringPause(task: Task): boolean {
  return task.bypassPause === true;
}

/** Entra em pausa. Retorna a resposta a enviar. */
export async function enterPause(contact: string, text: string): Promise<string> {
  const already = await getActivePause(contact);
  if (already) {
    const desde = `${dayKey(new Date(already.startedAt))} às ${timeKey(new Date(already.startedAt))}`;
    return (
      `⏸️ Já está tudo pausado desde ${desde} — continua assim.\n\n` +
      'Quando quiser voltar, é só me dizer *"pode voltar"*.'
    );
  }
  await startPause(contact, text);
  return (
    '⏸️ *Tudo pausado.*\n\n' +
    'Não vou te mandar lembrete, cobrança nem aviso de agenda por conta própria. ' +
    'Nada foi adiado nem remarcado: os horários continuam como estavam.\n\n' +
    'Isso não tem prazo — só volta quando você mandar. Quando quiser, diga ' +
    '*"pode voltar"* que eu te mostro o que ficou parado. Se precisar de mim ' +
    'no meio tempo, é só falar que eu respondo normal.'
  );
}

/** Lista compacta de tarefas para o resumo do retomar. */
function listar(tasks: Task[]): string {
  return tasks
    .map((t) => `• ${t.text} _(${timeKey(new Date(t.remindAt))})_`)
    .join('\n');
}

/**
 * Sai da pausa e mostra o que ficou parado. A lista é montada na hora, das
 * tarefas que venceram e seguem sem confirmação — como nada foi remarcado, elas
 * simplesmente continuam vencidas, e o scheduler volta a tratá-las no próximo
 * tick. Aqui só damos visibilidade do acúmulo antes de o fluxo normal retornar.
 */
export async function leavePause(contact: string): Promise<string> {
  const wasPaused = await endPause(contact);
  if (!wasPaused) {
    return 'Não tem nada pausado agora — estou funcionando normal. 🙂';
  }

  let parado: Task[] = [];
  try {
    const owner = config.ownerPhone;
    const [due, fired] = await Promise.all([getDueTasks(), getFiredUnconfirmed(dayKey())]);
    const meus = [...due, ...fired].filter((t) => (t.to || owner) === contact);
    // Um mesmo lembrete pode aparecer nas duas listas; ordena por horário.
    const vistos = new Set<string>();
    parado = meus
      .filter((t) => (vistos.has(t.id) ? false : vistos.add(t.id)))
      .sort((a, b) => a.remindAt.localeCompare(b.remindAt));
  } catch (err) {
    console.error('[pause] falha ao montar o resumo do retomar:', err);
    return '▶️ *Voltei.* Já posso te lembrar das coisas de novo.';
  }

  if (parado.length === 0) {
    return '▶️ *Voltei.* Nada ficou vencido no meio tempo — seguimos daqui.';
  }

  const cabecalho =
    parado.length === 1
      ? '▶️ *Voltei.* Ficou 1 item esperando:'
      : `▶️ *Voltei.* Ficaram ${parado.length} itens esperando:`;
  return (
    `${cabecalho}\n${listar(parado.slice(0, 15))}` +
    (parado.length > 15 ? `\n_(+${parado.length - 15} outros)_` : '') +
    '\n\nNada disso foi remarcado — os horários são os originais. Quer que eu ' +
    'reorganize a partir de agora ou prefere seguir assim?'
  );
}
