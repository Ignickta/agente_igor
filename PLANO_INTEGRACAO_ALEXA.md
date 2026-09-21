# Plano de implementação — Alexa no Agente Igor

**Status:** planejamento  
**Escopo:** uso pessoal e exclusivo do Igor  
**Frase de entrada pretendida:** “Alexa, abra Agente Igor”  
**Dependência do Google Calendar:** nenhuma  
**Backend atual:** Node.js, TypeScript, Express, Firestore

## 1. Resumo executivo

O objetivo é permitir que o Igor converse com a agenda do Agente Igor usando um dispositivo Alexa. A primeira versão será uma **Custom Skill privada/em desenvolvimento**, em português do Brasil, que acessará diretamente a agenda interna já persistida no Firestore.

O fluxo principal será:

```text
Igor
  ↓ voz
Alexa / Skill “Agente Igor”
  ↓ HTTPS assinado pela Amazon
POST /alexa
  ↓ intents e diálogos
Serviço de ações da agenda
  ↓
Firestore (agenda e tarefas)
```

O Google Calendar não fará parte do caminho obrigatório. Caso seja ativado futuramente, continuará sendo apenas um espelho opcional da agenda interna.

A primeira entrega permitirá:

- abrir a Skill;
- consultar compromissos de hoje, amanhã ou de uma data específica;
- consultar os próximos compromissos;
- criar um compromisso com título, data, hora inicial e duração;
- remarcar um compromisso existente;
- cancelar um compromisso;
- resolver ambiguidades por diálogo;
- confirmar por voz toda operação destrutiva ou que altere a agenda;
- impedir duplicações quando a Alexa repetir uma requisição.

## 2. Decisões já tomadas

### 2.1 Uso pessoal e conta única

A integração será construída para um único proprietário. Não será criado, no MVP, um sistema genérico de cadastro, organizações, múltiplos calendários ou múltiplos perfis.

Isso simplifica a autorização, mas não elimina a necessidade de autenticar as requisições. O endpoint será público na internet e deve aceitar somente:

1. requisições com assinatura válida da Alexa;
2. requisições destinadas ao ID exato da Skill;
3. o `userId` da conta Amazon autorizada;
4. requisições recentes, protegidas contra repetição.

### 2.2 Sem Google Calendar no MVP

A Skill consultará e alterará diretamente as coleções internas `agenda` e, quando aplicável, `tasks`.

O comportamento esperado é:

- sem `GOOGLE_CALENDAR_ID`, todas as funções da Alexa continuam funcionando;
- se o Google Calendar for ativado futuramente, os eventos fixos poderão continuar sendo propagados pelo mecanismo já existente;
- nenhuma resposta da Skill dependerá da disponibilidade da API do Google.

### 2.3 Invocação explícita

O uso começará com uma invocação explícita:

> “Alexa, abra Agente Igor.”

Após abrir a Skill, a sessão pode continuar:

> Alexa: “Olá, Igor. O que você quer fazer com sua agenda?”  
> Igor: “O que eu tenho amanhã?”

Também serão testadas frases de uma etapa, quando aceitas pelo modelo de interação:

> “Alexa, peça ao Agente Igor para ler minha agenda de amanhã.”

O nome de invocação definitivo precisa ser validado no console da Alexa, pois nomes de Skill estão sujeitos às regras fonéticas e de certificação da Amazon.

### 2.4 Conta Amazon única para desenvolver e usar

Uma Skill em modo de desenvolvimento **não** é publicada na loja. Ela só fica
disponível nos dispositivos e aplicativos Alexa logados na **mesma conta Amazon
usada para criar a Skill no console de desenvolvedor**.

Decisão: a conta do desenvolvedor e a conta do Echo do Igor serão a mesma. Isso
é o que torna o MVP viável sem publicação, sem *beta test* e sem *account
linking*.

Consequências que precisam ficar registradas:

- não é necessário convidar testadores nem distribuir a Skill;
- o Echo precisa estar logado nessa conta **antes** de qualquer teste de voz —
  em outra conta a Skill simplesmente não aparece, e a Alexa responde algo como
  "não encontrei essa skill", sem nenhum erro no backend para diagnosticar;
- se um dia a Skill precisar rodar em outra conta (outro morador, outro Echo),
  aí sim entram *beta test* ou publicação, e a restrição por usuário descrita
  em 9.2 precisa ser revista.

## 3. Objetivos e não objetivos

### 3.1 Objetivos do MVP

- Experiência inteiramente em `pt-BR`.
- Respostas curtas e adequadas para áudio.
- Reutilização das regras atuais da agenda.
- Alterações confirmadas antes da gravação.
- Consulta determinística, sem depender de LLM.
- Tratamento seguro de datas relativas usando `config.timezone`.
- Busca de compromissos por título aproximado, data e horário.
- Logs suficientes para diagnosticar falhas sem registrar dados sensíveis desnecessários.
- Testes automatizados dos casos críticos.

### 3.2 Fora do MVP

- Publicação pública na loja de Skills.
- Suporte a múltiplas contas Amazon.
- OAuth ou cadastro de usuários.
- Uso dos comandos nativos de calendário da Alexa sem mencionar a Skill.
- Notificações proativas emitidas pela Alexa.
- Criação de compromissos recorrentes por voz.
- Convites para outras pessoas ou envio de e-mails.
- Localização, videoconferência e lista de participantes.
- Agenda de dia inteiro.
- Controle de outros recursos do Agente Igor além da agenda.

Esses itens podem ser incorporados depois, sem alterar a arquitetura básica.

## 4. Estado atual relevante do sistema

