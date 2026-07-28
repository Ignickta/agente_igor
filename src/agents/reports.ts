import { config } from '../config';
import { chat, ChatMessage } from '../services/openai';
import { sendText } from '../services/evolution';
import {
  listSubagents,
  getPendingTasks,
  getCompletedTasksBetween,
  getAgendaForDay,
  getMetrics,
  listTasks,
} from '../services/firebase';
import { weekRange } from './orchestrator';
import { rememberAsk } from './pendingPrompt';
import { PendingPromptTarget } from '../types';
import { CLAIMS_ACTION_REGEX } from './subagents';
import { dayKey, addDays, dayStartMs, timeKey, dateLabelPt } from '../services/datetime';
import { isNotificationEnabled } from '../services/settings';

/** True se as notificações proativas estão ligadas e há dono configurado. */
function canNotify(): boolean {
  return config.proactiveNotifications && !!config.ownerPhone;
}

// ===================== Follow-up de pendências (20h30) =====================

/**
 * Fechamento do dia: lembretes que DISPARARAM hoje mas nunca foram confirmados
 * como feitos (done sem completedAt) + itens da AGENDA do dia cujo horário
 * passou sem confirmação (eles não são mais auto-concluídos).
 *
 * Esta é a ÚNICA cobrança garantida do dia. Durante o dia, o agente pergunta no
 * máximo uma vez: se o Igor não responde, a cobrança fica suspensa
 * (`isNudgeSuspended`) e todos os blocos seguintes chegam silenciosamente aqui.
 * Por isso o fechamento é numerado e registrado como pergunta pendente — é aqui
 * que o dia inteiro é decidido de uma vez ("1 e 3", "todos", "nenhum"), em vez
 * de item por item ao longo do dia.
 *
 * Não promete adiar nada: o que não foi feito solta do horário na virada do dia
 * e só volta para a agenda se o Igor pedir.
 */
export async function sendPendingFollowUp(): Promise<void> {
  if (!canNotify()) return;
  const today = dayKey();
  const fired = (await listTasks()).filter(
    (t) => t.done && !t.completedAt && dayKey(new Date(t.remindAt)) === today
  );

  // Itens da agenda de hoje ainda não concluídos. Dedup: um item vinculado a
  // (ou homônimo de) um lembrete que já está na lista não entra duas vezes.
  const firedTexts = new Set(fired.map((t) => t.text.trim().toLowerCase()));
  const firedIds = new Set(fired.map((t) => t.id));
  const agendaPending = (await getAgendaForDay(today)).filter(
    (i) =>
      i.status !== 'done' &&
      i.endTime <= timeKey() && // só cobra o que já deveria ter acontecido
      !(i.taskId && firedIds.has(i.taskId)) &&
      !firedTexts.has(i.title.trim().toLowerCase())
  );

  if (fired.length === 0 && agendaPending.length === 0) return;

  // Numeração única e contínua sobre as duas listas — é por ela que "1 e 3"
  // resolve, então targets e texto precisam sair da MESMA ordem.
  const targets: PendingPromptTarget[] = [
    ...fired.map((t) => ({ taskId: t.id, title: t.text })),
    ...agendaPending.map((i) => ({
      ...(i.taskId ? { taskId: i.taskId } : {}),
      agendaItemId: i.id,
      title: i.title,
    })),
  ].map((t, idx) => ({ ...t, index: idx + 1 }));

  const linhas = [
    ...fired.map((t) => t.text),
    ...agendaPending.map((i) => `${i.title} (${i.startTime}–${i.endTime})`),
  ]
    .map((label, idx) => `${idx + 1}. *${label}*`)
    .join('\n');

  const plural = targets.length > 1;

  // Registra ANTES de enviar: se o Igor responder num piscar de olhos, o estado
  // já existe para a resposta casar.
  await rememberAsk(config.ownerPhone, targets);

  const text =
    `🔁 *Fechando o dia*\n\nEsses itens de hoje ficaram sem confirmação:\n${linhas}\n\n` +
    (plural
      ? `Quais você fez? Responda com os números (ex: *1 e 3*), *todos*, ou *nenhum*.`
      : `Você fez? Responda *sim* ou *não*.`) +
    `\n\n_O que não deu, sem problema: solta do horário e fica te esperando decidir._`;
  await sendText(config.ownerPhone, text);
  console.log(`[reports] fechamento do dia enviado (${targets.length} itens).`);
}

// ===================== F1: resumo diário noturno (22h) =====================

