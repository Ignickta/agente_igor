/**
 * Correção pontual: zera o `postponedCount` inflado pela rolagem automática.
 *
 * Até 27/07/2026, o job das 07:00 reescrevia toda tarefa não concluída para
 * HOJE e incrementava `postponedCount`. O contador virou, na prática, "quantos
 * dias se passaram" — e não "quantas vezes o Igor adiou". Com 3+, o detector de
 * procrastinação passou a acusar o Igor de adiar coisas que só o cron havia
 * empurrado.
 *
 * A rolagem já não existe mais, mas as tarefas que viveram sob ela seguem com o
 * contador envenenado. Este script zera o contador das tarefas PENDENTES
 * (concluídas ficam intactas: o histórico delas é real).
 *
 * Vive em src/ (e não em scripts/) de propósito: o Dockerfile só copia src/, e
 * é dentro do container que existem as credenciais e o node_modules. Roda como
 * JS compilado:
 *
 *   docker exec agente-igor node dist/scripts/resetPostponed.js --dry
 *   docker exec agente-igor node dist/scripts/resetPostponed.js
 */
import { db } from '../services/firebase';

const dry = process.argv.includes('--dry');

async function main() {
  const snap = await db.collection('tasks').get();
  let alvo = 0;

  for (const doc of snap.docs) {
    const t = doc.data() as {
      text?: string;
      completedAt?: number | null;
      postponedCount?: number;
    };
    if (t.completedAt) continue; // já concluída: histórico real, não mexe
    if (!t.postponedCount) continue; // nada a zerar

    alvo++;
    console.log(
      `${dry ? '[dry] ' : ''}${doc.id}  "${t.text}"  postponedCount ${t.postponedCount} -> 0`
    );
    if (!dry) await doc.ref.update({ postponedCount: 0 });
  }

  console.log(
    `\n${alvo} tarefa(s) ${dry ? 'seriam corrigidas' : 'corrigidas'}.` +
      (dry ? ' Rode sem --dry para aplicar.' : '')
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('falhou:', err);
  process.exit(1);
});