O backend já possui os componentes necessários para persistência e boa parte das regras de negócio:

- `src/index.ts`: servidor Express e registro das rotas;
- `src/services/firebase.ts`: CRUD da coleção `agenda`;
- `src/agents/orchestrator.ts`: consultas e formatação de visões da agenda;
- `src/agents/subagents/index.ts`: ferramentas atuais para criar, listar, editar e remover eventos;
- `src/services/datetime.ts`: conversão de datas no fuso configurado;
- `src/services/googleCalendar.ts`: integração opcional e tolerante a falhas;
- `src/agents/undo.ts`: histórico e reversão de ações;
- `src/types.ts`: modelo `AgendaItem`.

Um compromisso de hora marcada deve continuar sendo representado como:

```ts
{
  title: string;
  date: "YYYY-MM-DD";
  startTime: "HH:mm";
  endTime: "HH:mm";
  priority: 1;
  type: "event";
  status: "pending";
  createdBy: "user";
}
```

`priority: 1` e `createdBy: "user"` são importantes porque tornam o compromisso fixo, impedindo que o reorganizador do cronograma o mova automaticamente.

## 5. Arquitetura proposta

### 5.1 Componentes novos

```text
src/
├── alexa/
│   ├── handler.ts              # Dispatcher de LaunchRequest/IntentRequest
│   ├── intents.ts              # Handlers dos intents da agenda
│   ├── responses.ts            # Textos e respostas JSON da Alexa
│   ├── session.ts              # Contexto temporário e desambiguação
│   ├── auth.ts                 # Skill ID, user ID e validações adicionais
│   └── types.ts                # Tipos locais da integração
├── routes/
│   └── alexa.ts                # POST /alexa
└── services/
    └── agendaActions.ts        # Regras compartilhadas de consulta/mutação
```

Também serão adicionados ao repositório os artefatos da Skill:

```text
alexa-skill/
├── skill-package/
│   ├── skill.json              # Manifesto da Skill
│   └── interactionModels/
│       └── custom/
│           └── pt-BR.json      # Intents, slots e frases de exemplo
└── README.md                   # Como configurar e testar no console Alexa
```

### 5.2 Camada compartilhada de agenda

Hoje algumas regras de mutação estão implementadas dentro do executor de ferramentas do WhatsApp. A Alexa não deve simular uma mensagem de WhatsApp nem chamar `/admin` usando `ADMIN_TOKEN`.

Será extraído um serviço reutilizável, por exemplo `agendaActions.ts`, com operações como:

```ts
listAppointments(input): Promise<AgendaSummary>
createAppointment(input, context): Promise<CreateResult>
findAppointmentCandidates(input): Promise<AgendaItem[]>
rescheduleAppointment(input, context): Promise<UpdateResult>
cancelAppointment(input, context): Promise<CancelResult>
```

Esse serviço concentrará:

- validação de data e horário;
- duração padrão;
- detecção de sobreposição;
- idempotência;
- propagação para uma `Task` vinculada;
- incremento de `postponedCount`, quando aplicável;
- integração opcional com Google Calendar, se um dia for ativada;
- registro de auditoria e operação de desfazer;
- mensagens de resultado estruturadas.

WhatsApp, painel e Alexa poderão chamar a mesma camada gradualmente. Isso evita comportamentos diferentes entre canais.

### 5.3 Endpoint da Alexa

Será registrada uma rota dedicada:

```http
POST /alexa
Content-Type: application/json
```

Essa rota **não** usará `x-admin-token`, porque a Alexa não enviará o token administrativo. Ela terá sua própria validação baseada no protocolo oficial da Amazon.

O servidor deve responder de forma síncrona com o JSON esperado pela Alexa. Trabalhos externos não devem ser enviados para uma fila com resposta `200` antecipada, como ocorre atualmente no webhook do WhatsApp.

#### 5.3.1 Corpo bruto da requisição (bloqueador)

A Amazon assina o **corpo exato**, byte a byte, que enviou. A validação
compara essa assinatura com o texto original recebido — não com o objeto já
interpretado.

O servidor atual registra um interpretador de JSON global logo na inicialização,
antes de todas as rotas. Ele lê o corpo, transforma em objeto e **descarta o
texto original**. Se a rota da Alexa for adicionada assim, sem nenhuma outra
providência, a validação de assinatura falhará em 100% das requisições, mesmo
com Skill ID, usuário e certificado corretos — e o sintoma será a Skill abrindo
e respondendo erro imediatamente, sem pista óbvia da causa.

Providências obrigatórias:

- preservar o corpo bruto da rota `/alexa`, seja registrando a rota com um
  leitor de corpo próprio **antes** do interpretador global, seja guardando o
  buffer original durante a interpretação;
- garantir que o buffer preservado seja exatamente o recebido, sem
  reserialização, reordenação de chaves ou mudança de codificação;
- aplicar à rota um limite de tamanho próprio e pequeno (o limite global de
  25 MB existe por causa de mídia do WhatsApp e não faz sentido aqui);
- incluir um teste que envie um corpo assinado conhecido e confirme que a
  validação passa — sem esse teste a falha só aparece no dispositivo real.

Em desenvolvimento, quando não há como produzir uma assinatura válida, a
validação pode ser dispensada por uma variável exclusiva de ambiente local, que
nunca deve existir em produção e que precisa ser registrada em log a cada
requisição aceita por esse caminho.

### 5.4 Dependências sugeridas

Preferencialmente usar os pacotes oficiais do Alexa Skills Kit para Node.js:

- `ask-sdk-core`;
- adaptador Express oficial ou uma integração equivalente mantida pela Amazon.

