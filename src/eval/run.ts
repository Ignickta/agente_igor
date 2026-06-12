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
  isPureDoneConfirmation,
} from '../agents/central';
import { routeByEmbedding, hintFrom } from '../agents/embeddingRouter';
import { CLAIMS_ACTION_REGEX } from '../agents/subagents';
import { DEFAULT_SUBAGENTS } from '../agents/subagents/defaults';
import { weekRange, monthRange } from '../agents/orchestrator';
import { parseLocalIso, addDays, weekdayOf, dayKey, timeKey, nextOccurrence } from '../services/datetime';
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
  suiteDoneShortcut();
  suiteClaimsRegex();
  suiteKeywordRouting();
  suiteDatetime();
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
