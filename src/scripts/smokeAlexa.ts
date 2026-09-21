/**
 * Teste de fumaça da rota da Alexa (npm run smoke:alexa).
 *
 * A assinatura da Amazon não pode ser reproduzida fora do dispositivo, então
 * este script sobe SÓ a rota numa porta local, com a validação de assinatura
 * dispensada, e exercita o resto: Skill ID, conta autorizada, corpo quebrado,
 * intents padrão e — o mais importante — a ORDEM DOS MIDDLEWARES.
 *
 * O caso da ordem existe porque é o defeito mais caro possível aqui: se o
 * interpretador de JSON global passar a rodar antes desta rota, o corpo bruto
 * que a Amazon assinou é descartado e a assinatura nunca mais confere. No
 * dispositivo isso aparece como "houve um problema com a skill", sem nenhuma
 * pista. Aqui aparece como uma linha vermelha.
 *
 * Não sobe o servidor de verdade: nada de Firestore, WhatsApp ou OpenAI.
 */
import express from 'express';
import type { Server } from 'http';
import alexaRouter from '../routes/alexa';

const PORT = 4599;
const SKILL = process.env.ALEXA_SKILL_ID || '';
const USER = process.env.ALEXA_ALLOWED_USER_ID || '';

let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : ` → ${detail}`}`);
}

function envelope(
  applicationId: string,
  userId: string,
  request: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    version: '1.0',
    context: { System: { application: { applicationId }, user: { userId } } },
    request: {
      type: 'LaunchRequest',
      requestId: `req-${Date.now()}`,
      timestamp: new Date().toISOString(),
      ...request,
    },
  });
}

async function post(port: number, raw: string): Promise<{ status: number; body: string }> {
  const r = await fetch(`http://localhost:${port}/alexa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw,
  });
  return { status: r.status, body: await r.text() };
}

function listen(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(port, () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function main(): Promise<void> {
  if (!SKILL || !USER) {
    console.error(
      'Defina ALEXA_SKILL_ID e ALEXA_ALLOWED_USER_ID antes de rodar.\n' +
        'Ex: ALEXA_ENABLED=true ALEXA_SKIP_SIGNATURE=true ALEXA_SKILL_ID=... ' +
        'ALEXA_ALLOWED_USER_ID=... npm run smoke:alexa'
    );
    process.exit(1);
  }
  if (!process.env.ALEXA_SKIP_SIGNATURE) {
    console.error('Rode com ALEXA_SKIP_SIGNATURE=true: fora do dispositivo não há assinatura válida.');
    process.exit(1);
  }

  // Mesma ordem do servidor real: a rota da Alexa ANTES do JSON global.
  const app = express();
  app.use('/alexa', alexaRouter);
  app.use(express.json({ limit: '25mb' }));
  const server = await listen(app, PORT);

  console.log('\n📋 Autenticação');
  let r = await post(PORT, envelope(SKILL, USER));
  check('abre a Skill e dá boas-vindas', r.status === 200 && r.body.includes('Olá, Igor'), r.body);

  r = await post(PORT, envelope('amzn1.ask.skill.OUTRA', USER));
  check('Skill ID de outra Skill é recusado', r.body.includes('não é desta skill'), r.body);

  r = await post(PORT, envelope(SKILL, 'amzn1.account.OUTRO'));
  check('conta Amazon diferente é recusada', r.body.includes('não está autorizada'), r.body);

  r = await post(PORT, '{ isso nao e json');
  check('corpo quebrado responde 400', r.status === 400, `${r.status} ${r.body}`);

  console.log('\n📋 Intents padrão');
  r = await post(PORT, envelope(SKILL, USER, { type: 'IntentRequest', intent: { name: 'AMAZON.HelpIntent' } }));
  check('ajuda explica o que a Skill faz', r.body.includes('Eu cuido da sua agenda'), r.body);

  r = await post(PORT, envelope(SKILL, USER, { type: 'IntentRequest', intent: { name: 'AMAZON.StopIntent' } }));
  check(
    '"para" encerra a sessão',
    r.body.includes('Até mais') && r.body.includes('"shouldEndSession":true'),
    r.body
  );

  r = await post(PORT, envelope(SKILL, USER, { type: 'IntentRequest', intent: { name: 'AMAZON.FallbackIntent' } }));
  check(
    'frase não entendida mantém a sessão aberta',
    r.body.includes('Não entendi') && r.body.includes('"shouldEndSession":false'),
    r.body
  );

  r = await post(PORT, envelope(SKILL, USER, { type: 'SessionEndedRequest' }));
  check(
    'fim de sessão responde 200 com corpo VAZIO',
    r.status === 200 && r.body === '',
    `status ${r.status}, corpo: ${JSON.stringify(r.body)}`
  );

  await close(server);

  console.log('\n📋 Ordem dos middlewares (o bloqueador)');
  // Servidor propositalmente ERRADO: JSON global antes da rota. O corpo bruto
  // é consumido e a rota não recebe nada — é exatamente o que precisa falhar.
  const errado = express();
  errado.use(express.json({ limit: '25mb' }));
  errado.use('/alexa', alexaRouter);
  const outro = await listen(errado, PORT + 1);

  r = await post(PORT + 1, envelope(SKILL, USER));
  check(
    'JSON global antes da rota destrói o corpo assinado',
    r.status === 400,
    `esperava 400 (corpo perdido), veio ${r.status} — a proteção da ordem não está funcionando`
  );

  await close(outro);

  console.log(`\n${failed === 0 ? 'Tudo passou.' : `${failed} falha(s).`}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Erro fatal no smoke da Alexa:', err);
  process.exit(1);
});
