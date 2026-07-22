/**
 * Roda a migração de fatos legados (factsCol) → SharedFacts para um contato.
 * Idempotente: dedup impede duplicar; legado é removido após migrar.
 *
 *   npx ts-node --transpile-only scripts/migrate-legacy-facts.ts <contato>
 */
import { migrateLegacyFacts } from '../src/services/memory';

const contato = process.argv[2];
if (!contato) {
  console.error('Uso: migrate-legacy-facts.ts <contato>');
  process.exit(1);
}

async function main() {
  const r = await migrateLegacyFacts(contato);
  console.log(
    `Resultado: ${r.migrated} migrados, ${r.deduped} já existentes/redundantes, ` +
      `${r.deleted} legados removidos.`
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