Antes da implementação será confirmada a compatibilidade da versão corrente dos pacotes com Node.js e Express usados no projeto.

O SDK deve cuidar da estrutura das respostas e parte da validação do protocolo. As restrições locais de Skill ID e usuário continuarão explícitas no código.

### 5.5 Orçamento de tempo de resposta

A Alexa encerra a requisição em torno de **8 segundos**. Estourar esse limite
faz a Skill responder "houve um problema com a resposta da skill solicitada",
mesmo que a escrita tenha sido concluída no backend — o que é pior do que uma
falha limpa, porque o Igor não saberá se o compromisso foi gravado.

Regras:

- meta de resposta: **até 3 segundos** no caminho completo, incluindo Firestore;
- nada de LLM, transcrição, Google Calendar ou chamada de rede externa no
  caminho crítico;
- a rota responde de forma síncrona; ao contrário do webhook do WhatsApp, não
  existe a opção de confirmar cedo e processar depois;
- se uma operação passar do orçamento, responder sem afirmar sucesso
  ("não consegui confirmar agora") e deixar que a idempotência descrita na
  seção 10 resolva a repetição;
- medir e registrar a duração de cada requisição desde o início (seção 14), para
  detectar degradação antes que ela vire timeout.

### 5.6 Endereço público e certificado

A Skill precisa de um endereço público fixo, em HTTPS, com certificado emitido
por autoridade reconhecida. Certificado autoassinado exige configuração
específica no console e não será usado.

A definir e registrar na Fase 0:

- o domínio público do backend e o caminho completo do endpoint
  (`https://<domínio>/alexa`);
- confirmação de que o proxy da hospedagem encaminha esse caminho para a porta
  interna do container e **não** altera o corpo da requisição;
- confirmação de que o certificado é válido e renova sozinho;
- que o endpoint responde a `POST` e que qualquer outro método é rejeitado.

## 6. Modelo de interação em português

### 6.1 Intents do MVP

#### `ConsultarAgendaIntent`

Objetivo: ler compromissos de um período.

Slots:

- `data`: data solicitada;
- `periodo`: hoje, amanhã, semana ou próximos dias;
- `hora`: opcional, para filtrar um horário.

Exemplos:

- “qual é a minha agenda de hoje”;
- “o que eu tenho amanhã”;
- “tenho algo sexta-feira”;
- “quais são meus próximos compromissos”;
- “o que eu tenho hoje à tarde”.

#### `CriarCompromissoIntent`

Objetivo: criar um evento fixo na agenda.

Slots:

- `titulo`;
- `data`;
- `horaInicio`;
- `duracao` ou `horaFim`.

Exemplos:

- “marque dentista amanhã às dez”;
- “agende reunião com João sexta às três da tarde”;
- “coloque almoço com Pedro dia vinte e dois ao meio-dia por uma hora”.

Regras:

- título, data e hora inicial são obrigatórios;
- se não houver duração, perguntar: “Quanto tempo devo reservar?”;
- como conveniência futura, uma duração padrão de 60 minutos pode ser habilitada, mas o MVP deve preferir perguntar para evitar suposições;
- antes de gravar, repetir título, data, início e fim e solicitar confirmação.

#### `RemarcarCompromissoIntent`

Objetivo: localizar um compromisso e mudar sua data e/ou horário.

Slots:

- `tituloBusca`;
- `dataOriginal`, opcional;
- `horaOriginal`, opcional;
- `novaData`;
- `novaHora`;
- `novaDuracao`, opcional.

Exemplos:

- “remarque o dentista para sexta às onze”;
- “mude a reunião com João de amanhã para segunda às nove”;
- “passe o compromisso das três para as quatro”.

Regras:

- se houver exatamente um candidato plausível, apresentá-lo para confirmação;
- se houver mais de um candidato, ler no máximo três opções e pedir escolha;
- preservar a duração original quando apenas o início mudar;
- validar se o novo horário termina depois do início;
- avisar sobre conflito com outro compromisso e pedir confirmação específica se a sobreposição for permitida.

#### `CancelarCompromissoIntent`

Objetivo: remover um compromisso.

Slots:

- `tituloBusca`;
- `dataOriginal`, opcional;
- `horaOriginal`, opcional.

Exemplos:

- “cancele o dentista de amanhã”;
- “remova o compromisso das quatro”;
- “apague a reunião com João”.

O cancelamento sempre exigirá confirmação explícita.

#### Intents auxiliares

- `AMAZON.HelpIntent`;
- `AMAZON.CancelIntent`;
- `AMAZON.StopIntent`;
- `AMAZON.FallbackIntent`;
- `AMAZON.YesIntent` e `AMAZON.NoIntent`, obrigatórios, já que a confirmação é controlada pela aplicação (ver 6.4);
- tratamento de `LaunchRequest` e `SessionEndedRequest`.

### 6.2 Slots e normalização

O modelo usará tipos nativos da Alexa para data, hora e duração quando estiverem disponíveis em `pt-BR`. O título será texto livre ou um slot customizado apropriado.

Valores da Alexa serão convertidos para o formato interno:

```text
data       → YYYY-MM-DD
início     → HH:mm
fim        → HH:mm
duração    → minutos
timezone   → config.timezone
```

Valores especiais de data retornados pela Alexa, como semana ou fim de semana, não devem ser enviados diretamente ao Firestore. Uma função de normalização converterá cada valor para um intervalo concreto.

#### 6.2.1 Título junto com data e hora (ponto frágil)

A frase mais natural do MVP — "marque dentista amanhã às dez" — é também a mais
difícil para o modelo de interação, porque mistura **texto livre** com data e
hora na mesma fala.