/**
 * Resumo do dia: tarefas concluídas, pendentes e os 3 itens mais importantes
 * de amanhã (por prioridade na agenda).
 */
export async function sendNightlySummary(): Promise<void> {
  if (!canNotify() || !isNotificationEnabled('eveningSummary')) return;
  const today = dayKey();
  const start = dayStartMs(today);
  const end = Date.now();

  const [completed, pending, tomorrowItems] = await Promise.all([
    getCompletedTasksBetween(start, end),
    getPendingTasks(),
    getAgendaForDay(addDays(today, 1)),
  ]);

  const top3 = [...tomorrowItems]
    .filter((i) => i.status !== 'done')
    .sort((a, b) => a.priority - b.priority || a.startTime.localeCompare(b.startTime))
    .slice(0, 3);

  const linhasTop = top3.length
    ? top3.map((i) => `   • ${i.startTime} ${i.title}`).join('\n')
    : '   • (nada agendado ainda)';

  const text =
    `🌙 *Resumo do dia* (${dateLabelPt(today)})\n\n` +
    `✅ Concluídas hoje: ${completed.length}\n` +
    `⬜ Pendentes no total: ${pending.length}\n\n` +
    `🔝 *Prioridades de amanhã:*\n${linhasTop}\n\n` +
    `_Bom descanso, Igor!_`;
  await sendText(config.ownerPhone, text);
  console.log('[reports] resumo noturno enviado.');
}

// ===================== F2: revisão semanal (sexta 18h) =====================

/**
 * Relatório semanal: total de concluídas, pendentes, taxa de conclusão e
 * destaques da semana (resumidos pelo LLM a partir das tarefas concluídas).
 */
export async function sendWeeklyReview(): Promise<void> {
  if (!canNotify() || !isNotificationEnabled('weeklyReview')) return;
  const { start, end } = weekRange();
  const startMs = dayStartMs(start);
  const endMs = dayStartMs(end) + 86400000;

  const [completed, pending] = await Promise.all([
    getCompletedTasksBetween(startMs, endMs),
    getPendingTasks(),
  ]);

  const totalConsiderado = completed.length + pending.length;
  const taxa = totalConsiderado > 0 ? Math.round((completed.length / totalConsiderado) * 100) : 0;

  let destaques = '';
  if (completed.length > 0) {
    try {
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'Resuma em até 3 bullets curtos os destaques da semana a partir das tarefas ' +
            'concluídas. Português do Brasil, direto, sem enrolação. NUNCA junte tarefas ' +
            'diferentes num mesmo bullet com barra ou vírgula ("hotel / custos / anamnese") — ' +
            'cada bullet fala de UMA tarefa, com o título como o Igor escreveu. Se não couber ' +
            'tudo, escolha as 3 mais relevantes e ignore o resto.',
        },
        { role: 'user', content: completed.map((t) => `- ${t.text}`).join('\n') },
      ];
      destaques = await chat(messages, { temperature: 0.3 });
    } catch (err) {
      console.error('[reports] falha ao resumir destaques:', err);
    }
  }

  const text =
    `📊 *Revisão semanal* (${start.slice(8, 10)}/${start.slice(5, 7)} a ${end.slice(8, 10)}/${end.slice(5, 7)})\n\n` +
    `✅ Concluídas: ${completed.length}\n` +
    `⬜ Pendentes: ${pending.length}\n` +
    `📈 Taxa de conclusão: ${taxa}%\n` +
    (destaques ? `\n✨ *Destaques:*\n${destaques}` : '') +
    `\n\n_Boa virada de semana!_`;
  await sendText(config.ownerPhone, text);
  console.log('[reports] revisão semanal enviada.');
}

// ===================== F7: proatividade dos subagentes (1x/dia) =====================

/**
 * Para cada subagente ativo, pergunta ao LLM se há algo relevante para notificar
 * proativamente (prazo chegando, tarefa parada, info nova). Envia só o que valer
 * a pena — o modelo responde "NADA" quando não há nada a dizer.
 */
