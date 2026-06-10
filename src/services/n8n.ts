import axios from 'axios';
import { config } from '../config';

/**
 * Ponte com o n8n: o agente pode disparar workflows do Igor via webhook.
 * As automações disponíveis vêm de N8N_WEBHOOKS (nome=url;...), então
 * adicionar uma nova automação é só editar a env — sem mexer no código.
 */

/** Nomes das automações configuradas. */
export function listAutomations(): string[] {
  return Object.keys(config.n8n.webhooks);
}

/**
 * Dispara a automação `name` com um payload livre. Retorna um resumo textual
 * (sucesso ou erro) pronto para virar resultado de tool — nunca lança.
 */
export async function triggerAutomation(name: string, dados?: unknown): Promise<string> {
  const url = config.n8n.webhooks[name];
  if (!url) {
    const names = listAutomations();
    return names.length
      ? `Automação "${name}" não existe. Disponíveis: ${names.join(', ')}.`
      : 'Nenhuma automação n8n configurada (defina N8N_WEBHOOKS no ambiente).';
  }

  try {
    const res = await axios.post(
      url,
      {
        origem: 'agente-igor',
        automacao: name,
        dados: dados ?? null,
        disparadoEm: new Date().toISOString(),
      },
      {
        timeout: 20000,
        headers: config.n8n.token ? { Authorization: `Bearer ${config.n8n.token}` } : {},
      }
    );
    const body =
      typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '');
    const resumo = body && body !== '{}' ? ` Resposta: ${body.slice(0, 600)}` : '';
    return `Automação "${name}" disparada com sucesso.${resumo}`;
  } catch (err) {
    const detalhe = axios.isAxiosError(err)
      ? `${err.response?.status ?? ''} ${JSON.stringify(err.response?.data ?? err.message).slice(0, 300)}`
      : err instanceof Error
        ? err.message
        : String(err);
    console.error(`[n8n] falha ao disparar "${name}":`, detalhe);
    return `A automação "${name}" falhou: ${detalhe}`;
  }
}
