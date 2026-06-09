import dotenv from 'dotenv';

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

/**
 * Normaliza a private key do Firebase para PEM válido.
 *
 * Dependendo de como a env é carregada (dotenv local vs. `docker run --env-file`),
 * a chave pode chegar:
 *  - envolta em aspas literais (" ou ');
 *  - com `\n` literais em vez de quebras reais;
 *  - com `\r\n` (CRLF) se o arquivo foi salvo no Windows.
 * Esta função cobre todos esses casos e valida o resultado.
 */
function normalizePrivateKey(raw: string): string {
  let key = raw.trim();

  // Remove aspas externas que o --env-file pode ter mantido no valor.
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }

  // Converte \n e \r\n literais em quebras de linha reais e remove CRs.
  key = key.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r/g, '');

  if (!key.includes('-----BEGIN') || !key.includes('PRIVATE KEY-----')) {
    throw new Error(
      'FIREBASE_PRIVATE_KEY inválida: não parece um PEM. Verifique aspas e quebras de linha (\\n) no .env.'
    );
  }

  return key;
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
    // Modelo usado pelo ResearchAgent com a tool nativa web_search_preview.
    researchModel: process.env.OPENAI_RESEARCH_MODEL || process.env.OPENAI_MODEL || 'gpt-4o',
    transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1',
    ttsModel: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
    ttsVoice: process.env.OPENAI_TTS_VOICE || 'alloy',
  },
  firebase: {
    projectId: required('FIREBASE_PROJECT_ID'),
    clientEmail: required('FIREBASE_CLIENT_EMAIL'),
    // Normaliza aspas, \n literais e CRLF vindos do .env / docker --env-file
    privateKey: normalizePrivateKey(required('FIREBASE_PRIVATE_KEY')),
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
  },
  ownerPhone: process.env.OWNER_PHONE || '',
  timezone: process.env.TZ || 'America/Sao_Paulo',
  adminToken: process.env.ADMIN_TOKEN || '',
  /**
   * Kill-switch das mensagens proativas (resumo noturno, revisão semanal,
   * relatórios, notificações proativas). Desligue com PROACTIVE_NOTIFICATIONS=off
   * para silenciar todas de uma vez sem mexer no código.
   */
  proactiveNotifications: (process.env.PROACTIVE_NOTIFICATIONS || 'on').toLowerCase() !== 'off',
  /** Carga máxima estimada de trabalho por dia (minutos) antes de avisar sobrecarga. */
  maxDailyWorkMinutes: parseInt(process.env.MAX_DAILY_WORK_MINUTES || '480', 10),
  /** Palavras que marcam uma mensagem como urgente (passam mesmo em modo foco). */
  urgentKeywords: (process.env.URGENT_KEYWORDS || 'urgente,urgência,urgencia,emergência,emergencia,agora,imediato')
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean),
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
