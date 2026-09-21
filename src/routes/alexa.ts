import express, { Request, Response, Router } from 'express';
import { authenticate, maskUserId, rejectionSpeech } from '../alexa/auth';
import { handleAlexaRequest } from '../alexa/handler';
import { tell } from '../alexa/responses';

/**
 * Rota que recebe a Alexa.
 *
 * Duas coisas aqui são diferentes de todas as outras rotas do servidor e não
 * podem ser "arrumadas" depois:
 *
 * 1. O CORPO CHEGA BRUTO. A Amazon assina os bytes exatos que enviou; o
 *    interpretador de JSON global lê e descarta esse texto, e sem ele a
 *    assinatura nunca confere. Por isso esta rota usa seu próprio leitor e é
 *    montada ANTES do interpretador global no servidor.
 *
 * 2. A RESPOSTA É SÍNCRONA. O webhook do WhatsApp responde na hora e processa
 *    depois; aqui não dá — a Alexa está esperando o que falar, e desiste em
 *    torno de oito segundos.
 *
 * O limite de corpo é pequeno de propósito: o limite global de 25 MB existe por
 * causa de mídia do WhatsApp e, numa rota pública, só serviria de convite.
 */

const router = Router();

/** Orçamento de resposta. Acima disso a Alexa já desistiu de esperar. */
const SLOW_REQUEST_MS = 3000;

router.post(
  '/',
  express.raw({ type: () => true, limit: '128kb' }),
  async (req: Request, res: Response) => {
    const started = Date.now();
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';

    let auth;
    try {
      auth = await authenticate(rawBody, req.headers);
    } catch (err) {
      console.error('[alexa] erro inesperado na autenticação:', err);
      return res.status(400).json(tell('Não consegui validar esta requisição.'));
    }

    if (!auth.ok) {
      console.warn(
        `[alexa] rejected reason=${auth.reason} durationMs=${Date.now() - started}` +
          (auth.detail ? ` detail=${auth.detail}` : '')
      );
      // Recusa por assinatura/carimbo não ganha resposta falada: se não veio da
      // Amazon, não há com quem conversar.
      if (auth.reason === 'invalid_signature' || auth.reason === 'stale_timestamp') {
        return res.status(400).send('invalid request signature');
      }
      if (auth.reason === 'malformed_body') return res.status(400).send('malformed body');
      return res.json(tell(rejectionSpeech(auth.reason)));
    }

    const { envelope } = auth;
    const intent = envelope.request.intent?.name ?? envelope.request.type;

    try {
      const response = await handleAlexaRequest(envelope);
      const durationMs = Date.now() - started;
      console.log(
        `[alexa] request intent=${intent} requestId=${envelope.request.requestId} ` +
          `user=${maskUserId(auth.userId)} durationMs=${durationMs}`
      );
      if (durationMs > SLOW_REQUEST_MS) {
        console.warn(`[alexa] resposta lenta (${durationMs}ms) em ${intent} — risco de timeout`);
      }
      // `null` = fim de sessão: o protocolo não admite resposta aqui, nem vazia.
      if (response === null) return res.status(200).end();
      return res.json(response);
    } catch (err) {
      console.error(`[alexa] error intent=${intent} requestId=${envelope.request.requestId}`, err);
      // Nunca afirmar sucesso quando não se sabe se a escrita aconteceu.
      return res.json(tell('Não consegui acessar sua agenda agora. Nada foi alterado.'));
    }
  }
);

export default router;
