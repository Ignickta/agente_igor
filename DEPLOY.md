# Deploy do backend (agente-igor) na VPS

Guia rápido para colocar o backend em produção depois de mergear no `main`.

> **Lembrete:** merge/push no `main` **NÃO** coloca nada no ar. É preciso rodar
> o deploy manualmente na VPS. (O front `agente-igor-web` é auto-deploy no push;
> só o backend exige este passo.)

## 1. Fazer o deploy (na VPS, via SSH)

```bash
bash /opt/agente-igor/deploy.sh
```

O `deploy.sh` faz `git reset --hard origin/main` + rebuild + restart — ou seja,
sobe **exatamente o que está no `main` do GitHub**. Se o código estiver num
branch de feature, mergeie no `main` primeiro (o reset descarta qualquer coisa
que não esteja no `main`).

## 2. Confirmar que subiu (na VPS)

```bash
curl http://localhost:3001/health
```

Deve responder algo como `{"status":"up","version":"...","startedAt":"..."}`.

### Observações

- O health é sempre na porta **3001** (não a 3000 — `curl localhost:3000` na VPS
  devolve o HTML do Easypanel, não o agente).
- No fim do `deploy.sh` o healthcheck às vezes falha com *"connection reset"*
  porque o container acabou de subir. **Não é erro**: espere alguns segundos e
  rode o `curl .../health` de novo.
- Diretório do projeto na VPS: **`/opt/agente-igor`** (não `~/agente-igor`).
- Repositório: `Ignickta/agente_igor` (com "e").
