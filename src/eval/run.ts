/**
 * Evals de regressão (npm run eval).
 *
 * O histórico deste repo é cheio de bugs sutis de prompt/parse ("1 ou 2" virou
 * 12 no roteador, "perfeito" confundido com "feito", bloco da tarde prometido
 * sem persistir). Cada um virou caso aqui: qualquer mudança em regex, listas de
 * frases ou prompts de roteamento tem que passar por estes casos ANTES do deploy.
 *
 * Suítes determinísticas rodam sempre (sem custo de API). Com a flag --live,
 * roda também o roteador LLM de verdade contra casos reais (gasta algumas
 * chamadas do utilityModel).
 *
 * Requer o .env do projeto (config/firebase são importados pelos módulos).
 */
import {
  AGENDA_REGEX,
  routeByKeywords,
  routeByLLM,
  explicitDoneCount,
  isPureDoneConfirmation,
  extractTomorrowReminder,
} from '../agents/central';
import { routeByEmbedding, hintFrom } from '../agents/embeddingRouter';
import { realDurationMinutes } from '../agents/estimate';
import { CLAIMS_ACTION_REGEX } from '../agents/subagents';
import { DEFAULT_SUBAGENTS } from '../agents/subagents/defaults';
import {
  weekRange,
  monthRange,
  isLaterSlot,
  procrastinationWarning,
  PROCRASTINATION_THRESHOLD,
} from '../agents/orchestrator';
import { parseLocalIso, addDays, weekdayOf, dayKey, timeKey, nextOccurrence } from '../services/datetime';
import { parseEventWindow, CalendarEvent } from '../services/googleCalendar';
import { diffMirror, MirrorItem } from '../agents/calendarSync';
import { Subagent } from '../types';

