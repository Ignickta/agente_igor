/**
 * Lista TODOS os fatos legados (factsCol) de um contato — o banco antigo, sem
 * embedding, que a migração vai unificar. Só leitura.
 *
 *   npx ts-node --transpile-only scripts/list-legacy-facts.ts <contato>
 */
import { listLegacyFacts } from '../src/services/firebase';

const contato = process.argv[2];
if (!contato) {
  console.error('Uso: list-legacy-facts.ts <contato>');
  process.exit(1);
}

async function main() {
  const facts = await listLegacyFacts(contato);
  if (facts.length === 0) {
    console.log('Nenhum fato legado para este contato.');
    process.exit(0);
  }
  for (const f of facts) {
    const data = f.createdAt ? new Date(f.createdAt).toLocaleDateString('pt-BR') : 'sem data';
    console.log(`[${data}] [sub=${f.subagentId}] ${f.text}`);
  }
  console.log(`\nTotal: ${facts.length} fato(s) legado(s).`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
