/**
 * Remove UM fato específico da memória, por caminho exato (contato/subagente/id).
 * Só apaga o documento cujo id casa — nunca varre por texto.
 *
 *   npx ts-node --transpile-only scripts/delete-fact.ts <contato> <subagenteId> <factId>
 */
import { db } from '../src/services/firebase';

const [contato, subagenteId, factId] = process.argv.slice(2);
if (!contato || !subagenteId || !factId) {
  console.error('Uso: delete-fact.ts <contato> <subagenteId> <factId>');
  process.exit(1);
}

async function main() {
  const ref = db
    .collection('memory')
    .doc(contato)
    .collection('agents')
    .doc(subagenteId)
    .collection('facts')
    .doc(factId);

  const snap = await ref.get();
  if (!snap.exists) {
    console.log('Fato não encontrado — nada foi apagado.');
    process.exit(0);
  }
  console.log(`Apagando: "${(snap.data() as { text?: string }).text}"`);
  await ref.delete();
  console.log('OK — fato removido.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
