/**
 * Script de INSPEÇÃO (não apaga nada): lista os fatos de longo prazo de todos os
 * contatos/subagentes que casam com um termo de busca. Uso pontual para
 * diagnosticar fatos antigos que estão "assombrando" a proatividade.
 *
 *   npx ts-node --transpile-only scripts/inspect-facts.ts fornecedor moveis móveis
 */
import { db } from '../src/services/firebase';

const termos = process.argv.slice(2).map((t) => t.toLowerCase());
if (termos.length === 0) {
  console.error('Uso: inspect-facts.ts <termo> [termo2 ...]');
  process.exit(1);
}

async function main() {
  const contatos = await db.collection('memory').listDocuments();
  let achou = 0;
  for (const contato of contatos) {
    const agentes = await contato.collection('agents').listDocuments();
    for (const ag of agentes) {
      const snap = await ag.collection('facts').get();
      for (const doc of snap.docs) {
        const text: string = (doc.data() as { text?: string }).text ?? '';
        const low = text.toLowerCase();
        if (termos.some((t) => low.includes(t))) {
          achou++;
          console.log(
            `\n[contato=${contato.id}] [subagente=${ag.id}] [factId=${doc.id}]\n  → ${text}`
          );
        }
      }
    }
  }
  console.log(`\n${achou} fato(s) encontrado(s) para: ${termos.join(', ')}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