Os slots de texto livre da Alexa têm restrições de uso e capturam de forma
gulosa: ao ouvir "dentista amanhã às dez" é comum o título vir como "dentista
amanhã às dez" inteiro, ou a data ser engolida pelo título. Isso não é
configurável por tentativa e erro infinito — precisa de um plano B decidido
desde já.

Estratégia adotada:

1. **Preferida:** slot de título restrito, com uma lista de valores
   representativos dos compromissos recorrentes do Igor (dentista, academia,
   reunião, almoço, médico, aula...), permitindo valores fora da lista. Dá muito
   mais precisão na separação dos campos.
2. **Plano B, se a captura continuar ruim:** quebrar em duas etapas — a frase de
   abertura carrega data e hora, e a Alexa pergunta o nome do compromisso
   separadamente ("Qual é o nome do compromisso?"). Mais lento, porém confiável.
3. Manter as duas formas no modelo: frase completa para quando funcionar, frase
   curta ("marque um compromisso amanhã às dez") sempre disponível.

A confirmação final (seção 6.4) é a rede de proteção: mesmo que o título saia
errado, o Igor ouve o que será gravado antes de qualquer escrita.

#### 6.2.2 Verificação dos tipos nativos em pt-BR

Nem todo tipo nativo de slot e nem todo intent padrão existem em todos os
idiomas. Antes de escrever o modelo de interação, confirmar no console, em
`pt-BR`, a disponibilidade de:

- tipo de data e tipo de hora;
- tipo de duração — se não houver, a duração será um slot customizado em
  palavras ("meia hora", "uma hora", "duas horas") ou um número seguido de
  unidade;
- `AMAZON.FallbackIntent` — se não houver, o tratamento de frase não entendida
  precisa de outra abordagem.

Descobrir isso na Fase 0 evita refazer o modelo de interação depois.

### 6.3 Respostas adequadas para voz

A resposta falada deve ser mais curta que a resposta do WhatsApp.

Exemplo de consulta:

> “Amanhã você tem dois compromissos: dentista às dez e reunião com João às quinze. Quer fazer mais alguma coisa?”

Exemplo de confirmação:

> “Vou marcar dentista amanhã, das dez às onze. Posso confirmar?”

Exemplo após gravação:

> “Pronto. Dentista foi marcado amanhã às dez.”

Para listas longas:

- falar os três primeiros itens;
- informar quantos itens adicionais existem;
- oferecer a leitura do restante;
- não ler IDs, prioridades ou detalhes internos.

### 6.4 Onde a confirmação é controlada

Existem dois mecanismos possíveis de confirmação e **eles não devem ser
misturados**: a confirmação automática da própria Alexa, declarada no modelo de
interação, e a confirmação controlada pela aplicação, usando intents de sim e
não.

Decisão: **a confirmação é controlada pela aplicação.**

Motivos:

- o texto de confirmação precisa falar a data por extenso e sem ambiguidade
  (seção 12.3), o que a confirmação automática não faz;
- a confirmação reforçada de conflito de horário (seção 8.4) é uma segunda
  pergunta, com texto próprio, fora do que o mecanismo automático cobre;
- a desambiguação entre candidatos (seção 7.4) já exige estado nos atributos da
  sessão; concentrar tudo no mesmo lugar evita dois fluxos concorrentes;
- as mesmas regras poderão ser reaproveitadas pelo WhatsApp e pelo painel.

Consequências:

- o modelo de interação **não** marcará intents ou slots como exigindo
  confirmação automática;
- `AMAZON.YesIntent` e `AMAZON.NoIntent` são obrigatórios no modelo;
- o que está pendente de confirmação fica nos atributos da sessão, com carimbo
  de tempo, e é descartado quando a sessão termina;
- um "sim" sem nada pendente responde que não há o que confirmar, e nunca grava.

## 7. Fluxos conversacionais

### 7.1 Abrir e consultar

```text
Igor:  Alexa, abra Agente Igor.
Alexa: Olá, Igor. O que você quer fazer com sua agenda?
Igor:  O que eu tenho amanhã?
Alexa: Amanhã você tem dentista às dez e reunião com João às quinze.
```

Consultas são somente leitura e não exigem confirmação.

### 7.2 Criar compromisso

```text
Igor:  Marque uma reunião com João amanhã às três.
Alexa: Quanto tempo devo reservar?
Igor:  Uma hora.
Alexa: Vou marcar reunião com João amanhã, das quinze às dezesseis. Posso confirmar?
Igor:  Sim.
Alexa: Pronto. Reunião com João foi marcada.
```

A gravação ocorre somente depois do “sim”.

### 7.3 Remarcar com candidato único

```text
Igor:  Remarque o dentista para sexta às onze.
Alexa: Encontrei dentista amanhã, das dez às onze. Quer mudar para sexta, das onze ao meio-dia?
Igor:  Sim.
Alexa: Pronto. O dentista foi remarcado.
```

### 7.4 Remarcar com ambiguidade

```text
Igor:  Remarque a reunião de amanhã.
Alexa: Encontrei duas: reunião comercial às nove e reunião com João às quinze. Qual delas?
Igor:  A reunião com João.
Alexa: Para qual dia e horário?
```

Os candidatos ficam guardados nos atributos da sessão, não em estado global do processo.

### 7.5 Cancelar

```text
Igor:  Cancele a reunião com João de amanhã.
Alexa: Quer cancelar reunião com João amanhã às quinze?
Igor:  Sim.
Alexa: Pronto. O compromisso foi cancelado.
```

### 7.6 Negação ou abandono

