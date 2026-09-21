# Skill da Alexa — configuração e testes

Esta pasta guarda os artefatos da Skill "Agente Igor". O código que responde
por ela vive no backend, em `src/alexa/` e `src/routes/alexa.ts`.

A Skill é **privada, em modo de desenvolvimento**. Ela não é publicada e só
funciona nos dispositivos logados na mesma conta Amazon do console.

## Dados da Skill

| | |
|---|---|
| Nome de invocação | `agente igor` |
| Idioma | Português (BR) |
| Skill ID | `amzn1.ask.skill.42289c43-150c-4ced-9e4f-2fe2b2bc2fe7` |
| Endpoint | `https://agente.ntagroupvps.com.br/alexa` |
| Hospedagem | própria (o backend que já atende WhatsApp e painel) |

## 1. Carregar o modelo de interação

No console da Alexa, na Skill:

1. **Build** > **Interaction Model** > **JSON Editor**.
2. Apague o conteúdo e cole o arquivo
   `skill-package/interactionModels/custom/pt-BR.json`.
3. **Save Model** e depois **Build Model**. O build leva um ou dois minutos.

## 2. Apontar o endpoint

1. **Build** > **Endpoint**.
2. Marque **HTTPS**.
3. Em *Default Region*, cole `https://agente.ntagroupvps.com.br/alexa`.
4. No seletor de certificado, escolha
   **My development endpoint is a sub-domain of a domain that has a wildcard
   certificate from a certificate authority**.
5. **Save Endpoints**.

## 3. Ligar no backend

As variáveis vivem no ambiente do container, nunca no código. A ordem importa:
a rota só executa ações de agenda depois que a conta autorizada estiver
registrada.

```env
ALEXA_ENABLED=true
ALEXA_SKILL_ID=amzn1.ask.skill.42289c43-150c-4ced-9e4f-2fe2b2bc2fe7
ALEXA_ALLOWED_USER_ID=
ALEXA_CAPTURE_USER_ID=true
```

Com `ALEXA_ALLOWED_USER_ID` vazio, qualquer pedido é recusado com
"a conta autorizada ainda não foi configurada" — é o estado seguro.

## 4. Capturar o ID da conta

O identificador da conta Amazon só existe depois da primeira requisição real.

1. Com a captura ligada, diga no Echo: **"Alexa, abra agente igor"**.
2. Nos logs do container vai aparecer uma linha
   `[alexa] CAPTURA DE ID LIGADA — userId completo: amzn1.ask.account...`.
3. Copie esse valor para `ALEXA_ALLOWED_USER_ID`.
4. **Desligue** `ALEXA_CAPTURE_USER_ID` (`false`) e reinicie.
5. Confira que os logs seguintes mostram o ID mascarado (`amzn1.ask…abcd`).

Esse identificador **muda** se a Skill for desabilitada e habilitada de novo no
aplicativo Alexa. Quando isso acontecer, a Skill passa a responder "esta skill
não está autorizada para esta conta" — repita esta seção.

## 5. Testar

No console, aba **Test**, mude o seletor de *Off* para **Development**. Dá para
digitar em vez de falar.

Roteiro mínimo:

| Diga | Esperado |
|---|---|
| abrir agente igor | "Olá, Igor. O que você quer fazer com sua agenda?" |
| o que eu tenho hoje | a agenda de hoje, ou "você não tem nada hoje" |
| o que eu tenho amanhã | a agenda de amanhã |
| tenho algo sexta à tarde | só os compromissos da tarde de sexta |
| quais são meus próximos compromissos | os próximos sete dias |
| ajuda | o que a Skill sabe fazer |
| para | "Até mais" |

## 6. Testar sem a Alexa

O backend tem um teste que sobe só a rota localmente e dispensa a assinatura
(que não pode ser reproduzida fora do dispositivo):

```bash
ALEXA_ENABLED=true ALEXA_SKIP_SIGNATURE=true ALEXA_SKILL_ID=amzn1.ask.skill.42289c43-150c-4ced-9e4f-2fe2b2bc2fe7 ALEXA_ALLOWED_USER_ID=amzn1.account.TESTE npm run smoke:alexa
```

`ALEXA_SKIP_SIGNATURE` **nunca** pode ficar ligado em produção: sem a validação
de assinatura, qualquer um na internet consegue falar com a rota.

## 7. Desligar

```env
ALEXA_ENABLED=false
```

Depois do restart a rota deixa de executar qualquer coisa. WhatsApp, painel e
agenda seguem funcionando normalmente. Não é preciso remover código nem mexer
na Skill no console.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| "não encontrei essa skill" no Echo | o Echo está em outra conta Amazon |
| a Skill abre e dá erro na hora | corpo bruto perdido — rode `npm run smoke:alexa` |
| "esta skill não está autorizada para esta conta" | o ID da conta mudou; refaça a seção 4 |
| "a integração com a agenda está desligada" | `ALEXA_ENABLED` não está `true` no container |
| "esta requisição não é desta skill" | `ALEXA_SKILL_ID` diferente do console |
| "houve um problema com a resposta da skill" | resposta passou do tempo; ver os avisos de resposta lenta nos logs |