// ===================== Mini-framework =====================

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(suite: string, name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    const msg = `[${suite}] ${name}${detail ? ` — ${detail}` : ''}`;
    failures.push(msg);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function suite(title: string): void {
  console.log(`\n📋 ${title}`);
}

/** Subagentes padrão com ids falsos, para os casos de roteamento. */
const SUBS: Subagent[] = DEFAULT_SUBAGENTS.map((s, i) => ({ ...s, id: `sub-${i}` }));

// ===================== Suíte A: regex de agenda =====================

function suiteAgendaRegex(): void {
  suite('AGENDA_REGEX — pedidos de agenda vão direto ao orquestrador');

  const deveCasar = [
    'organiza minha tarde',
    'me lembra de pagar o boleto amanhã',
    'remarca o dentista pra sexta',
    'como tá meu dia hoje',
    'quais compromissos eu tenho essa semana',
    'adia a reunião das 15h',
    'planeja meu dia por favor',
    'cria um lembrete pras 18h',
  ];
  for (const t of deveCasar) {
    check('agenda-regex', `casa: "${t}"`, AGENDA_REGEX.test(t));
  }

  const naoDeveCasar = [
    'como estão as vendas de arroz?',
    'o cliente pediu uma proposta de automação',
    'me explica o conceito de juros compostos',
    'escreve um artigo sobre investimentos',
    'o paciente reclamou do tratamento',
  ];
  for (const t of naoDeveCasar) {
    check('agenda-regex', `NÃO casa: "${t}"`, !AGENDA_REGEX.test(t));
  }
}

function suiteTomorrowReminders(): void {
  suite('Prioridades de amanhã — viram lembrete, não planejamento');
  const first = extractTomorrowReminder(
    'Primeira coisa que vai fazer amanhã, seguir o plano de monetização IA'
  );
  check(
    'prioridade-amanha',
    'reconhece prioridade em segunda pessoa',
    !!first && first.firstThing && first.text === 'seguir o plano de monetização IA'
  );
  const commitment = extractTomorrowReminder('amanhã vou enviar a proposta para o cliente');
  check(
    'prioridade-amanha',
    'reconhece compromisso explícito de amanhã',
    !!commitment && !commitment.firstThing && commitment.text === 'enviar a proposta para o cliente'
  );
  check(
    'prioridade-amanha',
    'ignora pergunta sobre amanhã',
    extractTomorrowReminder('amanhã vou fazer o quê?') === null
  );
}

// ===================== Suíte B: atalho "feito" =====================

function suiteDoneShortcut(): void {
  suite('Atalho "feito" — só confirmações puras concluem a tarefa atual');

  const confirma = ['terminei', 'pronto!', 'ok, já fiz', 'feito ✅', 'acabei', 'sim, concluí'];
  for (const t of confirma) {
    check('feito', `confirma: "${t}"`, isPureDoneConfirmation(t));
  }

  const naoConfirma = [
    'tá pronto pra começar?', // pergunta
    'perfeito', // "feito" como substring, não palavra
    'prontidão total hoje', // idem "pronto"
    'feito o quê?', // pergunta
    'terminei o relatório e já mandei pro cliente hoje cedo', // longa, com conteúdo
    'pronto pra amanhã', // sobra conteúdo ("amanhã")
    'quase terminei', // sobra conteúdo ("quase")
  ];
  for (const t of naoConfirma) {
    check('feito', `NÃO confirma: "${t}"`, !isPureDoneConfirmation(t));
  }

  const plurais: Array<[string, number]> = [
    ['feito os 2', 2],
    ['já fiz as duas', 2],
    ['concluí ambos', 2],
    ['terminei 3', 3],
  ];
  for (const [text, count] of plurais) {
    check('feito', `quantidade explícita: "${text}"`, explicitDoneCount(text) === count);
  }
  check('feito', 'confirmação singular não inventa quantidade', explicitDoneCount('feito') === null);
}

// ===================== Suíte C: guarda anti-alucinação =====================

function suiteClaimsRegex(): void {
  suite('CLAIMS_ACTION_REGEX — promessas de ação sem tool call são barradas');

  const promete = [
    'Agendei sua reunião para amanhã às 10h.',
    'Pronto, organizei sua tarde! 😉',
    'Vou te mandar lembrete às 15h.',
    'Seu compromisso está agendado.',
    'Deixei anotado aqui para sexta.',
    'Reorganizei a agenda como você pediu.',
  ];
  for (const t of promete) {
    check('anti-alucinação', `detecta promessa: "${t.slice(0, 40)}..."`, CLAIMS_ACTION_REGEX.test(t));
  }

  const naoPromete = [
    'Posso agendar se você quiser. Qual horário prefere?',
    'Para agendar, me diga o dia e a hora.',
    'Sua agenda de hoje tem 3 itens.',
    'Que tal reservar a manhã para o relatório?',
  ];
  for (const t of naoPromete) {
    check('anti-alucinação', `ignora: "${t.slice(0, 40)}..."`, !CLAIMS_ACTION_REGEX.test(t));
  }
}

// ===================== Suíte D: roteamento por keywords =====================

function suiteKeywordRouting(): void {
  suite('routeByKeywords — match forte decide; keyword solta não basta');

  const casos: { texto: string; esperado: string }[] = [
    { texto: 'o pedido de fardos do distribuidor atrasou', esperado: 'Vendas de Arroz' },
    { texto: 'o paciente quer revisar o plano de tratamento', esperado: 'SaaS Odontológico' },
    { texto: 'monta um workflow no n8n com webhook', esperado: 'Automação / n8n' },
    { texto: 'ideias de pauta pro blog sobre investimento', esperado: 'Blog de Finanças' },
    { texto: 'preciso estudar pra aula de amanhã', esperado: 'Estudos / Aprendizado' },
  ];
  for (const c of casos) {
    const r = routeByKeywords(c.texto, SUBS);
    check(
      'keywords',
      `"${c.texto}" → ${c.esperado} (score >= 2)`,
      !!r && r.sub.name === c.esperado && r.score >= 2,
      r ? `obteve ${r.sub.name} (score ${r.score})` : 'nenhum match'
    );
  }

  // Score 1 não pode decidir sozinho (o caller exige >= 2 e cai pro LLM).
  const fraco = routeByKeywords('o que tem pra hoje?', SUBS);
  check(
    'keywords',
    'keyword solta ("hoje") tem score < 2 — não decide sozinha',
    !fraco || fraco.score < 2,
    fraco ? `score ${fraco.score} em ${fraco.sub.name}` : ''
  );
}

// ===================== Suíte E: datas e fuso =====================

function suiteDatetime(): void {
  suite('Datas — fuso local, recorrência e intervalos');

  // ISO local sem offset interpretado no fuso de SP (-03:00), não no do processo.
  check(
    'datas',
    'parseLocalIso("2026-06-10T22:00:00") → 2026-06-11T01:00:00Z',
    parseLocalIso('2026-06-10T22:00:00').toISOString() === '2026-06-11T01:00:00.000Z',
    parseLocalIso('2026-06-10T22:00:00').toISOString()
  );
  check(
    'datas',
    'parseLocalIso com Z passa direto',
    parseLocalIso('2026-06-10T22:00:00Z').toISOString() === '2026-06-10T22:00:00.000Z'
  );
  check('datas', 'addDays vira o mês (31/01 + 1 = 01/02)', addDays('2026-01-31', 1) === '2026-02-01');
  check('datas', 'weekdayOf(2026-06-12) = sexta (5)', weekdayOf('2026-06-12') === 5);
  check(
    'datas',
    'weekRange contém [segunda, domingo]',
    JSON.stringify(weekRange('2026-06-12')) === JSON.stringify({ start: '2026-06-08', end: '2026-06-14' }),
    JSON.stringify(weekRange('2026-06-12'))
  );
  check(
    'datas',
    'monthRange de fevereiro termina em 28',
    JSON.stringify(monthRange('2026-02-10')) === JSON.stringify({ start: '2026-02-01', end: '2026-02-28' }),
    JSON.stringify(monthRange('2026-02-10'))
  );

  // Recorrências sempre caem no FUTURO preservando o horário local.
  const base = parseLocalIso('2026-06-01T08:00:00').toISOString();
  for (const rec of ['diaria', 'semanal', 'mensal', 'dias_uteis'] as const) {
    const next = new Date(nextOccurrence(base, rec));
    const okFuturo = next.getTime() > Date.now();
    const okHora = timeKey(next) === '08:00';
    const okUtil = rec !== 'dias_uteis' || ![0, 6].includes(weekdayOf(dayKey(next)));
    check(
      'datas',
      `nextOccurrence(${rec}) é futura, às 08:00 local${rec === 'dias_uteis' ? ', em dia útil' : ''}`,
      okFuturo && okHora && okUtil,
      `${dayKey(next)} ${timeKey(next)}`
    );
  }
}

// ===================== Suíte F (--live): roteador LLM =====================

async function suiteLiveRouting(): Promise<void> {
  suite('routeByLLM (LIVE) — roteamento real com o utilityModel');

  const casos: {
    nome: string;
    texto: string;
    contexto?: string;
    ultimo?: string;
    esperado: string;
  }[] = [
    {
      nome: 'assunto claro → área certa',
      texto: 'o paciente cancelou a consulta na clínica hoje cedo',
      esperado: 'SaaS Odontológico',
    },
    {
      nome: 'continuação curta mantém o assunto',
      texto: 'e amanhã?',
      contexto: 'Igor: como estão os pedidos do distribuidor?\nAgente: Temos 3 pedidos abertos hoje.',
      ultimo: 'Vendas de Arroz',
      esperado: 'Vendas de Arroz',
    },
    {
      nome: 'conteúdo de blog',
      texto: 'me dá ideias de post sobre renda fixa pra iniciantes',
      esperado: 'Blog de Finanças',
    },
    {
      nome: 'problema técnico de automação',
      texto: 'o webhook do fluxo de cobrança parou de funcionar',
      esperado: 'Automação / n8n',
    },
    {
      nome: 'ajuste curto de horário segue com a agenda',
      texto: 'muda pra 15h',
      contexto: 'Igor: agenda reunião amanhã às 14h\nAgente: Evento criado: "reunião" amanhã 14:00–15:00.',
      ultimo: 'Agenda / Orquestrador',
      esperado: 'Agenda / Orquestrador',
    },
    {
      nome: 'vida pessoal',
      texto: 'preciso comprar o remédio da minha mãe na farmácia',
      esperado: 'Pessoal / Particular',
    },
  ];

  for (const c of casos) {
    try {
      const r = await routeByLLM(c.texto, SUBS, c.contexto ?? '', c.ultimo);
      check('live-roteador', `${c.nome}: "${c.texto}" → ${c.esperado}`, r.name === c.esperado, `obteve ${r.name}`);
    } catch (err) {
      check('live-roteador', `${c.nome}: "${c.texto}"`, false, `erro: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ===================== Suíte F: calibração de durações =====================

function suiteDurationCalibration(): void {
  suite('realDurationMinutes — sanidade da duração medida');

  const t0 = 1_750_000_000_000;
  const min = (n: number) => n * 60000;

  check('calibração', '45 min medidos → 45', realDurationMinutes(t0, t0 + min(45)) === 45);
  check('calibração', '2 min (toque acidental) → null', realDurationMinutes(t0, t0 + min(2)) === null);
  check('calibração', '9h (item esquecido aberto) → null', realDurationMinutes(t0, t0 + min(540)) === null);
  check('calibração', 'conclusão antes do início → null', realDurationMinutes(t0, t0 - min(5)) === null);
  check('calibração', 'sem startedAt → null', realDurationMinutes(undefined, t0) === null);
  check('calibração', 'sem completedAt → null', realDurationMinutes(t0, null) === null);
}

// ===================== Suíte F2: detector de procrastinação =====================

function suiteProcrastination(): void {
  suite('Detector de procrastinação — o que conta como adiamento');

  check('procrastinação', 'mesmo dia, hora maior → adiou', isLaterSlot('2026-06-12', '09:00', '2026-06-12', '15:00'));
  check('procrastinação', 'mesmo dia, hora menor → antecipou (não conta)', !isLaterSlot('2026-06-12', '15:00', '2026-06-12', '09:00'));
  check('procrastinação', 'dia seguinte, hora menor → adiou', isLaterSlot('2026-06-12', '15:00', '2026-06-13', '08:00'));
  check('procrastinação', 'mesmo slot → não conta', !isLaterSlot('2026-06-12', '09:00', '2026-06-12', '09:00'));
  check(
    'procrastinação',
    'aviso cita o título e o número de adiamentos',
    procrastinationWarning('Declarar imposto', PROCRASTINATION_THRESHOLD).includes('Declarar imposto') &&
      procrastinationWarning('Declarar imposto', 4).includes('4 vezes')
  );
}

// ===================== Suíte F3: Google Calendar (F10) =====================

function suiteCalendar(): void {
  suite('Google Calendar — normalização de eventos (parseEventWindow)');

  // Evento com offset explícito de São Paulo.
  const w1 = parseEventWindow({
    start: { dateTime: '2026-06-12T15:00:00-03:00' },
    end: { dateTime: '2026-06-12T16:00:00-03:00' },
  });
  check(
    'calendar',
    'dateTime -03:00 → dia/horário locais',
    !!w1 && w1.date === '2026-06-12' && w1.startTime === '15:00' && w1.endTime === '16:00' && !w1.allDay,
    JSON.stringify(w1)
  );

  // Evento em UTC (Z): 18:00Z = 15:00 em São Paulo.
  const w2 = parseEventWindow({
    start: { dateTime: '2026-06-12T18:00:00Z' },
    end: { dateTime: '2026-06-12T19:30:00Z' },
  });
  check(
    'calendar',
    'dateTime em UTC convertido para o fuso local',
    !!w2 && w2.date === '2026-06-12' && w2.startTime === '15:00' && w2.endTime === '16:30',
    JSON.stringify(w2)
  );

  // Dia inteiro (start.date, sem horário).
  const w3 = parseEventWindow({ start: { date: '2026-06-12' }, end: { date: '2026-06-13' } });
  check('calendar', 'evento de dia inteiro → allDay', !!w3 && w3.allDay && w3.date === '2026-06-12');

  // Atravessa a meia-noite: bloco local termina às 23:59 do dia de início.
  const w4 = parseEventWindow({
    start: { dateTime: '2026-06-12T22:00:00-03:00' },
    end: { dateTime: '2026-06-13T01:00:00-03:00' },
  });
  check(
    'calendar',
    'evento que vira a noite termina em 23:59',
    !!w4 && w4.date === '2026-06-12' && w4.endTime === '23:59',
    JSON.stringify(w4)
  );

  check('calendar', 'evento sem start → null', parseEventWindow({}) === null);

  suite('Google Calendar — reconciliação (diffMirror)');

  const ev = (id: string, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
    id,
    title: 'Dentista',
    date: '2026-06-12',
    startTime: '15:00',
    endTime: '16:00',
    allDay: false,
    ...over,
  });
  const it = (id: string, over: Partial<MirrorItem> = {}): MirrorItem => ({
    id,
    title: 'Dentista',
    date: '2026-06-12',
    startTime: '15:00',
    endTime: '16:00',
    status: 'pending',
    ...over,
  });

  // Evento novo no Google → cria espelho local.
  const p1 = diffMirror([ev('g1')], []);
  check('calendar', 'evento novo entra em toCreate', p1.toCreate.length === 1 && p1.toCreate[0].id === 'g1');

  // Espelhado sem mudança → plano vazio.
  const p2 = diffMirror([ev('g1')], [it('a1', { gcalEventId: 'g1' })]);
  check(
    'calendar',
    'espelhado idêntico não gera ação',
    p2.toCreate.length + p2.toAdopt.length + p2.toUpdate.length + p2.toDeleteCheck.length === 0
  );

  // Horário mudou no Google → atualiza o espelho.
  const p3 = diffMirror([ev('g1', { startTime: '17:00', endTime: '18:00' })], [it('a1', { gcalEventId: 'g1' })]);
  check('calendar', 'mudança de horário entra em toUpdate', p3.toUpdate.length === 1 && p3.toUpdate[0].itemId === 'a1');

  // Item já concluído nunca é mexido, mesmo com mudança no Google.
  const p4 = diffMirror(
    [ev('g1', { startTime: '17:00', endTime: '18:00' })],
    [it('a1', { gcalEventId: 'g1', status: 'done' })]
  );
  check('calendar', 'item done não entra em toUpdate', p4.toUpdate.length === 0);

  // Igor criou dos dois lados (sem link): adota em vez de duplicar.
  const p5 = diffMirror([ev('g1')], [it('a1')]);
  check(
    'calendar',
    'gêmeo local (título+horário) é adotado, não duplicado',
    p5.toCreate.length === 0 && p5.toAdopt.length === 1 && p5.toAdopt[0].eventId === 'g1'
  );

  // Espelhado sumiu do intervalo → vai para verificação (cancelado OU movido).
  const p6 = diffMirror([], [it('a1', { gcalEventId: 'g1' })]);
  check('calendar', 'espelhado ausente entra em toDeleteCheck', p6.toDeleteCheck.length === 1);

  // ...mas se já foi concluído, fica em paz.
  const p7 = diffMirror([], [it('a1', { gcalEventId: 'g1', status: 'done' })]);
  check('calendar', 'espelhado done ausente NÃO entra em toDeleteCheck', p7.toDeleteCheck.length === 0);

  // Dia inteiro não vira bloco de cronograma.
  const p8 = diffMirror([ev('g1', { allDay: true })], []);
  check('calendar', 'evento de dia inteiro é ignorado', p8.toCreate.length === 0);
}

// ===================== Suíte G (--live): roteador por embedding =====================

async function suiteLiveEmbedding(): Promise<void> {
  suite('routeByEmbedding (LIVE) — decide nos casos fortes, nunca nos ambíguos');

  // Casos fortes: medidos na calibração com scores 0.49–0.54 (limiar 0.45/0.08).
  const decide: { texto: string; esperado: string }[] = [
    { texto: 'o distribuidor pediu mais 200 fardos de arroz predileto', esperado: 'Vendas de Arroz' },
    { texto: 'o webhook do fluxo de cobrança no n8n parou de funcionar', esperado: 'Automação / n8n' },
  ];
  for (const c of decide) {
    const r = await routeByEmbedding(c.texto, SUBS);
    check(
      'live-embedding',
      `decide: "${c.texto}" → ${c.esperado}`,
      !!r && r.decided && r.sub.name === c.esperado,
      r ? `${r.sub.name} score=${r.score.toFixed(3)} margem=${r.margin.toFixed(3)} decided=${r.decided}` : 'null'
    );
  }

  // Ambíguas/transversais: nunca podem decidir sozinhas (calibração: máx 0.417).
  const naoDecide = [
    'como estão as coisas por aí?',
    'preciso resolver aquilo que te falei ontem',
    'faz um resumo do que combinamos',
  ];
  for (const t of naoDecide) {
    const r = await routeByEmbedding(t, SUBS);
    check(
      'live-embedding',
      `NÃO decide: "${t}"`,
      !r || !r.decided,
      r ? `decidiu ${r.sub.name} score=${r.score.toFixed(3)}` : ''
    );
  }

  // Curta demais → nem tenta (continuidade manda).
  const curto = await routeByEmbedding('e amanhã?', SUBS);
  check('live-embedding', 'mensagem curta ("e amanhã?") retorna null', curto === null);

  // Top-1 ruidoso (margem ~0.003 na calibração) não pode virar dica pro LLM.
  const ruido = await routeByEmbedding('preciso comprar o remédio da minha mãe na farmácia', SUBS);
  check(
    'live-embedding',
    'top-1 ruidoso não vira dica (hintFrom null)',
    hintFrom(ruido) === null,
    ruido ? `${ruido.sub.name} score=${ruido.score.toFixed(3)} margem=${ruido.margin.toFixed(3)}` : 'null'
  );
}

// ===================== Main =====================

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  console.log(`🧪 Evals de regressão do agente-igor${live ? ' (com suíte LIVE)' : ''}`);

  suiteAgendaRegex();
  suiteTomorrowReminders();
  suiteDoneShortcut();
  suiteClaimsRegex();
  suiteKeywordRouting();
  suiteDatetime();
  suiteDurationCalibration();
  suiteProcrastination();
  suiteCalendar();
  if (live) {
    await suiteLiveRouting();
    await suiteLiveEmbedding();
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Resultado: ${passed} ✅  ${failed} ❌`);
  if (failures.length) {
    console.log('\nFalhas:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  if (!live) {
    console.log('\nDica: "npm run eval -- --live" roda também o roteador LLM real.');
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Erro fatal nos evals:', err);
  process.exit(1);
});