```text
Alexa: Posso confirmar?
Igor:  Não.
Alexa: Tudo bem. Nada foi alterado.
```

Se a sessão terminar antes da confirmação, nenhuma escrita será feita.

## 8. Busca e resolução de compromissos

A busca deve ser previsível e não depender inicialmente de um modelo de linguagem.

### 8.1 Ordem dos filtros

1. Intervalo de data informado.
2. Horário aproximado, se informado.
3. Título normalizado.
4. Estado diferente de `done` para alterações e cancelamentos.
5. Proximidade temporal, favorecendo o evento futuro mais próximo.

### 8.2 Normalização de título

- converter para minúsculas;
- remover acentos apenas para comparação;
- remover espaços repetidos;
- ignorar artigos simples quando isso ajudar;
- permitir correspondência parcial por palavras relevantes;
- nunca selecionar automaticamente quando dois resultados tiverem pontuação semelhante.

### 8.3 Janela padrão

Quando o Igor disser apenas “o dentista”, sem data:

- pesquisar primeiro de hoje até os próximos 30 dias;
- se não encontrar, informar isso e pedir uma data;
- não alterar compromissos passados por engano.

### 8.4 Conflitos de horário

Na criação ou remarcação, verificar a interseção:

```text
existente.startTime < novo.endTime
e
novo.startTime < existente.endTime
```

Se houver conflito:

> “Esse horário coincide com reunião comercial, das quinze às dezesseis. Ainda assim deseja marcar?”

O conflito não será bloqueado de forma absoluta, pois duas atividades simultâneas podem ser intencionais. Ele exigirá uma confirmação reforçada.

## 9. Segurança

Mesmo sendo uma Skill pessoal, o endpoint `/alexa` ficará exposto à internet. As proteções mínimas são obrigatórias.

### 9.1 Validação da origem

- validar a assinatura e a cadeia de certificados da requisição conforme o Alexa Skills Kit;
- validar o timestamp para rejeitar payloads antigos;
- validar `applicationId` contra `ALEXA_SKILL_ID`;
- rejeitar tipos de requisição não suportados;
- impor limite de tamanho ao corpo específico da rota.

Referências oficiais:

