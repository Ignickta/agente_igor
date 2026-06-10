import admin from 'firebase-admin';
import { config, normalizePrivateKey } from '../config';

/**
 * Conectores de apps externos (CRM multi empresas, SaaS odonto, ...): cada app
 * é outro projeto Firebase, conectado com sua própria service account via envs
 * (ver config.connectedApps). O agente ganha LEITURA estruturada — consultar
 * clientes, negócios, agendamentos — sem nenhuma escrita, por segurança.
 *
 * Incorporar um app novo = adicionar as envs dele. Nada de código.
 */

export interface ConnectedApp {
  /** Nome curto (chave em CONNECTED_APPS), ex: "crm". */
  name: string;
  /** Descrição para o modelo entender o que há no app. */
  description: string;
  /** Collections conhecidas (nome → descrição), vindas de APP_<N>_COLLECTIONS. */
  collections: Record<string, string>;
  db: admin.firestore.Firestore;
}

const apps = new Map<string, ConnectedApp>();
let initialized = false;

/** Inicializa as conexões uma única vez, tolerando apps mal configurados. */
function initApps(): void {
  if (initialized) return;
  initialized = true;

  for (const name of config.connectedApps) {
    const prefix = `APP_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;
    const projectId = process.env[`${prefix}FIREBASE_PROJECT_ID`];
    const clientEmail = process.env[`${prefix}FIREBASE_CLIENT_EMAIL`];
    const privateKeyRaw = process.env[`${prefix}FIREBASE_PRIVATE_KEY`];
    if (!projectId || !clientEmail || !privateKeyRaw) {
      console.error(`[apps] app "${name}" ignorado: faltam envs ${prefix}FIREBASE_*`);
      continue;
    }

    try {
      const appName = `connected-${name}`;
      const existing = admin.apps.find((a) => a?.name === appName);
      const fbApp =
        existing ??
        admin.initializeApp(
          {
            credential: admin.credential.cert({
              projectId,
              clientEmail,
              privateKey: normalizePrivateKey(privateKeyRaw),
            }),
          },
          appName
        );

      const collections: Record<string, string> = {};
      for (const pair of (process.env[`${prefix}COLLECTIONS`] || '').split(';')) {
        const idx = pair.indexOf('=');
        if (idx > 0) collections[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      }

      apps.set(name, {
        name,
        description: process.env[`${prefix}DESCRIPTION`] || name,
        collections,
        db: fbApp.firestore(),
      });
      console.log(`[apps] app conectado: ${name} (${projectId})`);
    } catch (err) {
      console.error(`[apps] falha ao conectar o app "${name}":`, err);
    }
  }
}

export function listConnectedApps(): ConnectedApp[] {
  initApps();
  return [...apps.values()];
}

export function getConnectedApp(name: string): ConnectedApp | undefined {
  initApps();
  return apps.get(name.toLowerCase().trim());
}

/**
 * Mapa do app para o modelo se orientar: collections reais do banco +
 * descrições configuradas. Pronto para tool result.
 */
export async function describeApp(appName: string): Promise<string> {
  const app = getConnectedApp(appName);
  if (!app) {
    const names = listConnectedApps().map((a) => a.name);
    return names.length
      ? `App "${appName}" não existe. Conectados: ${names.join(', ')}.`
      : 'Nenhum app conectado (defina CONNECTED_APPS no ambiente).';
  }
  try {
    const cols = await app.db.listCollections();
    const lines = cols.map((c) => {
      const desc = app.collections[c.id];
      return `- ${c.id}${desc ? ` — ${desc}` : ''}`;
    });
    return `App "${app.name}" (${app.description}). Collections:\n${lines.join('\n')}`;
  } catch (err) {
    console.error(`[apps] listCollections falhou em "${app.name}":`, err);
    const known = Object.entries(app.collections).map(([c, d]) => `- ${c} — ${d}`);
    return known.length
      ? `App "${app.name}" (${app.description}). Collections configuradas:\n${known.join('\n')}`
      : `Não consegui listar as collections do app "${app.name}".`;
  }
}

/**
 * Consulta READ-ONLY genérica: igualdade em até 3 campos + limite (máx 20).
 * Documentos vêm resumidos (JSON truncado) para caber no contexto do modelo.
 */
export async function queryApp(
  appName: string,
  colecao: string,
  filtros: Record<string, unknown> = {},
  limite = 10
): Promise<string> {
  const app = getConnectedApp(appName);
  if (!app) {
    const names = listConnectedApps().map((a) => a.name);
    return names.length
      ? `App "${appName}" não existe. Conectados: ${names.join(', ')}.`
      : 'Nenhum app conectado (defina CONNECTED_APPS no ambiente).';
  }
  if (!colecao.trim()) return 'Informe a collection a consultar (use explorar_app para ver o mapa).';

  try {
    let q: admin.firestore.Query = app.db.collection(colecao.trim());
    const entries = Object.entries(filtros).slice(0, 3);
    for (const [campo, valor] of entries) {
      q = q.where(campo, '==', valor);
    }
    const cap = Math.min(Math.max(1, Math.floor(limite) || 10), 20);
    const snap = await q.limit(cap).get();
    if (snap.empty) {
      return `Nenhum documento em "${colecao}"${entries.length ? ' com esses filtros' : ''}.`;
    }
    const docs = snap.docs.map((d) => `- ${d.id}: ${JSON.stringify(d.data()).slice(0, 400)}`);
    return `${snap.size} documento(s) de "${colecao}" no app "${app.name}":\n${docs.join('\n')}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[apps] consulta falhou (${app.name}/${colecao}):`, msg);
    return `A consulta em "${colecao}" falhou: ${msg.slice(0, 300)}`;
  }
}