export async function runProactiveCheck(): Promise<void> {
  if (!canNotify()) return;
  const subs = await listSubagents();
  const pending = await getPendingTasks();
  const nowIso = new Date().toISOString();

  for (const sub of subs) {
    try {
      const myTasks = pending.filter((t) => t.subagentId === sub.id);
      // A proatividade extrapolava a partir de fatos de memória antiga (ex.:
      // ressuscitava "prioridade máxima falar com o fornecedor" muito depois de
      // resolvido). Agora só olha tarefas pendentes REAIS: sem tarefa, sem aviso;
      // fatos não entram mais no prompt para não virarem cobrança fantasma.
      if (myTasks.length === 0) continue;

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            `${sub.prompt}\n\nVocê é o subagente "${sub.name}". Verifique se há algo RELEVANTE ` +
            'para avisar o Igor proativamente agora, com base SOMENTE nas tarefas pendentes reais ' +
            'listadas abaixo (prazo chegando, tarefa parada há muito tempo). Se SIM, escreva UMA ' +
            'mensagem curta de WhatsApp começando com o nome da área entre colchetes. Se NÃO houver ' +
            'nada que valha a pena, responda exatamente "NADA".\n' +
            'REGRAS RÍGIDAS:\n' +
            '1) Baseie-se APENAS na lista de tarefas pendentes abaixo. NÃO invente, deduza nem ' +
            'ressuscite compromissos, prazos ou "prioridades" que não estejam nessa lista — ' +
            'especialmente coisas que você acha que lembra do passado. Se não está na lista de ' +
            'pendências, para você NÃO existe e NÃO deve ser mencionado.\n' +
            '2) Nesta verificação você NÃO tem ferramentas — não cria lembrete, não agenda, não ' +
            'altera nada. Por isso NUNCA prometa ação ("vou te lembrar", "agendei", "deixei ' +
            'marcado"): apenas AVISE ou SUGIRA; quem decide e pede é o Igor.\n' +
            '3) Cite cada tarefa pelo título EXATO da lista, uma por item. NUNCA funda várias ' +
            'numa só com barra ou vírgula ("logística / custos / hotel") para economizar espaço: ' +
            'isso cria uma tarefa que não existe. Se for muita coisa, fale só das mais urgentes.',
        },
        {
          role: 'user',
          content:
            `Data/hora atual: ${nowIso}\n\nTarefas pendentes desta área (a ÚNICA fonte válida):\n` +
            (myTasks.map((t) => `- "${t.text}" (lembrar em ${t.remindAt})`).join('\n') || '(nenhuma)'),
        },
      ];
      const out = (await chat(messages, { temperature: 0.4 })).trim();
      if (out && !/^nada\.?$/i.test(out)) {
        // Rede de segurança: aqui NÃO há ferramentas, então qualquer promessa
        // de ação ("vou te lembrar", "agendei") é falsa por construção. Nesse
        // caso a mensagem é descartada — melhor silêncio do que mentira.
        if (CLAIMS_ACTION_REGEX.test(out)) {
          console.warn(
            `[reports] proatividade de ${sub.name} descartada: prometia ação sem ter ferramentas.`
          );
          continue;
        }
        await sendText(config.ownerPhone, `🔔 ${out}`);
        console.log(`[reports] proatividade enviada (${sub.name}).`);
      }
    } catch (err) {
      console.error(`[reports] falha na proatividade de ${sub.name}:`, err);
    }
  }
}

// ===================== F9: relatório por subagente (segunda 8h) =====================

/**
 * Toda segunda, cada subagente ativo envia um resumo da sua semana: interações
 * (das métricas de uso), principais tópicos (resumidos pelo LLM da memória) e
 * itens pendentes da área.
 */
export async function sendSubagentWeeklyReports(): Promise<void> {
  if (!canNotify() || !isNotificationEnabled('subagentReports')) return;
  const subs = await listSubagents();
  const metrics = await getMetrics(7);
  const pending = await getPendingTasks();

  for (const sub of subs) {
    try {
      const interacoes = metrics.reduce((acc, m) => acc + (m.byAgent[sub.id] || 0), 0);
      const myTasks = pending.filter((t) => t.subagentId === sub.id);
      // Nada aconteceu nesta área na semana? não envia (evita spam).
      if (interacoes === 0 && myTasks.length === 0) continue;

      const pendLinhas = myTasks.length
        ? myTasks.map((t) => `   • ${t.text}`).join('\n')
        : '   • (nenhum)';

      const text =
        `🗒️ *${sub.name} — resumo da semana*\n\n` +
        `💬 Interações: ${interacoes}\n` +
        `⬜ Pendentes da área: ${myTasks.length}\n${pendLinhas}`;
      await sendText(config.ownerPhone, text);
      console.log(`[reports] relatório semanal enviado (${sub.name}).`);
    } catch (err) {
      console.error(`[reports] falha no relatório de ${sub.name}:`, err);
    }
  }
}