- [Security Requirements for Alexa Skills](https://developer.amazon.com/en-US/docs/alexa/custom-skills/security-testing-for-an-alexa-skill.html)
- [Handle Requests Sent by Alexa](https://developer.amazon.com/en-US/docs/alexa/custom-skills/handle-requests-sent-by-alexa.html)
- [Request and Response JSON Reference](https://developer.amazon.com/en-US/docs/alexa/custom-skills/request-and-response-json-reference.html)

### 9.2 Restrição ao proprietário

Adicionar variáveis:

```env
ALEXA_ENABLED=false
ALEXA_SKILL_ID=
ALEXA_ALLOWED_USER_ID=
```

Funcionamento:

- `ALEXA_ENABLED=false`: rota retorna indisponível sem processar ações;
- `ALEXA_SKILL_ID`: precisa corresponder à Skill criada;
- `ALEXA_ALLOWED_USER_ID`: depois da primeira execução controlada, registrar explicitamente o ID da conta autorizada;
- enquanto `ALEXA_ALLOWED_USER_ID` estiver vazio, permitir somente ambiente de desenvolvimento e nunca habilitar a rota em produção de forma aberta.

Não registrar o `userId` completo em logs comuns. Quando necessário, usar uma versão mascarada ou hash.

#### 9.2.1 Como capturar o ID autorizado

Há uma tensão real entre "nunca registrar o ID completo" e "configurar o ID
autorizado", já que ele só existe depois da primeira requisição vinda do
dispositivo. A resolução é tratar a captura como um passo único e explícito, e
não como um efeito colateral dos logs normais:

1. subir com `ALEXA_ENABLED=true` e `ALEXA_ALLOWED_USER_ID` vazio — nesse estado
   a rota valida assinatura e Skill ID, responde uma mensagem neutra e **não
   executa nenhuma ação de agenda**;
2. ligar uma flag temporária de captura, que registra o ID completo **uma única
   vez** e volta a desligar sozinha;
3. abrir a Skill uma vez no Echo;
4. copiar o ID do log, configurar `ALEXA_ALLOWED_USER_ID` e reiniciar;
5. apagar a linha de log correspondente e confirmar que os registros seguintes
   trazem apenas a versão mascarada.

A alternativa, se preferir não registrar o ID em momento algum, é comparar
hashes: configurar o hash esperado e deixar o backend rejeitar tudo que não
bater. Isso exige gerar o hash por fora e é mais trabalhoso na primeira vez.

#### 9.2.2 O ID pode mudar

O identificador de usuário da Alexa não é permanente: ele é regenerado quando a
Skill é desabilitada e habilitada de novo no aplicativo Alexa, e pode mudar em
outras situações de reinstalação.

Quando isso acontece, tudo continua aparentemente certo — assinatura válida,
Skill ID correto — mas todas as requisições passam a ser recusadas como conta
não autorizada. Sem isto documentado, o sintoma parece um bug aleatório.

Providências:

- a mensagem de recusa por usuário deve ser distinta das demais, para
  identificar a causa só de ouvir;
- o log de recusa deve dizer explicitamente o motivo `unauthorized_user`;
- o procedimento de recaptura é o mesmo de 9.2.1, e precisa estar no material de
  troubleshooting da Fase 6.

### 9.3 Privacidade de voz e respostas

- não persistir o payload completo da Alexa por padrão;
- registrar somente request ID, intent, resultado e duração;
- não falar dados sensíveis além do necessário;
- consultas longas devem evitar expor notas internas;
- a Skill acessará somente a agenda, não memórias, contatos comerciais ou dados de leads.

### 9.4 Segredos

- não reutilizar `ADMIN_TOKEN` na Skill;
- não incluir segredos no modelo de interação;
- configurar IDs e flags apenas no ambiente do backend;
- manter `.env.example` apenas com valores vazios e instruções.

## 10. Idempotência e consistência

A Alexa pode reenviar uma requisição quando houver falha de rede ou timeout. Uma ação confirmada não pode criar dois compromissos.

### 10.1 Chave de idempotência

Usar `request.requestId` como chave primária de deduplicação. Persistir, por tempo limitado, algo equivalente a:

```ts
interface AlexaRequestReceipt {
  requestId: string;
  intent: string;
  status: "processing" | "completed" | "failed";
  result?: unknown;
  createdAt: number;
  expiresAt: number;
}
```

Alternativas de armazenamento:

- coleção Firestore `alexa_request_receipts` com TTL; ou
- documento com limpeza periódica, caso TTL não esteja configurado.

Se o mesmo `requestId` chegar novamente, retornar o resultado anterior sem repetir a escrita.

### 10.2 Deduplicação semântica

Além do request ID, manter a proteção já usada pelo sistema:

- mesmo título normalizado;
- mesma data;
- horário sobreposto.

Nesse caso, a Skill deve responder que o compromisso já existe e não criar uma cópia.

### 10.3 Concorrência

Criação/remarcação deve revalidar conflitos imediatamente antes da escrita. Para operações críticas, usar transação do Firestore ou uma estratégia de lock/deduplicação que cubra duas requisições simultâneas.

## 11. Auditoria e desfazer

Toda alteração feita pela Alexa deve entrar no mesmo histórico de ações do sistema.

Sugestão de contexto de origem:

```ts
{
  actor: "owner",
  channel: "alexa",
  contact: config.ownerPhone,
  requestId: "..."
}
```

A descrição pode ser:

- `a criação do evento "Dentista" via Alexa`;
- `a remarcação do evento "Reunião com João" via Alexa`;
- `a remoção do evento "Almoço" via Alexa`.

O comando de desfazer por voz fica fora do MVP. Entretanto, a ação deve continuar reversível pelo painel ou pelo WhatsApp usando a infraestrutura existente.

## 12. Tratamento de datas e horários

### 12.1 Fonte de verdade

Todas as conversões usarão `config.timezone`, atualmente com padrão `America/Sao_Paulo`. O deploy precisa definir explicitamente o fuso pretendido, evitando depender do timezone do container.

### 12.2 Regras

- “hoje” e “amanhã” são resolvidos no fuso do Igor;
- horário deve ser validado em formato de 24 horas internamente;
- respostas podem ser faladas no formato natural brasileiro;
- se o horário já passou e a data for hoje, perguntar se o usuário realmente quer aquele horário;
- eventos atravessando meia-noite ficam fora do MVP;
- ao remarcar somente o início, preservar a duração original;
- não aceitar duração zero ou negativa;
- limitar durações absurdas e pedir correção.

### 12.3 Datas ambíguas

Exemplos como “sexta” devem resolver para a próxima sexta coerente com o contexto da Alexa. Antes de escrever, a confirmação sempre falará a data de maneira inequívoca:

> “sexta-feira, vinte e cinco de setembro, às quinze horas”.

Isso permite ao Igor corrigir interpretações erradas.

## 13. Respostas de erro

As mensagens precisam indicar se houve ou não alteração.

| Situação | Resposta sugerida |
|---|---|
| Falta título | “Qual é o nome do compromisso?” |
| Falta data | “Para qual dia?” |
| Falta hora | “A que horas?” |
| Falta duração | “Quanto tempo devo reservar?” |
| Nenhum candidato | “Não encontrei esse compromisso nos próximos trinta dias.” |
| Vários candidatos | “Encontrei mais de um. Qual deles você quer?” |
| Conflito | “Esse horário coincide com outro compromisso. Deseja continuar?” |
| Falha do Firestore | “Não consegui acessar sua agenda agora. Nada foi alterado.” |
| Usuário não autorizado | “Esta Skill não está autorizada para esta conta.” |
| Requisição duplicada | Repetir o resultado original, sem nova escrita. |
| Sessão expirada | “A confirmação expirou. Faça o pedido novamente.” |

Nunca responder “pronto”, “marquei” ou “remarquei” antes de a persistência confirmar sucesso.

## 14. Observabilidade

Registrar eventos estruturados:

```text
[alexa] request intent=ConsultarAgendaIntent requestId=... durationMs=...
[alexa] write action=create agendaItemId=... requestId=...
[alexa] rejected reason=invalid_skill_id requestId=...
[alexa] error intent=RemarcarCompromissoIntent code=firestore_failure
```

Não registrar:

- cabeçalhos de autenticação;
- certificados completos;
- payload integral;
- identificador Amazon completo;
- atributos de sessão contendo dados desnecessários.

Métricas úteis:

- total de chamadas;
- chamadas por intent;
- taxa de conclusão dos diálogos;
- quantidade de pedidos cancelados na confirmação;
- ambiguidades;
- erros de validação;
- tempo de resposta;
- requisições duplicadas bloqueadas.

## 15. Estratégia de testes

### 15.1 Testes unitários

- normalização de datas retornadas pela Alexa;
- conversão de duração em minutos;
- preservação da duração em remarcações;
- busca por título sem acento e com correspondência parcial;
- seleção de candidato único;
- detecção de ambiguidade;
- detecção de sobreposição;
- bloqueio de horário inválido;
- idempotência por `requestId`;
- deduplicação por título/data/horário;
- formatação curta das respostas faladas;
- rejeição de Skill ID ou user ID incorretos.

### 15.2 Testes de integração

- `LaunchRequest` retorna boas-vindas;
- consulta lê itens reais do repositório de teste;
- criação confirmada grava exatamente um item;
- criação negada não grava;
- remarcação atualiza o item correto;
- cancelamento remove o item correto;
- reenvio do mesmo request não duplica;
- falha de persistência informa que nada foi alterado;
- sessão com dois candidatos pede desambiguação;
- rota rejeita payload sem validação da Alexa.

### 15.3 Evals de regressão do projeto

Adicionar casos à suíte existente para garantir que a extração da camada compartilhada não altere o comportamento do WhatsApp:

- criar evento fixo;
- editar evento;
- remover evento;
- propagação para `Task` vinculada;
- Google Calendar desativado continua sendo no-op;
- Google Calendar ativado continua best-effort;
- histórico de desfazer continua válido.

### 15.4 Testes no simulador Alexa

Executar, no mínimo:

1. abrir a Skill;
2. consultar agenda vazia;
3. consultar agenda com um item;
4. consultar agenda com muitos itens;
5. criar informando tudo em uma frase;
6. criar faltando duração;
7. negar a confirmação;
8. remarcar candidato único;
9. remarcar com dois candidatos;
10. cancelar candidato único;
11. abandonar a sessão no meio;
12. dizer uma frase não compreendida;
13. repetir o mesmo comando após aparente timeout.

### 15.5 Teste em dispositivo real

O simulador não representa perfeitamente reconhecimento de voz, ruído, pronúncia e interrupções. Antes de considerar o MVP concluído, testar em um Echo real:

- nomes próprios como Igor, João e nomes de empresas;
- “três da tarde” versus “quinze horas”;
- datas faladas naturalmente;
- respostas “sim”, “não”, “cancela” e “para”;
- retomada após uma pergunta da Alexa;
- tempo percebido entre comando e resposta.

## 16. Fases de implementação

### Fase 0 — Preparação da conta e Skill

- confirmar que o Echo do Igor está logado na mesma conta Amazon que será usada
  no console de desenvolvedor (ver 2.4) — esta é a primeira verificação, antes
  de qualquer código;
- criar ou confirmar a conta Amazon Developer;
- criar uma Custom Skill em `pt-BR`;
- escolher o nome de invocação;
- verificar no console quais tipos nativos e intents padrão existem em `pt-BR`
  (ver 6.2.2);
- manter a Skill em modo de desenvolvimento;
- obter o Skill ID;
- definir e registrar o domínio público, o caminho do endpoint e a validade do
  certificado (ver 5.6);
- configurar o endpoint de desenvolvimento quando a rota estiver pronta.

**Saída:** Skill vazia criada e identificada, visível no Echo do Igor.

### Fase 1 — Refatoração segura da agenda

- criar `agendaActions.ts`;
- extrair criação, busca, edição e remoção hoje embutidas no executor de ferramentas;
- manter os contratos atuais do WhatsApp;
- centralizar idempotência, propagação e auditoria;
- adicionar testes de regressão.

**Saída:** WhatsApp e painel continuam funcionando, com regras reutilizáveis.

### Fase 2 — Endpoint e segurança

- adicionar dependências do ASK SDK;
- criar `POST /alexa` preservando o corpo bruto da requisição (ver 5.3.1);
- validar assinatura, timestamp, Skill ID e usuário;
- adicionar feature flag `ALEXA_ENABLED`;
- implementar `LaunchRequest`, ajuda, cancelamento e fallback;
- adicionar logs estruturados.

**Saída:** Skill abre com segurança e responde sem acessar a agenda.

### Fase 3 — Consulta

- implementar normalização de períodos;
- integrar consulta ao serviço de agenda;
- criar respostas curtas;
- limitar leitura de listas extensas;
- testar hoje, amanhã, data específica e próximos compromissos.

**Saída:** consultas de voz funcionais, ainda sem escrita.

### Fase 4 — Criação com confirmação

- implementar slots obrigatórios;
- diálogo para dados ausentes;
- confirmação final;
- conflito de horário;
- idempotência persistente;
- auditoria e desfazer.

**Saída:** criação segura de compromissos fixos.

### Fase 5 — Remarcação e cancelamento

- implementar busca de candidatos;
- implementar desambiguação;
- preservar duração;
- confirmar alterações;
- garantir propagação para itens vinculados;
- cobrir cancelamento e falhas parciais.

**Saída:** ciclo completo de manutenção da agenda por voz.

### Fase 6 — Homologação em Echo

- testar pronúncia e frases reais;
- ajustar utterances;
- testar latência e interrupções;
- configurar `ALEXA_ALLOWED_USER_ID` definitivo pelo procedimento de 9.2.1;
- documentar a recaptura do ID para quando ele mudar (9.2.2);
- documentar ativação, rollback e troubleshooting.

**Saída:** MVP pronto para uso pessoal diário.

## 17. Critérios de aceite

O MVP estará concluído quando todos os itens abaixo forem verdadeiros:

- [ ] “Alexa, abra Agente Igor” inicia uma sessão em português.
- [ ] A Skill rejeita outra conta Amazon.
- [ ] A Skill rejeita requisições que não vieram validamente da Alexa.
- [ ] A validação de assinatura passa com um payload assinado real.
- [ ] Nenhuma resposta ultrapassa o orçamento de tempo da Alexa.
- [ ] É possível consultar a agenda de hoje e amanhã.
- [ ] É possível criar um compromisso fornecendo dados em uma ou mais falas.
- [ ] Nenhuma criação ocorre antes da confirmação.
- [ ] É possível remarcar um compromisso sem alterar outro parecido.
- [ ] Ambiguidades apresentam opções e aguardam escolha.
- [ ] É possível cancelar um compromisso com confirmação.
- [ ] Repetição da mesma requisição não duplica nem reaplica a alteração.
- [ ] Datas relativas respeitam o fuso configurado.
- [ ] Conflitos de horário são informados.
- [ ] Toda alteração aparece imediatamente no painel e no WhatsApp.
- [ ] Toda alteração entra na auditoria e pode ser desfeita pelos canais atuais.
- [ ] Tudo funciona com `GOOGLE_CALENDAR_ID` vazio.
- [ ] Os evals atuais continuam passando.
- [ ] O fluxo foi validado em um dispositivo Echo real.

## 18. Rollout e rollback

### 18.1 Rollout

1. Fazer deploy com `ALEXA_ENABLED=false`.
2. Verificar saúde do backend e regressões.
3. Configurar o endpoint no console Alexa.
4. Ativar somente em desenvolvimento.
5. Capturar e configurar o `ALEXA_ALLOWED_USER_ID` de forma controlada.
6. Alterar `ALEXA_ENABLED=true`.
7. Testar primeiro consultas.
8. Testar criação, remarcação e cancelamento.
9. Acompanhar logs nas primeiras utilizações reais.

### 18.2 Rollback

O desligamento deve ser imediato e não exigir remoção de código:

```env
ALEXA_ENABLED=false
```

Depois do restart/deploy, a rota deixa de executar intents. A agenda, o WhatsApp e o painel permanecem operacionais.

Se a refatoração da camada de agenda causar regressão, o deploy deve ser revertido como um todo. Por isso, a Fase 1 precisa ser entregue e testada separadamente da ativação da Skill.

## 19. Riscos e mitigação

| Risco | Impacto | Mitigação |
|---|---|---|
| Alexa interpreta data/hora errada | compromisso incorreto | repetição completa antes da confirmação |
| Títulos parecidos | item errado remarcado/removido | desambiguação e limite de confiança |
| Reentrega da requisição | duplicação | request ID persistido + deduplicação semântica |
| Endpoint exposto | acesso indevido | assinatura, Skill ID, user ID e feature flag |
| ID da conta muda ao reinstalar a Skill | Skill para de responder sem causa aparente | mensagem e log de recusa específicos + procedimento de recaptura documentado |
| Refatoração muda WhatsApp | regressão em produção | serviço compartilhado + evals antes da Skill |
| Resposta demora demais | Skill diz que houve problema mesmo com a escrita feita | orçamento de 3s, nada de rede externa no caminho crítico, idempotência na repetição |
| Corpo da requisição já interpretado antes da rota | assinatura nunca valida e a Skill não abre | preservar o corpo bruto e testar com payload assinado antes do dispositivo |
| Firestore indisponível | operação incerta | resposta sem afirmar sucesso; idempotência na repetição |
| Voz ou ruído gera slot incompleto | diálogo frustrante | perguntas curtas, uma informação por vez |
| Título livre engole data e hora da mesma frase | compromisso com nome errado | slot de título com valores representativos, plano B em duas etapas, confirmação falada antes de gravar |
| Tipo nativo ausente em pt-BR | modelo de interação refeito | verificação no console na Fase 0 |
| Nome de invocação não aprovado | bloqueio de configuração | validar cedo no console e ter nomes alternativos |

## 20. Melhorias posteriores

Após estabilizar o MVP:

- comando “desfaça a última alteração”;
- marcar compromisso como concluído;
- criar lembretes e tarefas, além de eventos;
- agenda semanal resumida;
- recorrências;
- notificações proativas compatíveis com as políticas da Alexa;
- respostas visuais para Echo Show;
- ativação opcional do Google Calendar;
- account linking, somente se o sistema deixar de ser exclusivamente pessoal;
- fallback controlado por LLM para frases não cobertas, mantendo confirmação determinística das escritas.

## 21. Ordem recomendada de execução

A ordem mais segura é:

1. criar a Skill no console e validar o nome “Agente Igor”;
2. extrair a camada compartilhada de ações da agenda;
3. implementar segurança e abertura da Skill;
4. liberar consultas;
5. liberar criação;
6. liberar remarcação;
7. liberar cancelamento;
8. homologar no Echo;
9. manter o Google Calendar desativado até surgir uma necessidade real.

Essa sequência entrega valor progressivamente e mantém as operações de escrita desativadas até que autenticação, diálogo e consulta estejam comprovadamente estáveis.

## 22. Referências técnicas oficiais

- [Build Your Skill — Alexa Skills Kit](https://developer.amazon.com/en-US/docs/alexa/build/build-your-skill-overview.html)
- [Create Intents, Utterances, and Slots](https://developer.amazon.com/en-US/docs/alexa/custom-skills/create-intents-utterances-and-slots.html)
- [Dialog Interface Reference](https://developer.amazon.com/en-US/docs/alexa/custom-skills/dialog-interface-reference.html)
- [Request and Response JSON Reference](https://developer.amazon.com/en-US/docs/alexa/custom-skills/request-and-response-json-reference.html)
- [Security Requirements for Alexa Skills](https://developer.amazon.com/en-US/docs/alexa/custom-skills/security-testing-for-an-alexa-skill.html)
- [Account Linking](https://developer.amazon.com/en-US/alexa/alexa-skills-kit/get-deeper/account-linking-api)

