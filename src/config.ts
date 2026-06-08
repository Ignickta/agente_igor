import dotenv from 'dotenv';

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

export const config = {
  evolution: {
    apiUrl: required('EVOLUTION_API_URL').replace(/\/$/, ''),
    apiKey: required('EVOLUTION_API_KEY'),
    instance: required('EVOLUTION_INSTANCE'),
  },
  openai: {
    apiKey: required('OPENAI_API_KEY'),
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1',
  },
  firebase: {
    projectId: required('FIREBASE_PROJECT_ID'),
    clientEmail: required('FIREBASE_CLIENT_EMAIL'),
    // Normaliza \n literais vindos do .env
    privateKey: required('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n'),
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
  },
  ownerPhone: process.env.OWNER_PHONE || '',
  timezone: process.env.TZ || 'America/Sao_Paulo',
  adminToken: process.env.ADMIN_TOKEN || '',
  /**
   * Números autorizados a conversar com o agente (só dígitos, separados por vírgula).
   * Se vazio, cai no OWNER_PHONE. O dono é sempre incluído automaticamente.
   * Qualquer mensagem de número fora desta lista é ignorada.
   */
  allowedNumbers: (process.env.ALLOWED_NUMBERS || '')
    .split(',')
    .map((n) => n.replace(/\D/g, ''))
    .filter(Boolean),
};

/** Retorna a lista efetiva de números permitidos (allowlist + dono). */
export function getAllowedNumbers(): string[] {
  const set = new Set(config.allowedNumbers);
  if (config.ownerPhone) set.add(config.ownerPhone);
  return [...set];
}

/** True se o contato pode conversar com o agente. Lista vazia = libera (dev). */
export function isAllowed(contact: string): boolean {
  const allowed = getAllowedNumbers();
  if (allowed.length === 0) return true;
  return allowed.includes(contact.replace(/\D/g, ''));
}
