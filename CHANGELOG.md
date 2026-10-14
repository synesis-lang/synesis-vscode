# Changelog

All notable changes to the Synesis extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.15.2] - 2026-09-28

### Corrigido — a verificação de citações era desligada em silêncio

Uma consulta Cypher sem alias devolve as colunas com o prefixo da variável:
`RETURN i.citation` produz a chave `i.citation`, não `citation` — no ArcadeDB e
no Neo4j. A extensão lia só a chave exata, e **o próprio prompt ensinava a forma
sem alias**. Observado ao vivo (`gpt-oss:20b`, banco `face85`): a consulta
devolveu 5 linhas com trechos, a resposta exibiu 3 citações, e:

- a trilha declarou *"Não há trechos do corpus a auditar"*;
- as âncoras até o `.syn` não apareceram;
- **a verificação de citações não conferiu nada** — sem registro de evidência
  ela não verifica, por desenho (correto para resposta sobre o template). Uma
  citação inventada teria passado sem aviso. A ausência de aviso naquele turno
  não foi aprovação.

A correção (`evidence.evidenceGroups`) lê a evidência agrupando as chaves pela
variável: `i.citation`/`i.source_file` formam um registro, `j.citation` outro, e
os campos de fonte (`s.bibtex`, `s.title`, `s.year`) valem para todos. O vértice
inteiro (`RETURN i, s`) segue a mesma regra. **As chaves exatas têm precedência
total:** o prefixo só é lido quando elas não trazem evidência, então toda linha
que já era lida sai idêntica. Expressões sem alias (`toLower(i.citation)`)
continuam fora de alcance.

A trilha, a classificação do turno (`rowHasEvidence`) e a verificação de
citações passam a usar essa mesma definição de evidência — antes eram duas. E o
prompt passa a pedir alias (`i.citation AS citation`…), como segunda camada.

## [0.15.1] - 2026-09-28

### Adicionado — raciocínio e streaming configuráveis no Ollama

Duas opções novas no card **Ollama (modelos locais)** da página de
configuração, também em `settings.json` (escopo `machine`):

- **`synesisExplorer.chat.ollama.think`** (`default` · `off` · `low` · `medium`
  · `high`; padrão `low`). No chat o modelo pensa a cada consulta ao banco,
  inclusive nas que só escolhem a próxima — o maior custo de tempo num modelo
  local. O parâmetro não é uniforme: o **gpt-oss** recebe o nível e não desliga
  (`off` vira `low`); os demais só ligam ou desligam. Modelo que não declara
  `thinking` em `capabilities` não recebe o parâmetro, nem `false`.
- **`synesisExplorer.chat.ollama.stream`** (padrão ligado). A resposta chega em
  pedaços (NDJSON). Não encurta a geração, mas evita que uma rodada lenta
  estoure o prazo de 5 minutos do `fetch` à espera dos cabeçalhos e deixa o
  cancelamento agir no meio. **O texto continua aparecendo ao fim de cada
  rodada:** o laço do chat o retém de propósito até saber que não é um passo
  intermediário antes de uma consulta ao banco.

## [0.15.0] - 2026-09-28

### Adicionado — modelos locais do Ollama no chat

Um quinto provedor, **Ollama**, para usar no `@synesis` modelos que rodam na
própria máquina ou num servidor da rede — sem API key e sem o corpus sair da
rede local. Configura-se no card **Ollama (modelos locais)** da página de
configuração: endereço do servidor, janela de contexto e um botão **Testar**,
que lista os modelos com a mesma função que monta o seletor (o teste passar
significa que os modelos vão aparecer) e avisa quais não suportam ferramentas —
esses respondem sem consultar o banco.

- **Opt-in.** Com o endereço em branco (padrão), o provedor fica desligado e
  nada é consultado. Com ele, os modelos instalados aparecem no seletor;
  modelos só de embedding ficam fora, e o suporte a *tool-calling* é lido do
  próprio Ollama (`capabilities`).
- **API nativa (`/api/chat`), não a compatível com OpenAI.** O Ollama só aloca
  o contexto que `num_ctx` pede e, sem pedido, usa um padrão pequeno que corta
  o prompt em silêncio — e o prompt do chat carrega schema e regras. A `/v1`
  não aceita `num_ctx`; a nativa aceita. A janela anunciada ao VSCode é
  exatamente a pedida ao servidor: o menor entre
  `synesisExplorer.chat.ollama.contextLength` (padrão 32.768) e o máximo do
  modelo.
- **Prazo de 3 s na consulta ao servidor.** Um endereço que aceita a conexão e
  não responde travaria o seletor de modelo de todos os provedores.
- **Escopo `machine`** para `ollama.url` e `ollama.contextLength`: um workspace
  não confiável não pode redirecionar o chat — e os trechos do corpus que vão
  no prompt — para outro servidor.

Verificado contra um Ollama 0.34.4 real (qwen3.5, gemma4, Mistral Small 3.2):
catálogo, chamada de ferramenta e resposta com o resultado, ida e volta.

### Corrigido

- As mensagens de "configure a API key" dos provedores Anthropic, OpenAI,
  Gemini e OpenRouter apontavam para o comando "Synesis: Configurar Provedor de
  IA", removido na 0.14.0. Agora apontam para "Synesis: Configuração".

## [0.14.0] - 2026-09-28

### Adicionado — o chat consulta o banco direto, e agora fala Neo4j

O chat tinha **um** caminho até o grafo: ferramentas MCP publicadas em
`vscode.lm.tools`, reconhecidas por um filtro que procurava a string `arcade` no
nome do servidor. Isso o amarrava a uma combinação — ArcadeDB, sobre TCP, com um
`mcp.json` declarado à mão — e excluía o Neo4j por construção: nenhum servidor
chamado `neo4j` casa com um filtro que exige `arcade`.

- **O transporte agora vem do perfil ativo** (`src/chat/graphClients.js`): HTTP
  para o ArcadeDB, Bolt para o Neo4j. Cada cliente expõe as mesmas quatro
  operações, então o loop de tool-calling não sabe com quem está falando — e
  `citationGuard`, `sourceAnchor` e a trilha de auditoria seguem intactos,
  porque o payload continua chegando como texto JSON.
- **Neo4j local e AuraDB**, com o `neo4j-driver` empacotado. Os inteiros de 64
  bits do driver são convertidos: crus, chegariam ao modelo como
  `{"low":42,"high":0}` e ele relataria a contagem errada com confiança.
- **Somente leitura, por construção.** A superfície de ferramentas não tem
  operação de escrita — não é uma verificação que se possa esquecer de fazer. O
  conteúdo do corpus é texto não confiável, e a defesa é a ferramenta não estar
  lá.
- **O `.vscode/mcp.json` deixou de participar.** Com isso somem, de uma vez: a
  credencial duplicada em Basic64 dentro do workspace, a dependência de o
  servidor MCP ter subido nesta janela, e a divergência entre "configurado" e
  "funcionando". O MCP que o próprio ArcadeDB serve continua existindo e útil
  para outros clientes — o chat da extensão é que não precisa mais dele.
- **Migração automática:** quem já tinha o chat funcionando tem a conexão antiga
  importada como perfil na primeira consulta, sem perguntar nada.

**Limitação declarada:** o ArcadeDB **embutido** é cadastrável e testável, mas o
chat ainda não consulta por ele — a engine embutida é Java e não roda dentro do
VSCode. A mensagem diz isso e sugere subir um servidor sobre a mesma pasta, em
vez de falhar sem motivo aparente.

### Alterado — um só caminho de configuração

Seis comandos da paleta foram **removidos**: `Configurar Provedor de IA`,
`Remover API Key`, `Configurar Conexão do Banco`, `Remover Senha do Banco`,
`Conectar ao ArcadeDB (MCP)` e `Reconectar ao ArcadeDB`. Cada um cobria um
pedaço, nenhum dizia qual era o próximo, e a página de settings repetia parte
deles — a duplicação que fazia "configurei e continua pedindo" parecer um
defeito sem fim. Tudo o que eles faziam está na página de configuração.

As settings `synesisExplorer.chat.arcadedb.uri` e `.user` ficam **só como
legado**, marcadas como obsoletas e lidas apenas para migrar a conexão antiga.
Não saem ainda por segurança: é a declaração com escopo `machine` que impede um
workspace não confiável de gravá-las no próprio `settings.json` e redirecionar a
conexão, com a senha do cofre, para outro host. Saem junto com a migração.
A setting `synesisExplorer.chat.preferredProvider` saiu: ela só ordenava o menu
de um dos comandos removidos. `src/chat/mcpSetup.js` foi excluído e
`connectionSettings.js` ficou reduzido à leitura de migração.

### Alterado — banco de grafos e provedor de IA, claramente separados

A confusão entre os dois leva o pesquisador a procurar o corpus na configuração
do modelo. A página agora abre com as duas metades lado a lado, cada seção
identificada pelo que ela é — 🗄️ **Banco de grafos** (*o seu corpus*) e 🤖
**Provedor de IA** (*o modelo que conversa*) — e a página nativa de settings
repete a mesma distinção.

### Adicionado — página de configuração própria, com todos os campos

A configuração vivia em dois lugares que se repetiam: a página nativa de
settings mostrava servidor e usuário, e **senha e API keys eram pedidas em
janelinhas** disparadas por comando. Nenhum dos dois era completo, e o processo
aparecia duplicado.

A causa é uma limitação da API do VSCode: a `configuration` só renderiza o que
grava em `settings.json` — string, boolean, number, enum — e **não existe tipo
"senha"**. Um segredo ali seria texto puro, sincronizado entre máquinas e
legível por outras extensões. É o padrão da plataforma resolver isso com página
própria, e é o que a extensão passa a ter.

- **`Synesis: Configuração`** (`synesis.openSettings`) reúne tudo numa tela:
  conexões, senhas, chaves de API e o banco. Os segredos são **campos normais**,
  gravados no cofre criptografado do sistema operacional. O valor guardado nunca
  volta para a tela — o campo aparece vazio com o rótulo "configurada", e salvar
  sem tocá-lo preserva o que está lá.
- **A página nativa de settings deixou de replicar o processo:** agora aponta
  para a página própria e explica por que senha e chave não podem aparecer nela.

### Adicionado — conexões nomeadas, e mais de um tipo de banco

O modelo anterior guardava **uma** conexão de **um** backend: ArcadeDB sobre
TCP, alcançado por um `mcp.json` escrito à mão. O ecossistema usa quatro
combinações, e não havia onde guardar as outras três.

- **Perfis nomeados**, com o ativo escolhido por projeto. Alternar entre o
  corpus local e o remoto não exige mais redigitar credencial.
- **Backends declarados, não adivinhados** (`src/chat/connectionProfiles.js`):
  ArcadeDB servidor, ArcadeDB embutido e Neo4j (local e AuraDB), cada um com
  seus próprios campos e validação. O vocabulário acompanha o
  `synesis_graph/config.py`, para que os dois lados nomeiem a mesma coisa igual.
  - O ArcadeDB recusa `bolt://` explicando que fala HTTP; o Neo4j aceita
    `bolt://` e `neo4j+s://` da AuraDB.
  - O modo embutido pede pasta, não credencial — e avisa quando o caminho aponta
    para a pasta do banco em vez da raiz que contém `databases/`, a confusão que
    no `synesis-graph` falha em silêncio.
- **Botão "Testar conexão"** que prova de fato que funciona, distinguindo
  "servidor não respondeu" de "credencial recusada". Antes nada no fluxo provava
  nada. Cobre os dois modos do ArcadeDB; o teste do Neo4j chega com o suporte a
  Bolt e diz isso, em vez de reportar uma falha que não houve.

### Corrigido — a extensão criava um servidor MCP duplicado

Ao gravar o `.vscode/mcp.json`, a extensão usava a chave fixa `arcadedb`. Um
pesquisador que já tivesse o mesmo servidor declarado sob outro nome — o caso
real era `arcadedb-face85` — não tinha sua conexão atualizada: ganhava uma
**segunda** entrada para o mesmo endpoint, com credencial possivelmente
diferente, e ambas casavam com o filtro de ferramentas do chat. A senha nova ia
para uma; o chat podia continuar consultando pela outra.

Agora a entrada existente para a mesma URL é atualizada no lugar, preservando o
nome que o pesquisador escolheu.

### Corrigido — configurar o servidor deixou de ser um labirinto

Configurar a conexão com o ArcadeDB exigia **quatro comandos** na paleta, em
ordem certa e sem nada dizer qual era. Quem parava no segundo — o que pede
servidor, usuário e senha — tinha a credencial corretamente salva e o chat sem
funcionar, porque o `.vscode/mcp.json` só era escrito pelo terceiro. E o aviso
que aparecia então pedia *"configurar a conexão"*: a mesma frase, para quem
acabara de configurá-la.

- **Salvar a conexão conclui a configuração.** O comando **Synesis: Configurar
  Conexão do Banco** agora grava o `.vscode/mcp.json`, reinicia o servidor MCP e
  encadeia a escolha do banco. Não há segundo passo a descobrir.
  - A escrita do arquivo é *best-effort*: sem pasta aberta, ou diante de um
    `mcp.json` em JSONC que não pôde ser lido, a credencial continua salva e a
    mensagem diz o que ficou pendente — em vez de um "conexão salva" que esconde
    que o chat ainda não vai responder.
  - Um `mcp.json` ilegível **nunca** é sobrescrito, agora também neste caminho
    automático, que roda sem ninguém olhando.
- **A senha nova alcança o `mcp.json`.** Trocar a senha atualizava o cofre e
  deixava o arquivo autenticando com a anterior, em silêncio — a rotação de
  credencial não surtia efeito até alguém rodar o comando certo por conta.
- **Os avisos passaram a distinguir as causas** (`src/chat/connectionStatus.js`).
  "Nenhuma ferramenta do ArcadeDB" tem três causas distintas — credencial nunca
  configurada, pasta não aberta, servidor que não respondeu apesar de tudo estar
  salvo — e cada uma agora nomeia a causa provável e oferece a ação que a
  resolve. Com a credencial salva, o aviso diz que o problema **não** é a
  configuração e mostra o endereço a conferir, em vez de mandar reconfigurar.
- **Novo comando Synesis: Reconectar ao ArcadeDB** para o estado "está tudo
  salvo e mesmo assim não responde": regrava o arquivo e reinicia o servidor,
  sem perguntar nada.
- **A aba de configuração da extensão explica o caminho.** Settings →
  Extensions → Synesis agora abre com os dois passos numerados, diz por que
  senha e chaves de API não aparecem como campos (esta página grava em
  `settings.json`, que é texto puro e sincroniza entre máquinas), e reúne as
  ações de recuperação num bloco separado.

### Adicionado — o chat enxerga o que o banco guarda, não só o que ele declara

O resumo de schema que vai ao prompt era montado a partir do `get_schema`, que
lista apenas as propriedades **declaradas**. Uma propriedade gravada em todo
vértice mas nunca declarada é invisível ali — e o modelo não pode consultar o
que não sabe que existe.

Não é hipótese. No `candidatos_quinto_andar` (ArcadeDB 26.9.1, 3.027 candidatos)
o vértice `Source` declara 19 propriedades, todas textuais: `total_score`,
`normalized_score`, `coverage` e `scored_criteria` **não aparecem em nenhuma**,
apesar de gravadas como inteiros em todos os 3.027 vértices. Perguntado "qual
candidato é mais bem pontuado", o modelo não via com o que ordenar e gastava as
rodadas descobrindo por tentativa que um campo de pontuação sequer existia.

- **Sondagem por amostragem** (`src/chat/observedProperties.js`): uma consulta
  por vértice, unindo as chaves observadas às declaradas. O que o schema omite
  entra no prompt com o tipo, marcado como observação amostral — não como
  schema. Banco com schema completo não gera seção nenhuma.
- **Número gravado como texto é advertido**, porque falha DURO: `sum()` sobre
  `Item.score` devolve `sum() requires numeric input, but received a value of
  type String`, e `ORDER BY` ordena "9" depois de "38".
- **Chave de agrupamento ambígua**, o erro que falha em silêncio: 29 títulos são
  compartilhados por dois ou mais candidatos ("Lucas Vieira" são três pessoas).
  Um `GROUP BY title` soma os trechos das três e devolve um total que não
  pertence a ninguém, sem erro visível. O aviso nomeia a chave única e só
  dispara para campos QUASE-únicos — uma coluna com dois valores distintos é
  categoria, não identificador.
- **Mais de um campo de pontuação é apresentado, não eleito.** `total_score` e
  `normalized_score` produzem ordens diferentes. Escolher por conta do
  pesquisador é decidir o método dele — a mesma disciplina que `METRIC_HINTS` já
  adota para centralidade.

Vale para **qualquer** banco, inclusive grafos exportados por versões anteriores
que ninguém vai reexportar: a correção no produtor (`synesis-graph`, declarar os
campos `TYPE SCALE`) continua valendo e não substitui esta.

### Adicionado — modelos do OpenRouter declarados pelo pesquisador

O OpenRouter publica **424 modelos** (verificado no catálogo). A extensão
oferecia quatro, fixos no código: testar qualquer outro exigia editar o fonte e
reconstruir a extensão.

- **Campo livre na página de configuração**, no card do OpenRouter: um id por
  linha, uma caixa, um botão. Nome, janela de contexto e suporte a
  *tool-calling* vêm do catálogo público — `maxInputTokens` errado faz o VSCode
  truncar o prompt em silêncio, e é onde vivem o schema e as regras de contagem.
- **Anthropic, OpenAI e Gemini descobrem os modelos pela própria API**, com a
  lista fixa como fallback quando a rede ou a chave falham.
  `synesisExplorer.chat.discoverModels: false` volta às listas internas — útil
  para manter o seletor estável durante uma campanha de medição.
- **`toolCalling` deixou de ser promessa.** Os três provedores anunciavam
  `capabilities: { toolCalling: true }` fixo, sem verificar. O catálogo do
  OpenRouter declara `supported_parameters`, e `tools` aparece em 358 dos 424 —
  os outros 66 nunca chamariam ferramenta, e o chat inteiro depende disso.

### Corrigido — o seletor de modelo não atualizava sem recarregar a janela

Salvar um modelo novo não produzia efeito: o VSCode **guarda** a lista devolvida
por `provideLanguageModelChatInformation` e só volta a perguntar quando o
provider dispara `onDidChangeLanguageModelChatInformation` (`vscode.d.ts` 1.134).
Nenhum dos provedores implementava o evento, então nada invalidava a lista
guardada — um defeito latente desde que os provedores existem, que só ficou
visível quando a lista passou a ser editável.

Os três provedores agora emitem o evento, e a extensão o dispara tanto na
gravação pelo painel quanto na edição direta do `settings.json`.

### Corrigido — provedor sem chave oferecia modelos que falhariam

O registry documentava que um provedor sem API key fica invisível no seletor,
mas **nada implementava isso**: a chave só era consultada na hora de responder.
Os modelos apareciam e falhavam depois da pergunta. Agora sem chave o provedor
devolve lista vazia — o erro chega antes da pergunta, não depois.

### Corrigido — argumento vazio virava um erro que o modelo não sabia ler

Chamada de ferramenta sem o parâmetro obrigatório descia até o cliente como
`undefined`; `JSON.stringify` descarta a chave, e o ArcadeDB respondia
`HTTP 400 — "command missing"`. Observado com o `liquid/lfm-2.5-2.6b:free`: o
modelo chamou `synesis_graph_query` sem preencher `query`, errou **duas vezes
idênticas** e não tinha como se corrigir — o erro falava de `command`, campo do
protocolo HTTP, enquanto o contrato que ele conhece declara `query`.

A chamada agora é validada antes da rede e o erro nomeia o parâmetro do contrato
do modelo, distinguindo ausente de vazio. Vale para os dois backends do perfil;
o caminho MCP segue com a validação do próprio servidor.

### Alterado — o custo de cada pergunta, e o que a trilha mostra

- **Cache de prefetch por conexão + banco** (`src/chat/prefetchCache.js`). Cada
  pergunta refazia `ProjectContext`, `get_schema` e a sondagem antes da primeira
  palavra do modelo. A chave inclui o perfil: dois perfis apontando para bancos
  homônimos — um local e um remoto — serviriam o schema errado sob o outro, a
  pior falha possível aqui porque a resposta pareceria correta.
- **Sondagem em paralelo**, com concorrência limitada e ordem de saída estável:
  o prompt não pode variar conforme a ordem em que o servidor responde.
- **A trilha separa consultas do modelo das leituras da extensão.** Somados, uma
  melhoria que ENCURTA o laço aparecia como custo maior por ter acrescentado uma
  leitura de prefetch — sem separar, nenhuma melhoria de rodadas é verificável.
  Quando o prefetch vem do cache, a linha diz isso, em vez de um zero que se lê
  como falta de contexto.
- **Aviso quando a resposta não consultou o banco.** É o modo de falha típico do
  modelo pequeno: texto plausível sobre o corpus sem nenhuma chamada de
  ferramenta, hoje indistinguível de uma resposta boa. O aviso diz para tratar
  como hipótese — e é o que torna legível uma campanha de "qual o menor modelo
  que dá conta".

### Corrigido — vários `.bib`, curingas e pastas no `.synp`

O `synesis` 0.13 aceita arquivo, curinga ou pasta em todo `INCLUDE`, e várias
linhas do mesmo tipo se somam. Isso permite organizar um corpus por lote, com um
`.bib` por docente em `Sources/`. A extensão não acompanhava:

- **A bibliografia lia só a primeira linha `INCLUDE BIBLIOGRAPHY`.** Um curinga
  virava o caminho literal `fontes/*.bib`, e o painel de abstract não encontrava
  nada.
- **Um curinga em `INCLUDE ANNOTATIONS`/`ONTOLOGY` ia ao `findFiles` como caminho
  absoluto**, que ele não casa. A lista caía no fallback "todos os `.syn` da
  pasta", com arquivos que o projeto não declara.
- **`INCLUDE SHARED ONTOLOGY "x"` era lido como tipo `SHARED`** e caminho
  `ONTOLOGY`.

Correções:

- **`src/core/includeExpander.js`** (novo, sem dependências) espelha o
  `expand_include` do compilador. Arquivo, curinga (`*`, `?`, `[...]`, `**`) ou
  pasta recursiva pela extensão do tipo, restritos à pasta do projeto (exceto
  `SHARED`), na mesma ordem que o compilador: sem diferenciar caixa, igual em
  todos os sistemas.
- **`projectLoader`** expõe `bibliographyPaths`, todos os `.bib` do projeto.
  `bibliographyPath` continua valendo, como o primeiro deles. A regex dos
  `INCLUDE` aceita `SHARED`.
- **O painel de abstract procura a entrada em todos os `.bib`**, na ordem, e vale
  a primeira ocorrência, como no compilador.
- **`workspaceScanner`** passa a usar a mesma expansão para `.syn` e `.syno`.

## [0.13.0] - 2026-08-25

### Added — Chat `@synesis`: consulta ao grafo com trilha de auditoria

Assistente embutido que consulta o grafo do projeto (ArcadeDB) a partir do VS
Code, sem depender de assinatura do Copilot — o pesquisador escolhe o provedor.
**Toda afirmação sobre o corpus mostra o trecho e a referência que a sustentam**,
com link clicável até a linha do `.syn` anotado.

**Participant e provedores**

- Participant `@synesis` (`vscode.chat.createChatParticipant`) com loop próprio
  de tool-calling, teto configurável em `synesisExplorer.chat.maxToolRounds`
  (padrão 16, faixa 4–40).
- Quatro provedores — Anthropic, OpenAI, Google Gemini e OpenRouter — registrados
  como `LanguageModelChatProvider`. Cada um só aparece no seletor depois que a
  API key é configurada.
- **Segredos apenas em `context.secrets`.** API keys e senha do banco nunca vão
  para `settings.json`. A aba de configuração agrupa tudo o que não é segredo e
  aponta, por link de comando, para o que é.
- Conexão com o ArcadeDB configurada dentro do VS Code, independente do
  `config.toml` do projeto.

**Trilha de auditoria**

- **Citação obrigatória, em ordem quote-first**: o trecho literal vem antes da
  análise, e o modelo é instruído a declarar explicitamente quando uma afirmação
  não tem lastro no corpus. Distingue três origens — o que está nos trechos, o
  que vem do template, e o que é síntese do modelo.
- **Verificação de literalidade das citações** (`src/chat/citationGuard.js`):
  confere se cada citação existe nos registros que o banco devolveu. Comparação
  de strings, sem juiz LLM. Tolera aspas tipográficas, recorte com reticências e
  escapes de LaTeX herdados do `.syn`.
  - **Por registro, não por colagem.** Uma citação precisa caber inteira num
    único campo `citation`, na ordem em que a resposta a apresenta. A versão
    anterior concatenava todos os payloads do turno e procurava cada segmento
    nessa massa — aprovando uma citação montada com um pedaço de uma fonte e
    outro de outra.
  - O nome é deliberado: ela verifica **literalidade**, não fidelidade. Não diz
    se a citação sustenta a afirmação que a acompanha, nem se as demais
    afirmações têm lastro — e o aviso deixou de sugerir que dizia.
- **Toda contagem nomeia a unidade** (`COUNTING_RULES`). Fontes, trechos
  anotados (`annotation_id`), itens analíticos (`item_id`), menções e conceitos
  são cinco números diferentes sobre os mesmos dados — um bloco `ITEM` com
  quatro chains é 1 trecho e 4 itens. O prompt passa a exigir "20 menções", não
  "20", e traz a expressão que mede cada unidade.
- **Regra de divergência.** Antes de contradizer um número da resposta anterior,
  a reavaliação precisa comparar a UNIDADE dos dois; se diferirem, não há
  divergência. Só com unidades iguais ela refaz a medição — e recebe as
  consultas originais do turno, do `turnTrace`, para poder repetir exatamente a
  mesma. Divergência é hipótese até a unidade ser igualada.
- **Parser único de evidência** (`src/chat/evidence.js`): guarda, âncoras,
  trilha e métricas passam a ler o payload uma vez só. Havia duas
  interpretações do mesmo dado, uma preservando a estrutura e outra perdendo-a.
- **Botão "Ver evidências e consultas do turno"** ao fim das respostas que
  consultaram o corpus. Abre um relatório em Markdown com a pergunta, o banco, o
  modelo, **as consultas executadas na ordem** e as evidências que voltaram.
  Sob demanda, não como rodapé fixo — o que sempre aparece deixa de ser lido.
  - **Clicar não chama o modelo nem consulta o banco**: o relatório é renderizado
    a partir do registro estruturado capturado durante a resposta
    (`src/chat/turnTrace.js`). Reproduzir o turno e pedir a um novo ciclo do
    modelo que o reconstrua são coisas diferentes — a segunda pode discordar da
    primeira sem estar certa.
  - Cada botão carrega o **ID do seu turno**, então a resposta antiga continua
    abrindo o registro dela depois de novas perguntas ou troca de banco.
  - O botão só aparece quando houve de fato consulta ao corpus, e o rótulo diz o
    que entrega: evidências quando há trecho anotado, consultas e unidades quando
    a resposta veio de contagens.
- **Comando "Reavaliar resposta"**, separado do relatório: é uma nova execução do
  modelo sobre a mesma pergunta, pode discordar, e não substitui o registro do
  turno. Avisa quando o banco selecionado mudou desde a resposta original.
- **Mínimo privilégio nas ferramentas do modelo**: `execute_command` deixou de
  ser entregue ao chat. Antes ela estava disponível e o prompt pedia que não
  fosse usada — proteção que dependia de o modelo obedecer, com corpus não
  confiável entrando no contexto.
- **Âncoras clicáveis** até o arquivo `.syn`, rotuladas pela referência
  (`avelar2016 (2016): "Salienta-se que…"`). Requer grafo gerado por
  `synesis-graph` com `source_file`/`source_line`. São emitidas para as origens
  que **sustentam uma citação da resposta** — antes saíam de tudo que o turno
  consultou, incluindo o que o modelo explorou e descartou.
- **Métricas do chat: nomes honestos e `N/A`** (`src/chat/chatMetrics.js`).
  - `citationCoverage` virou `literalQuotePrecision` e passou a admitir `null`.
    Ela valia **1 quando não houve citação alguma** — cobertura perfeita e nada
    medido saíam idênticos no relatório —, e o nome prometia cobertura das
    afirmações quando media a precisão das citações detectadas. Afirmação sem
    citação é invisível a ela.
  - `allQueriesEmpty` classificava `{"records":[{"count":0}]}` como resultado,
    porque a linha existe; o próprio comentário do código dizia que `count: 0`
    deve valer como vazio. Agora distingue cinco casos: sem linhas, agregação
    zerada, linhas, não-JSON e erro.
  - As contagens vêm do `turnTrace`: chamadas de ferramenta reais, prefetch da
    extensão, falhas e consultas sem dado, separados.
  - O relatório registra **modelo, banco e data**, e avisa quando a sessão
    misturou modelos ou bancos — sem isso, uma troca no meio da sessão parecia
    diferença entre modelos.
  - O botão fica atrás de `synesisExplorer.chat.showMetricsButton`
    (desligado por padrão): enquanto não houver bateria por corpus, são
    diagnóstico exploratório, e um número oferecido por botão vira selo de
    qualidade. O comando continua na paleta.
- **O escopo das métricas de rede vem do grafo.** Quando o `ProjectContext`
  declara `metrics_backend`/`metrics_scope`, o chat diz qual backend calculou e
  sobre que projeção, em vez de repetir um texto fixo.
- **Busca lexical declarada pelo grafo** (`src/chat/lexicalCapability.js`).
  Quando o `ProjectContext` traz `fulltext_*`, o prompt ganha os identificadores
  exatos dos índices (`Chain[search_name, ontology_description]`) e a consulta
  SQL pronta. O chat também diz honestamente quando o analyzer é o
  `StandardAnalyzer`, que **não** dobra acento — apresentar a busca como
  insensível a acento nesse caso seria errado.
- **Contenção de caminho e multi-root nas âncoras** (`src/core/pathContainment.js`).
  O caminho vem do grafo — dado não confiável, possivelmente gerado noutra
  máquina ou servido por um ArcadeDB remoto —, e era resolvido com `path.join`
  contra a primeira pasta do workspace, sem verificação: um `../../..` escapava
  da raiz, e num workspace multi-root a âncora simplesmente não abria.
  - O destino precisa estar **dentro de uma pasta aberta**; caminho absoluto só
    é aceito se cair numa delas.
  - Todas as raízes são tentadas, a do editor ativo primeiro.
  - As origens recusadas aparecem no relatório do turno, com o motivo — um link
    ausente em silêncio parece bug do editor, não caminho fora da raiz.
- **A prosa exploratória não é mais emitida como resposta.** O texto que o modelo
  escreve antes de decidir consultar ("vou verificar quantos itens existem…")
  aparecia na tela como se fosse conclusão e entrava na verificação e nas
  métricas. Agora fica no relatório do turno, rotulado como raciocínio e
  explicitamente não verificado.

**Busca semântica e métricas do grafo**

- O chat passa a usar o **índice vetorial** do ArcadeDB quando o grafo declara
  tê-lo, e a **marcar o resultado como proximidade, não menção** — um vizinho
  vetorial é sugestão de leitura, não algo que o pesquisador afirmou.
- Passa a usar as **métricas de rede pré-calculadas** (`pagerank`,
  `betweenness`, `community`…) em vez de contar arestas à mão, e a dizer qual
  métrica usou.
- Ambas são condicionais ao schema real: um grafo sem vetores ou sem métricas
  não recebe a instrução.

**Métricas de sessão**

- Comando **Synesis: Métricas do Chat** e botão a partir do segundo turno:
  rodadas por resposta, cobertura de citação e abstenção em perguntas-armadilha.
  Nenhuma usa juiz LLM. Servem para comparar modelos no mesmo corpus.

**Idioma**

- Prompt de sistema em inglês, com regra explícita de **responder no idioma da
  pergunta** e nunca traduzir um trecho citado. Instruções em inglês melhoram a
  aderência sem impor o idioma da resposta.
- Interface (saudação, trilha, mensagens) segue em português.

### Fixed — chat

- **Ferramentas MCP não eram reconhecidas.** O VS Code renomeia ferramentas de
  MCP (`mcp_<servidor>_<ferramenta>`), e a comparação por nome exato não casava
  nada: o modelo respondia sem consultar, inventando bancos inexistentes.
- **Respostas inventadas quando não havia ferramenta.** O chat agora recusa
  responder e explica, em vez de produzir dado plausível.
- **`@synesis` sem pergunta quebrava** com erro do provedor. Agora apresenta o
  projeto, com dados lidos do grafo e perguntas sugeridas.
- **Perguntas complexas esgotavam o limite sem responder.** Teto subiu de 8 para
  16 rodadas e o aviso deixou de passar por rodapé: diz que a resposta está
  incompleta.
- **Prompt de sistema contraditório** sobre `list_databases` (mandava sempre
  chamar e nunca chamar).
- **Convenção de nomes presumida.** O prompt afirmava que conceitos são
  `snake_case` minúsculo — falso em projetos que usam `Acceptance_Criteria`.
  Agora manda ler os nomes reais do schema.
- **Busca sensível a acento dava falsa ausência.** Procurar `psicologicos` não
  encontra `psicológicos`, e o chat afirmava que o conceito não existia no
  corpus. Agora, **quando o grafo declara um índice full-text**, o chat usa
  `SEARCH_INDEX` — que resolve acento pelo analyzer do projeto, em vez de por
  uma transformação que o modelo faz de cabeça. Sem índice declarado (grafo
  antigo ou backend Neo4j), permanece a regra de prefixo sem diacrítico. Em
  qualquer caso, é proibido afirmar ausência sem ter tentado.

### Changed — o assistente aprende o schema do projeto em vez de presumi-lo

- `describeProjectSchema()` lê o schema real do banco a cada pergunta e o injeta
  no prompt: rótulo de conceito e arestas de taxonomia variam por template.
- O contexto do projeto (`ProjectContext`, gravado pelo `synesis-graph`) alimenta
  a saudação e as respostas. O `template_doc` (~6,5k tokens) só é carregado
  quando a pergunta precisa dele.
- **O gatilho do `template_doc` é estrutural, não lexical.** Ele carrega no
  primeiro turno da conversa, ou quando a pergunta não nomeia nada que o schema
  conheça. O critério anterior casava 26 palavras em português (`campo`,
  `escala`, `tópico`…): num corpus em inglês nenhuma casava, e o documento
  **nunca** era carregado — o chat perdia em silêncio a camada que o adapta ao
  projeto.
- **A taxonomia da saudação sai do schema.** A consulta fixava `GROUPED_BY` e
  `Topic`, que são o template do face85 e não um invariante do Synesis; um
  projeto sem `topic` perdia as sugestões sem dizer por quê. Agora a taxonomia,
  a aresta (incluindo `HAS_<CAMPO>`) e o rótulo exibido vêm do banco.
- **As sugestões de centralidade são condicionais.** Sugerir PageRank a um grafo
  que não o calculou — Neo4j, ou export sem métricas — entregava ao pesquisador
  uma pergunta que falha.
- **"Mais central" deixou de ter resposta única.** O prompt afirmava que PageRank
  é a métrica certa; centralidade é uma operacionalização metodológica, e a
  escolha é do pesquisador. O chat passa a oferecer os sentidos que o grafo
  suporta e a declarar qual usou. Também informa que, no ArcadeDB, as métricas
  são calculadas sobre o grafo inteiro — trechos, referências e taxonomias
  incluídos —, não só sobre a rede de conceitos.
- A regra de busca sem acento passou a falar em **diacrítico**, não em "vogal
  acentuada": o critério (maior prefixo sem diacrítico) vale em qualquer idioma.

### Security — o chat amplia a superfície de um workspace não confiável

- `capabilities.untrustedWorkspaces` passou a registrar que um `.vscode/mcp.json`
  vindo do workspace pode apontar para um host arbitrário, e que responder a uma
  pergunta envia a conversa ao provedor configurado com a API key do usuário.
  A descrição anterior só falava do language server e do `synesis-coder`.
- **Escrita de `mcp.json` é merge, nunca sobrescrita.** Outros servidores MCP
  configurados sobrevivem; colisão de nome pede confirmação explícita.
- Se o `mcp.json` existir mas não puder ser lido como JSON — o caso comum são
  comentários, que o formato aceita e o `JSON.parse` não —, o comando **aborta
  sem gravar**. Tratar "não consegui ler" como "arquivo vazio" apagaria em
  silêncio os servidores já configurados.
- As ferramentas MCP oferecidas ao modelo são filtradas por **nome exato**
  (`query`, `get_schema`, `list_databases`, `server_status` — `execute_command`
  não é entregue ao chat).
  O filtro anterior era por substring e capturava ferramentas de outros
  servidores MCP no mesmo workspace, como `gitnexus_query`. As demais que o
  ArcadeDB expõe (`profiler_*`, `*_server_setting*`) ficam de fora por serem de
  administração, e uma delas escreve.

### Changed — `engines.vscode` de `^1.82.0` para `^1.104.0`

- Exigido pelas APIs de chat acima: `registerLanguageModelChatProvider` só
  estabilizou no VS Code 1.104 (ago/2025). `@types/vscode` acompanhou, para os
  tipos não prometerem APIs que o editor mínimo não garante.
- **Consequência para usuários:** editores entre 1.82 e 1.103 deixam de receber
  atualizações da extensão. É o preço do chat embutido — não há como oferecer a
  funcionalidade com um mínimo mais baixo.

### Pendente de validação

- Só o provedor **Anthropic** passou por teste ponta a ponta. OpenAI, Gemini e
  OpenRouter seguem formatos de API confirmados, mas não foram exercitados pelo
  caminho real dentro do VS Code.
- O chat foi validado ao vivo apenas contra um corpus **em português**. A
  independência de idioma tem cobertura de teste, mas não verificação ao vivo.
- As respostas **não são streamed**: os providers fazem requisição
  não-streaming e a resposta aparece de uma vez.
- **A regra de unidade e a de divergência são instruções ao modelo**, não
  garantias verificadas. O dado que as sustenta é determinístico
  (`Item.annotation_id`, no `synesis-graph`), e o relatório do turno mostra a
  consulta que produziu cada número sem recontar — mas nada impede o modelo de
  desobedecer. Medir a adesão exige uma bateria por corpus.
- O relatório do turno mostra **todas** as consultas executadas, incluindo as
  exploratórias que o modelo descartou — de propósito, é o registro do percurso.
  As **âncoras**, essas, saem só das origens que sustentam uma citação. O que
  falta é o vínculo fino: qual evidência sustenta qual afirmação, o que exige um
  protocolo de marcação por afirmação.
- **A verificação de existência do arquivo não está no caminho de emissão.**
  `fileExists()` existe e é testável, mas emitir âncoras é síncrono e ligá-la
  mudaria a ordem do stream em relação ao aviso de literalidade. Uma âncora para
  um `.syn` renomeado desde o último sync ainda é oferecida e falha ao abrir.
- **A escolha de raiz em multi-root é heurística** — editor ativo, depois ordem
  das pastas —, não uma associação projeto↔banco. Dois projetos com um
  `face85.syn` cada resolvem para o do editor ativo, que pode não ser o do grafo
  consultado.
- **A bateria de perguntas por corpus não existe.** As perguntas-armadilha são
  globais e genéricas; um corpus que trate legitimamente de política monetária
  seria penalizado por elas. É o pré-requisito para o botão de métricas sair de
  trás de `synesisExplorer.chat.showMetricsButton`, e para
  `claimCitationCoverage` deixar de ser `N/A`.
- **Os recursos que dependem do grafo re-exportado** — contagem de trechos
  (`annotation_id`), `SEARCH_INDEX`, escopo das métricas — só aparecem em banco
  gerado pelo `synesis-graph` 0.9.0 ou posterior. Em grafo antigo o chat degrada
  para o comportamento anterior, e diz isso em vez de inventar.

### Changed — `engines.vscode` corrigido para `^1.82.0`

- O manifesto declarava `^1.60.0`, mas `vscode-languageclient@9` — já em uso —
  exige `^1.82.0`. O valor otimista permitia instalar a extensão em editores
  onde ela falharia em runtime, sem que o Marketplace barrasse.

### Changed — ESLint 8 → 10 e migração para flat config

- `.eslintrc.json` e `.eslintignore` foram **removidos**: o ESLint 9+ deixou de
  lê-los, e era a causa do CI vermelho no PR #10. Substituídos por
  `eslint.config.js`.
- A migração **não afrouxa nada**: mesmos 3 warnings de `no-unused-vars`, nos
  mesmos arquivos e linhas. A cobertura subiu de 51 para 53 arquivos —
  `.vscode-test.mjs` e o próprio `eslint.config.js` passaram a ser analisados.
- **`caughtErrors: "none"` fixado explicitamente.** O padrão mudou para `"all"`
  no ESLint 9, o que transformaria em warning todo `catch (error)` que não usa
  a variável — 4 casos legítimos neste repo, onde o bloco existe para engolir a
  falha de propósito. Fixar mantém a política de lint idêntica à anterior.

### Changed — Dependências de desenvolvimento atualizadas

- `@types/node` ^14 → ^26.2.0, `esbuild` ^0.20.2 → ^0.28.2,
  `mocha` ^10 → ^11.8.0, `@vscode/test-cli` ^0.0.12 → ^0.0.15,
  `@vscode/test-electron` ^3.0.0 → ^3.1.0.
- `@types/vscode` ^1.60.0 → `~1.82.0`, **casando com o `engines`**. Estava
  abaixo dele; tipos acima do engine expõem APIs que o editor mínimo não
  garante — compila e quebra na máquina do usuário.
- **Deliberadamente fora:** `vscode-languageclient` (10 exige VS Code ^1.91.0 —
  decisão de produto) e `chai` (5+ é ESM-only e 10 arquivos de teste usam
  `require`).

### Changed — `dependabot.yml`: majors saem do grupo

- O grupo `npm-dependencies` passa a aceitar apenas `minor`/`patch`; majors vêm
  em PR individual. O PR #8 juntou 9 pacotes com **6 majors** — incluindo
  `vscode-languageclient` e `chai` — num diff de 2 mil linhas, impossível de
  revisar ou reverter em partes.
- `vscode-languageclient` e `chai` passam a ignorar majors, com o motivo
  registrado no arquivo. `@types/vscode` é ignorado **por completo**: seu
  versionamento é 1.x (1.82 → 1.125 é *minor*), então ignorar só major não o
  alcançaria — como comprovou o PR #9, aberto minutos depois da primeira regra.
  Deve ser atualizado junto com `engines`, manualmente.
- `eslint` e `@eslint/js` também ignoram majors: o formato de configuração muda
  entre versões maiores, e migrar exige verificar que o conjunto de warnings não
  se altera.
- Mesmo padrão adotado no `synesis-lsp` para `pygls`/`lsprotocol`, onde a
  regressão reincidiu duas vezes.

## [0.12.0] - 2026-08-18

> As correções abaixo marcadas com **(LSP)** requerem `synesis-lsp` **0.23.0+**;
> a extensão sozinha não as entrega.

### Added — Seção **Source** no abstract viewer

- Os campos que o pesquisador escreve no bloco `SOURCE` do `.syn`
  (`description`, `method`, `epistemic_model`, …) passam a aparecer numa seção
  própria, entre os dados bibliográficos e o abstract, na ordem de declaração do
  template. Antes o cabeçalho vinha só do `.bib` e esses campos não tinham como
  chegar à tela. Requer `synesis-lsp` 0.23.0+ (ver detalhe em *Fixed*, abaixo).

### Fixed — Diagnósticos e contagem de uso (LSP)

- **`ITEM` com referência inexistente não acusava erro** — escrever
  `ITEM @barbieri20101` não produzia marca alguma no editor, embora
  `synesis compile` apontasse o erro. Também afetava `SOURCE` sem nenhum `ITEM`
  e conceito de ontologia declarado duas vezes. Requer `synesis-lsp` atualizado.

- **Hover dizia "Usado em 0 itens" para conceito usado em CHAIN** — o mesmo
  valia para a contagem no autocomplete, para o *Find All References* (que
  devolvia nada) e para o Graph View (que omitia o conceito). O painel **Codes**
  era o único lugar que já contava certo. Requer `synesis-lsp` atualizado.

### Fixed — Navegação levava ao bloco errado

- **Clicar numa referência no sidebar caía no meio de um ITEM anterior**
  (`src/explorers/reference/referenceExplorer.js`)
  - O cache do explorer resumia o estado em três números — quantidade de
    referências, nome da primeira e total de ocorrências. **Nenhuma linha entrava
    nesse resumo.** Editar o arquivo sem alterar contagens (inserir comentários,
    linhas em branco, reescrever a prosa de um `note`) produzia o mesmo resumo, o
    refresh era abortado e a árvore continuava servindo as linhas antigas. O
    clique navegava para uma posição já deslocada, tipicamente no meio do bloco
    anterior, com erro cumulativo a cada edição.
  - Explicava o caráter intermitente do defeito: adicionar ou remover um bloco
    mudava as contagens, o refresh acontecia e o problema se corrigia sozinho,
    apagando o rastro.
  - A localização (`file:line`) agora entra no cache, via
    `src/explorers/reference/referenceHash.js`. O formato segue o do
    `ontologyExplorer`, que já era imune ao defeito.

- **Um comentário acima de um bloco pertencia ao bloco anterior**
  (`src/viewers/abstractViewer.js`, `src/viewers/bibrefResolver.js`)
  - Requer `synesis-lsp` com a correção correspondente em `blocks.py`.
  - Com o cursor sobre `# Estudo de Silva 2020` escrito acima de `SOURCE
    @silva2020`, o *Show Abstract* abria o abstract da fonte **anterior**. Com o
    cursor num cabeçalho comentado no topo do arquivo, respondia *"No reference
    found"* — não havia bloco anterior a que se agarrar.
  - Um comentário escrito acima de um bloco o rotula; é assim que se lê na tela.
    Agora, quando tudo entre o cursor e o próximo bloco é comentário ou linha em
    branco, a referência resolvida é a do bloco **seguinte**. Havendo qualquer
    conteúdo real nesse intervalo, o comportamento anterior é mantido.
  - O caminho de fallback (parser local, usado quando o LSP não responde) passou
    a usar o mesmo resolvedor: antes tinha regra própria e podia divergir do LSP
    para o mesmo cursor.

### Fixed — `abstractViewer`

- **Campos do bloco SOURCE não apareciam em lugar nenhum**
  - O cabeçalho do viewer era montado inteiramente a partir do `.bib`. Os campos
    que o pesquisador escreve no bloco SOURCE do `.syn` (`description`, `method`,
    `epistemic_model`, …) não tinham por onde chegar à tela — sem erro, sem
    aviso. A conclusão natural era que o campo "não funciona".
  - Requer `synesis-lsp` com a chave `source` em `getExcerpts`. Com um LSP
    anterior, a seção simplesmente não é exibida.
  - Nova seção **Source**, entre os dados bibliográficos e o abstract, na ordem
    de declaração do template.

- **Campos de outros escopos poluíam a ordenação do card de ITEM**
  (`src/viewers/itemCardBuilder.js`)
  - O template declara três escopos (SOURCE, ITEM, ONTOLOGY) e todos entravam na
    ordenação dos campos do card, para depois serem descartados por não terem
    valor. Agora só os de escopo ITEM são considerados; campo sem escopo
    declarado continua tratado como ITEM.

- **Trechos não eram localizados no abstract "sem motivo aparente"**
  (`src/utils/fuzzyMatcher.js`)
  - Duas causas independentes, ambas invisíveis para quem usa:
    1. **Formas Unicode divergentes.** `ç` e `ã` podem ser um caractere ou dois,
       conforme a origem do texto. O abstract vem do `.bib` (com frequência
       extraído de PDF) e o excerpt é digitado — as duas grafias nunca casavam.
       Crítico em português.
    2. **Hifenização de PDF.** O abstract traz `socio-\neconomic`; o excerpt
       digitado é `socioeconomic`.
  - **Mudança de comportamento:** a busca passou a ser insensível a acentos —
    `critico` localiza `crítico`. Para localizar um trecho citado isso é
    desejável, já que o acento costuma ser o que se perde na extração do PDF. O
    trecho destacado preserva os acentos do texto original.

- **Destaques desapareciam do abstract e o rodapé mentia**
  - Quando dois ITEMs codificavam trechos que se cruzam — situação normal em
    codificação qualitativa — o segundo destaque era descartado em silêncio. O
    card continuava na legenda, com sua cor, prometendo uma marcação que não
    existia no texto.
  - O rodapé contava cards *com excerpt*, não destaques efetivamente desenhados:
    dizia "3 excerpts in abstract" havendo 2.
  - Agora o contador reflete o que está na tela, e o card não destacado exibe o
    motivo: `overlaps another excerpt` ou `not found in abstract`.

- **Fallback local nunca encontrava os ITEMs** (defeito latente)
  - Quando o LSP respondia `getBlocks` mas falhava em `getExcerpts`, o caminho de
    fallback comparava a referência com `@` contra a referência sem `@` — a
    comparação era sempre falsa e o viewer abria com *"No ITEM blocks found for
    this reference"*.

### Fixed — `synesis-coder`

- **O ITEM gerado era inserido depois do comentário da fonte seguinte**
  (`src/services/coderService.js`, via correção de ranges no LSP)
  - O ponto de inserção derivava do fim do bloco, que era estimado até o início
    do bloco seguinte — englobando comentários e linhas em branco. O texto novo
    caía no território visual da próxima fonte. Agora é inserido logo após o
    `END` do bloco.

## [0.11.0] - 2026-08-10

### Fixed — `abstractViewer`

- **Relações CHAIN eram uma lista fixa, escrita para outro projeto**
  (`src/viewers/abstractViewer.js`)
  - `isRelationToken()` comparava o token contra 11 nomes literais
    (`INFLUENCES`, `CONTESTED-BY`, …). Medido contra `face85.synt`, que declara
    11 relações: a lista **acertava 2** (`CAUSES`, `ENABLES`) e carregava **9
    nomes inexistentes** no projeto. As 9 relações reais restantes —
    `MEASURES`, `PART_OF`, `APPLIES`, `USES`, `INHIBITS`, `PREDICTS`,
    `CONTRASTS_WITH`, `ASSOCIATED_WITH`, `RELATES_TO` — renderizavam como
    `factor-tag`, **visualmente idênticas a um conceito**: `Trust MEASURES
    Acceptance` lia-se como três conceitos irmãos, não como uma relação.
  - Até `RELATES-TO` falhava: hífen na lista contra `RELATES_TO` (underscore) no
    template. A lista nunca se sincronizou com projeto algum.
  - Contradizia o princípio declarado no README — *"nothing is hardcoded […]
    relations […] come from the project template"* — dentro justamente da view
    cuja função é explicar o template a quem não lê Synesis.
  - Agora `buildRelationSet()` deriva o conjunto do registry do template, que o
    viewer **já recebia**. Sem `RELATIONS` declaradas (ou com LSP antigo), cai
    numa heurística estrutural (CAIXA_ALTA sem espaços) — nunca de volta a uma
    lista de nomes.

- **Campos MEMO não apareciam — defeito no LSP, não na extensão**
  - Corrigir a montagem do card não bastava: `synesis/getExcerpts` **nunca
    enviava** campos MEMO nem QUOTATION. O transformer do compilador promove
    `note`/`notes`/`memo`/`memos` para `item.notes` e `quote`/`quotation` para
    `item.quote`, fora de `extra_fields` — e o LSP serializava só
    `extra_fields`. No face85, `extra_fields` chegava com `text`, `zone` e
    `confidence`, sem o `memo` que todos os ITEMs têm.
  - Corrigido em `synesis-lsp 0.22.0` (`_reinsert_promoted_fields`, ver o
    CHANGELOG de lá). **Requer `synesis-lsp >= 0.22.0`**; com versão anterior o
    campo MEMO continua ausente, pois o dado não chega à extensão.
  - Do lado da extensão, MEMO é um campo comum — coberto por testes de regressão
    em `itemCardBuilder.test.js`.

- **Campos do template não chegavam à tela**
  - A montagem filtrava por 4 tipos (`QUOTATION`/`MEMO`/`CHAIN`/`CODE`) e emitia
    um objeto de forma fixa `{text, note, chain, codes}`. Todo `ENUMERATED`,
    `SCALE`, `ORDERED` e `TEXT` do template **não tinha para onde ir** e era
    descartado em silêncio.
  - Havia ainda `showCodes = !showChain && …`: os códigos sumiam sempre que o
    template tinha CHAIN — o caso comum.
  - O card agora renderiza **todos** os campos, na ordem de declaração do
    template, usando a `description` como rótulo legível (`zone` → "Zona
    retórica do trecho"). `ENUMERATED`/`ORDERED`/`SCALE` viram badge; texto
    longo ocupa a linha inteira.

- **Um bloco ITEM virava vários cards**
  - O laço `maxPairs` pareava a i-ésima note com a i-ésima chain — um
    pareamento **que não existe no dado**: são listas independentes, e o índice
    comum era invenção da renderização. Um ITEM com 4 chains virava 4 cards
    repetindo o mesmo trecho, cada um em cor diferente da paleta, sugerindo
    trechos distintos no abstract. `codes: i === 0 ? codes : []` deixava os
    códigos só no primeiro, fazendo os demais parecerem itens sem código.
  - Agora **um ITEM = um card**, com as chains agrupadas dentro dele. O contador
    passa a ser conferível contra o `.syn`: `N ITEMs · M chains · K excerpts in
    abstract` — o primeiro número casa com `grep -c "^ITEM" arquivo.syn`.

- **Duplicação entre os dois caminhos de extração**
  - `_buildExcerptsFromLspItems` e `_extractExcerptsLocal` eram quase idênticos
    (~90 linhas cada): toda correção precisava ser feita duas vezes e divergir
    era questão de tempo. A montagem foi extraída para
    `src/viewers/itemCardBuilder.js`, sem dependência de `vscode` — os dois
    caminhos apenas **normalizam** seus dados. Mesmo padrão de
    `src/lsp/sharedWatchTargets.js`, e pela mesma razão: testável em unidade.

### Fixed — `graphViewer`

- **Parte do grafo ficava inacessível com zoom**
  - `.mermaid-wrapper` usava `display:flex` com `justify-content/align-items:
    center`. Quando o conteúdo excede o container, a centralização transborda
    para **os dois lados**, e o overflow no início do eixo (esquerda/topo) fica
    fora do alcance do scroll — `scrollLeft = 0` já é o limite mínimo e a área
    cortada está em coordenada negativa.
  - O código tentava mitigar zerando o scroll a cada zoom (com o comentário
    *"so the left edge is never cut off"*), o que não recuperava nada e ainda
    jogava a vista para o canto a cada passo. Trocado por `display:block` +
    `margin:auto` no filho: centraliza quando cabe, encosta no início quando não
    cabe.

- **Zoom não preservava o ponto de interesse** — crescia a partir da origem,
  deslocando o que estava sob o cursor. `updateZoom()` agora aceita uma âncora e
  recalcula o scroll para mantê-la parada; a roda do mouse ancora no cursor.

### Added — `graphViewer`

- **Pan por arraste** — navegar só por scrollbars num grafo com zoom era
  desconfortável. Botão esquerdo arrasta o grafo, com o cursor sinalizando o
  estado (`grab`/`grabbing`), via Pointer Events com captura.

### Changed

- **`synesis.showGraph` renomeado** de "Show Relation Graph (All)" para
  **"Show Relation Graph per Source"**. O comando sempre filtrou pelo SOURCE sob
  o cursor (`_findBibref()` → `bibref` → `_triples_for_bibref` no LSP); o rótulo
  "(All)" prometia o projeto inteiro e entregava um SOURCE. O cabeçalho do painel
  passa a dizer `Scope:` em vez de `Reference:`, e o escopo por SOURCE se
  identifica como tal.
  - O grafo de **projeto inteiro** existe no servidor (`bibref=None`) e continua
    sem comando que o exponha. Deliberado: em `social_acceptance` são 1388+ nós,
    volume que trava o Mermaid. Depende do ranking top-N descrito em
    `synesis-planning/synesis-vscode/full_graph_explorer.md`.

### Added — testes

- `test/unit/itemCardBuilder.test.js` (21 testes) — um ITEM = um card, todos os
  campos, ordem do template, codes com chain presente, robustez.
- `test/unit/chainRelations.test.js` (16 testes) — as 11 relações do face85,
  rejeição de relações de outro projeto, `RELATES_TO` vs `RELATES-TO`, fallback
  sem template, escape de HTML.
- Suíte: 139 → **176 testes**.

### Nota para o `synesis-lsp`

`synesis/getTemplate` não envia a `description` dos campos
(`template_info.py:_serialize_fields`). O `abstractViewer` a usa como rótulo
legível e cai no nome do campo quando ausente — o caminho LSP hoje sempre cai.
Expor `description` (e o dict completo de `relations`, hoje reduzido a
`list(...keys())`, descartando a descrição de cada relação) tornaria os rótulos
e tooltips legíveis sem mudança na extensão.

## [0.10.0] - 2026-08-04

### Added — Snippets de bloco `FIELD`

- A extensão passa a contribuir **snippets** (`contributes.snippets`), até
  agora ausentes. Um por tipo de campo, acionados por prefixo no autocomplete:
  `field-chain`, `field-scale`, `field-ordered`, etc.

  ```
  field-chain  →  FIELD nome_do_campo TYPE CHAIN
                      SCOPE ITEM
                      ARITY >= 2
                      RELATIONS
                          NOME_DA_RELACAO: quando usar
                      END RELATIONS
                      DESCRIPTION o que este campo registra
                  END FIELD
  ```

  Resolve a lacuna de quem está **escrevendo** um template: até aqui o
  autocomplete só operava sobre campos de um template já existente, e não havia
  como descobrir que `CHAIN` exige `ARITY` e aceita `RELATIONS`.

- **`snippets/synesis.code-snippets` é gerado, não editado à mão.** Produzido
  por `synesis export-snippets` (compilador ≥ 0.10.0) a partir das regras da
  linguagem: quais propriedades entram em cada snippet derivam do validador.
  Regenerar com `npm run build:snippets` após mudanças na linguagem.

  O arquivo é commitado para que a extensão funcione sem exigir Python
  instalado, e leva cabeçalho `GERADO — NAO EDITAR A MAO`.

- **Nota de escopo:** o language id `synesis` cobre `.syn`, `.synt`, `.synp`,
  `.syno` e `.synr`, e snippets são registrados por linguagem — então eles
  também aparecem em arquivos de anotação. O prefixo `field-` mantém o ruído
  mínimo: só surgem depois que o pesquisador digita essa intenção.

### Added — Blocos de anotação vindos do servidor de linguagem

- Com `synesis-lsp >= 0.21.0`, digitar `SOURCE`, `ITEM` ou `ONTOLOGY` passa a
  oferecer o **bloco completo com os campos obrigatórios do template daquele
  projeto** — `slug`+`nome` em um, `lattes_id`+`nome`+`cargo_institucional` em
  outro. Snippets estáticos não teriam como saber disso; o LSP tem o template
  carregado.

- Degrada em silêncio: com LSP anterior a 0.21.0 os blocos simplesmente não
  aparecem, sem erro. Por isso `MIN_LSP_VERSION` permanece em `0.13.0` — ela
  guarda as *capabilities críticas* dos painéis, não features opcionais.

### Documentation

- README documenta os snippets na seção "What you get", distinguindo os dois
  níveis: os de `FIELD` vêm das regras do compilador; os de bloco vêm do LSP e
  por isso conhecem o template do projeto.

### Fixed

- **`CITATION.cff` estava defasado**: versão `0.5.30` (contra `0.9.1` no
  `package.json`), data de 2026-06-16 e `repository-code` ainda apontando para
  `synesis-explorer`, nome anterior do repositório. Os três corrigidos.

## [0.9.1] - 2026-08-03

### Note

- **Ecosystem license change does not affect this package.** `synesis`,
  `synesis-lsp`, `synesis-graph`, and `synesis-coder` migrated from MIT to
  AGPL-3.0-only + Synesis Data-Output Exception on 2026-08-02 (see
  `synesis-planning/synesis/new_licence_policy.md`). `synesis-vscode`
  **remains MIT** — it consumes the ecosystem only through external
  processes (JSON-RPC to the LSP, CLI to the coder), which does not trigger
  AGPL copyleft. This must stay true going forward: never bundle the
  compiler or LSP inside the `.vsix`.

## [0.9.0] - 2026-07-18

### Fixed

- **Keywords eram coloridas dentro de blocos `DESCRIPTION`** (`syntaxes/synesis.tmLanguage.json`)
  - Na gramática do compilador o corpo de `DESCRIPTION ... END DESCRIPTION` é
    texto livre (`description_lines: TEXT_LINE`), mas a grammar TextMate não
    tinha regra para o bloco: `FIELD`, `TYPE` e `SCOPE` apareciam coloridos no
    meio da prosa. Havia `guidelines_block` e nenhum equivalente para
    `DESCRIPTION`.
  - Adicionado `description_block`, espelhando `guidelines_block`. Só a forma de
    **bloco** casa (`DESCRIPTION` sozinho na linha); a forma inline
    (`DESCRIPTION texto`) continua sendo campo — se abrisse escopo, engoliria o
    resto do arquivo por não ter `END`.

### Changed

- **Lista de keywords do TextMate passa a ser particionada por volatilidade**
  - A lista escrita à mão divergia da gramática a cada construto novo — foi a
    causa de `IDENTIFIES`/`REFERS TO` ficarem sem cor. Em vez de "completá-la"
    (que só adiaria a próxima divergência), o critério agora é explícito:
    entram apenas keywords **estáveis**, cuja mudança quebraria todo arquivo
    `.syn`/`.synt` existente — essas não podem dessincronizar por definição.
  - Keywords da **fronteira em evolução** (`IDENTIFIES`, `REFERS`, `TO`, `ON`,
    `SHARED` — ligação multiprojeto) são deliberadamente omitidas: quem as
    colore é o LSP, derivando da própria gramática (`synesis-lsp>=0.19.0`).
  - Critério documentado na própria grammar (comentário `STABLE KEYWORDS ONLY`)
    e travado por teste, para que a lista não seja "corrigida" de volta.

### Added

- `test/unit/tmGrammar.test.js` — 6 testes que exercitam a grammar com o engine
  TextMate real (`vscode-textmate` + `vscode-oniguruma`), verificando os escopos
  atribuídos em vez de inspecionar as regex. Cobre os blocos de texto livre, a
  partição por volatilidade e a ausência de includes órfãos.

## [0.8.0] - 2026-07-15

### Added

- **Watcher da ontologia compartilhada — reintrodução deliberada de `FileSystemWatcher`** (`extension.js`, `src/lsp/sharedWatchTargets.js`)
  - Uma ontologia declarada com `INCLUDE SHARED ONTOLOGY` vive **fora** da pasta do projeto (outro drive, rede, `..`). O `onDidSaveTextDocument` — único mecanismo de refresh desde que os watchers foram removidos — **só dispara para documentos abertos no editor**, então uma ontologia alterada por `git pull`, por outra janela ou por outro processo nunca disparava revalidação: o projeto que a inclui ficava obsoleto em silêncio.
  - A extensão agora instala um `FileSystemWatcher` por alvo externo, usando o índice reverso `alvo → projetos` que o LSP devolve em `loadProject.sharedIncludes`. Quando um alvo muda (`onDidChange`/`onDidCreate`/`onDidDelete`), recarrega **apenas** os projetos que o declaram, com debounce de 300ms (um `git pull` pode reescrever o arquivo várias vezes seguidas).
  - Os watchers são re-sincronizados a cada `loadProject`: alvo que deixou de ser incluído tem o watcher descartado; alvo mantido só atualiza seu índice reverso, sem recriar o watcher.
  - **Reversão consciente:** os watchers foram removidos no passado como "redundantes com `onDidSaveTextDocument`", sob a premissa de que um projeto é auto-contido. `INCLUDE SHARED ONTOLOGY` invalida essa premissa — daí a reintrodução, agora escopada aos alvos externos em vez de um glob amplo do workspace.
  - Falha ao instalar um watcher nunca quebra a ativação: o projeto continua compilando, apenas sem auto-refresh naquele alvo.
  - Lógica de índice reverso extraída para `src/lsp/sharedWatchTargets.js` (sem dependência do módulo `vscode`) e coberta por 12 testes unitários, incluindo payload malformado e o caso de dois projetos compartilhando a mesma ontologia.

---

## [0.7.0] - 2026-07-13

### Added

- **Teste de contrato LSP↔extensão** (`test/unit/contract.test.js`, `test/contract/`)
  - Valida as fixtures do `projectBuilder.js` e uma cópia versionada dos JSON Schemas (fonte de verdade em `synesis-lsp/contracts/`) para os 4 custom requests. É a metade consumidora do contrato do diagnóstico D6 do Golden Standard: se o LSP mudar o formato de uma resposta, o CI da extensão fica vermelho junto com o do LSP. Adiciona `ajv` como dependência de dev.

### Changed

- **README reescrito para onboarding objetivo** (`README.md`, `images/docs/`)
  - Corrigidas divergências com o `package.json` que confundiam o usuário novo: atalho de "Go to Definition" era `F2` no README mas é `F12`; a tabela de painéis não indicava que vários só aparecem para o tipo de arquivo ativo (`.syn`/`.syno`). Adicionadas as seções ausentes: comando de codificação por IA (`Ctrl+Shift+I`, `synesis-coder`), as 8 configurações `synesisExplorer.*`, e troubleshooting.
  - Adicionado o passo `synesis init` (gera um projeto de exemplo completo e compilável), link para o cheatsheet da linguagem, e 8 screenshots das funcionalidades (painéis, grafo, abstract viewer) empacotadas em `images/docs/`. Estrutura em "Setup em 3 passos" + "Primeiros 60 segundos".
- **Metadados de marketplace** (`package.json`)
  - Adicionados `keywords` (descoberta na busca), `bugs`, `homepage`, e as categorias `Linters`/`Visualization`.

### Security

- **Sequestro do executável do LSP/coder via `.vscode/settings.json` de workspace não-confiável** (`package.json`, `src/lsp/executableGuard.js`, `extension.js`, `src/services/coderService.js`)
  - As configurações `synesisExplorer.lsp.pythonPath`, `synesisExplorer.lsp.args` e `synesisExplorer.coder.path` não tinham `scope`, então um `.vscode/settings.json` incluído numa pasta de projeto de terceiro (a extensão ativa em `workspaceContains:*.synp`) sobrescrevia o caminho do binário, que era passado direto para `child_process` — execução de código ao abrir o projeto.
  - Correção em três camadas: (1) as três settings agora são `"scope": "machine"` — não podem vir do workspace; (2) a extensão declara `capabilities.untrustedWorkspaces: limited`; (3) `executableGuard.resolveExecutable()` força o executável default quando o workspace não é confiável ou quando o caminho configurado resolve para dentro do workspace (defesa em profundidade contra um `.exe`/`.bat` embutido no ZIP do projeto). Cobre-se com `test/unit/executableGuard.test.js` (9 testes).
- **CI e supply chain** (`.github/`, `.pre-commit-config.yaml`)
  - Adicionado workflow de CI (lint + build + testes unitários + `npm audit`) — o repositório não tinha CI. GitHub Actions pinadas por SHA. `dependabot.yml` (npm + github-actions) e `SECURITY.md` adicionados.
  - Job `security` (renomeado de `audit`) agora também roda Gitleaks (varredura de segredos no histórico), e `.pre-commit-config.yaml` adicionado com Gitleaks + hooks genéricos — completa a Frente 1 do Golden Baseline nos três repositórios.

## [0.6.4] - 2026-07-07

### Changed

- **Espessura do ícone da Activity Bar ajustada** (`synesis-icon.svg`)
  - Adicionado `stroke="currentColor"` com `stroke-width="120"` ao contorno do monograma "S" — o traço fino original ficava visualmente mais apagado que os ícones vizinhos em 24px.

## [0.6.3] - 2026-07-07

### Changed

- **Ícone da Activity Bar atualizado** (`synesis-icon.svg`)
  - Substituído pelo monograma "S" estilizado (`s_synesis.svg`), adaptado com `viewBox` quadrado centralizado e `fill="currentColor"` para recolorir corretamente em temas dark/light.
- **Ícone da extensão atualizado** (`synesis-icon.png`)
  - Substituído pela nova logo (`s_synesis-bg.png`, 128×156px, fundo transparente) exibida na página de detalhes da extensão no VS Code e no Marketplace.

## [0.6.2] - 2026-06-25

### Changed

- **Ícone da extensão atualizado** (`synesis-icon.png`)
  - Substituído o ícone preto/branco anterior pela logo oficial do Synesis (gradiente ciano→verde com `{}` no centro).
  - Dimensões mantidas em 128×128px com fundo transparente — compatível com temas dark e light do Marketplace.

## [0.6.1] - 2026-06-23

### Changed

- README translated to English and rewritten for qualitative researchers.

## [0.6.0] - 2026-06-22

### Fixed

- **Zoom out corta a borda esquerda do grafo** (`src/viewers/graphViewer.js`)
  - `updateZoom` agora reseta `scrollLeft`/`scrollTop` do wrapper após cada redimensionamento do SVG.
  - Antes: ao fazer zoom-out depois de rolar para a direita, a borda esquerda ficava fora da área visível.

- **Título do grafo por item mostra arquivo e linha** (`src/viewers/graphViewer.js`)
  - Painel exibe `Item: @bibref L<linha> (<arquivo.syn>)` em vez de `Item: @bibref #N` — facilita verificar se o item correto está sendo consultado.

- **Show Relation Graph per Item — "No ITEM block found"** (`src/viewers/graphViewer.js`)
  - `_extractItemInfoFromSymbols`: ITEMs filhos de um SOURCE são nomeados `"ITEM #N"` pelo LSP (sem bibref). A função agora sobe o stack de símbolos para encontrar o símbolo pai `SOURCE @bibref` e extrai o bibref de lá.
  - Antes: grafo por item nunca funcionava em arquivos que contivessem um bloco `SOURCE`.

- **Show Relation Graph per File — "Sem relações no arquivo"** (`synesis-lsp/synesis_lsp/graph.py`)
  - Fix no servidor LSP: `_triples_for_file` agora verifica também `item.location.file`, não apenas `source.location.file`. Requer synesis-lsp com a correção correspondente.

- **Zoom do Graph Viewer não enquadra o grafo corretamente** (`src/viewers/graphViewer.js`)
  - Substituída a abordagem `transform: scale()` (que não alterava o espaço lógico do layout) por redimensionamento direto via `svg.setAttribute('width'/'height')`.
  - `naturalWidth`/`naturalHeight` extraídos do `viewBox` do SVG gerado pelo Mermaid — garante que zoom-in e zoom-out ajustam o tamanho real do SVG, permitindo scroll correto.
  - Auto-fit inicial recalcado com a mesma lógica de `viewBox`.

- **Mac keybinding — conflito `cmd+shift+i`** (`package.json`)
  - `synesis.showGraphPerItem` no Mac mudou de `cmd+shift+i` para `cmd+alt+i`, eliminando conflito com `synesis.coder.codeSelection` (que já usava `cmd+shift+i`).

### Added
- **Show Relation Graph per File** (`Ctrl+Alt+F`) — exibe o grafo Mermaid filtrando apenas as relações do SOURCE presente no arquivo ativo; bibref resolvido via LSP document symbols
- **Show Relation Graph per Item** (`Ctrl+Alt+I`) — exibe o grafo Mermaid filtrando apenas as relações CHAIN do ITEM sob o cursor; disponível no menu de contexto do editor e via keybinding
- **Template Fields explorer** — nova view "Template Fields" no painel Synesis: lista campos do template compilado agrupados por escopo (SOURCE / ITEM / ONTOLOGY); clicar num campo abre o `.synt` e posiciona o cursor diretamente na declaração `FIELD`; linha de destino fornecida pelo LSP via `synesis/getTemplate` (sem regex)
- **Comando `synesis.template.refresh`** — botão ⟳ na toolbar do Template Fields para forçar recarregamento após mudanças no template
- **`synesis/getRelationGraph` aceita parâmetro `item`** (LSP) — filtra triples apenas pelos chains do ITEM especificado; complementar ao filtro por `bibref` (SOURCE inteiro) já existente
- **`DataService.getRelationGraphForItem(itemBibref)`** — novo método que chama `synesis/getRelationGraph` com `{ item }` em vez de `{ bibref }`
- **`FieldSpec.line` / `FieldSpec.column`** serializados em `synesis/getTemplate` — localizações 0-based para navegação direta sem busca textual
- **`synesis/getBlocks` (LSP-first)** — `abstractViewer.js`, `coderService.js`: bibref detection migrada de regex local para endpoint LSP estruturado; fallback parser local mantido para quando LSP indisponível
- **`synesis/getTemplate` (LSP-first)** — `templateManager.js`: carregamento do template migrado de `templateParser.js` (regex) para LSP; cache com flag `fromLsp: true`; fallback `templateParser` mantido como transição
- **`DataService.getBlocks(file)`** e **`DataService.getTemplate()`** — novos métodos no `dataService.js` e `LspDataProvider`
- **`CoderService` recebe `dataService`** — construtor estendido para injeção de dependência; `_detectBibref` e `_findInsertionPoint` agora async e LSP-first
- **Infrastructure de testes** — harness completo com `@vscode/test-cli` + Mocha + Chai:
  - `test:unit` — 95 testes Node puro (<1s): `positionUtils`, `fuzzyMatcher`, `mermaidUtils`, `chainParser`, `dataService` (com `LspMock`)
  - `test:integration` — 15 testes Extension Host real (~7s): smoke de ativação + `DataService` com `vscode.workspace` real
  - Helpers: `test/helpers/lspMock.js`, `projectBuilder.js`, `treeAssertions.js`, `vscodeMock.js`
  - Fixtures: `test/fixtures/minimal/` (projeto Synesis mínimo válido)
  - Configuração: `.vscode-test.mjs`

### Changed
- **`extension.js`** — ordem de inicialização restruturada: `dataService` criado antes de `coderService`; `templateManager.setDataService(dataService)` injetado na ativação
- **`abstractViewer.js`** — `_findBibref` e `showAbstract` tornados async; helper `_bibrefFromBlocks` extraído como função de módulo
- **`coderService.js`** — `_detectBibref`, `_findInsertionPoint` e `codeSelection` tornados async; helper `_bibrefFromLspBlocks` extraído como função de módulo
- **`templateManager.js`** — adicionados `_dataService`, `setDataService()`, tentativa LSP-first em `loadTemplate()`
- **Scripts `package.json`**: `"test"` agora executa `test:unit && test:integration`; adicionados `test:unit`, `test:integration` (`vscode-test`), `test:watch`
- **`publisher`**: corrigido de `"synesis"` para `"synesis-lang"` em preparação para publicação no Marketplace

### Removed
- **`src/parsers/ontologyParser.js`** — código morto (zero consumidores confirmados por grep)
- **`test/runTest.js`** e **`test/suite/index.js`** — substituídos pelo harness `@vscode/test-cli`
- **`@vscode/test-electron`** como dependência direta (mantido implicitamente via `@vscode/test-cli`)

### Requires
- `synesis-lsp >= 0.16.0` (endpoints `synesis/getBlocks` e `synesis/getTemplate`)

---

## [0.5.30] - 2026-04-29

### Fixed
- **Zoom do Graph Viewer** (`src/viewers/graphViewer.js`)
  - Causa raiz: o `<script>` do webview não tinha atributo `nonce`, fazendo a CSP (`script-src 'nonce-{nonce}'`) bloquear silenciosamente todo o JavaScript customizado — botões +/−/Reset e scroll wheel não respondiam.
  - Atributo `nonce="${nonce}"` adicionado ao `<script>` tag principal.
  - Atributos `onclick="..."` substituídos por `id` nos três botões + `addEventListener` no script — inline event handlers são bloqueados por CSP mesmo com nonce.
  - `svg.getBBox()` envolvido em `requestAnimationFrame` para garantir que o SVG esteja pintado antes da leitura de dimensões no auto-fit inicial; guard `svgWidth > 0 && svgHeight > 0` adicionado para evitar cálculo com dimensões nulas.

---

## [0.5.29] - 2026-04-25

### Added
- **Suporte a `.synr` (formato de revisão do pipeline ACT)** (`package.json`)
  - A extensão `.synr` foi adicionada à lista de extensões da linguagem `synesis`.
  - Arquivos `.synr` recebem syntax highlighting, semantic tokens e associação de ícone idênticos aos arquivos `.syn` — o formato é sintaticamente compatível (comentários `# REVISION` e `# $key: value` são reconhecidos como `comment.line.synesis`).
  - Nenhuma mudança no atalho Ctrl+Shift+I (`synesis-coder item`) — contrato com a extensão inalterado.

---

## [0.5.28] - 2026-04-01

### Fixed
- **Synesis Coder — encoding UTF-8 no Windows** (`src/services/coderService.js`)
  - `execFile` agora injeta `PYTHONUTF8=1` e `PYTHONIOENCODING=utf-8` no
    ambiente do processo filho, garantindo que o Python escreva stdout em UTF-8
    mesmo em sistemas com code page cp1252 — corrige corrupção de acentos em
    textos em português retornados pelo `synesis-coder item`

## [0.5.27] - 2026-03-26

### Changed
- **Sidebar — redesign minimalista de todos os 5 explorers**
  - Redução de ruído textual: contadores verbosos (`N items in N files`, `N uses`, `N chains`) substituídos por badges `(N)` na `description`.
  - Caminhos de arquivo removidos dos labels dos filhos; substituídos por `Ln X` — nome do arquivo movido para o `tooltip` (visível ao passar o mouse).
  - **References**: nó raiz `@bibref (N)`, filho `Ln X (N)`.
  - **Codes**: nó raiz `código (N)`, filho `Ln X` com `chain` na description apenas quando aplicável; `not in ontology` preservado no tooltip do nó raiz.
  - **Relations**: nó raiz `RELAÇÃO (N)`, filho `A → B` com `Ln X` na description.
  - **Ontology Topics**: nó pai `tópico (N)`, nó folha `conceito Ln X`.
  - **Ontology Annotations**: nó raiz `código (N) · Ln X` (quando definido na ontologia) ou `(N) · not in ontology`, filho `Ln X` com `chain` quando aplicável.
- **Codes — `usageCount` corrigido**: contagem reflete ocorrências individuais; ordenação primária alfabética, secundária por frequência decrescente.

## [0.5.26] - 2026-03-26

### Changed
- **Sidebar — todas as 5 views melhoradas**
  - **References**: descrição `N items in N files` (singular/plural), tooltip com título da referência, cabeçalho `References (N)`
  - **Codes**: ordenação por frequência de uso decrescente, descrição `N uses` com sufixo `· not in ontology` quando não definido na ontologia, contexto de ocorrência exibe `code field` / `chain · fieldName`, cabeçalho `Codes (N)`
  - **Relations**: descrição `N chains` nos itens raiz, seta unicode `→` nos triplets, descrição `arquivo:linha` nos triplets filhos, cabeçalho `Relations (N)`
  - **Ontology Topics**: nós pai com ícone `tag` e descrição `N concepts`, nós folha com ícone `pin` e descrição `arquivo:linha`, cabeçalho `Ontology Topics (N)`
  - **Ontology**: descrição `N uses · arquivo:linha` (quando definido na ontologia) ou `N uses · not in ontology`, contexto de ocorrência exibe `code field` / `chain · fieldName`, cabeçalho `Ontology (N)`
- **References**: título da referência bibliográfica incluído no payload LSP e exibido como tooltip

## [0.5.25] - 2026-03-23

### Added
- **Synesis Coder integration** — `synesis.coder.codeSelection` command
  integrates `synesis-coder item` mode directly into the editor
  - **Context menu**: right-click selected text in a `.syn` file →
    "Synesis: Code Selection" generates an ITEM block via the `synesis-coder` CLI
    and replaces the selection atomically
  - **Keyboard shortcut**: `Ctrl+Shift+I` / `Cmd+Shift+I` (when editor has
    selection in a `.syn` file)
  - **Auto-detection of bibref**: reads the SOURCE/ITEM block under the cursor
    using `SynesisParser`; falls back to the nearest preceding block; prompts
    the user manually only when no block is found
  - **Progress notification** with Cancel button — calls `synesis-coder item`
    as a subprocess via `child_process.execFile` (shell-safe for text with
    quotes, newlines, and special characters)
  - **Cancellation support**: Cancel button kills the subprocess via
    `CancellationToken.onCancellationRequested → child.kill()`
  - Friendly error when `synesis-coder` is not installed (`ENOENT` → message
    suggesting `pip install synesis-coder`)
- **New configuration**: `synesisExplorer.coder.path` (default: `"synesis-coder"`)
  — path to the `synesis-coder` executable for non-default installations
- **New module**: `src/services/coderService.js` — `CoderService` class
  encapsulating bibref detection, CLI invocation, and editor replacement

## [0.5.24] - 2026-03-15

### Fixed
- **`WORD:` dentro de GUIDELINES ainda destacado como campo** (`syntaxes/synesis.tmLanguage.json`)
  - `match: ".+"` em `guidelines_content` usa `^.+$` para ancorar explicitamente ao início da linha.
  - `begin` do `guidelines_block` relaxado de `\s*$` para `\s*(?:#.*)?\r?$` — aceita comentários inline após `GUIDELINES` e trata CRLF (Windows) corretamente, evitando falha silenciosa na ativação do bloco.

## [0.5.23] - 2026-03-15

### Fixed
- **Conteúdo de GUIDELINES ainda destacado como keywords/chains/campos** (`syntaxes/synesis.tmLanguage.json`)
  - Defesa em profundidade: `#guidelines_block` agora incluído em **todos** os contextos (root, SOURCE, ITEM, ONTOLOGY, FIELD) — antes só estava em `meta.block.field.synesis`.
  - Novo `#guidelines_content` com `match: ".+"` consome cada linha inteira como `string.unquoted.guidelines.synesis`, impedindo qualquer sub-padrão (keywords, chains, fields) de casar dentro do bloco.
  - Cor do conteúdo: itálico neutro (`#a9b1d6` dark / `#6e6a86` light) — texto instrucional, não código.

## [0.5.22] - 2026-03-15

### Fixed
- **Conteúdo de GUIDELINES destacado como campos/keywords** (`syntaxes/synesis.tmLanguage.json`)
  - Campos com `begin`/`end` (`DESCRIPTION:`, `SCOPE:`, etc.) não tinham `GUIDELINES` como delimitador de fim — o campo anterior "vazava" e consumia as linhas do bloco GUIDELINES como valor de campo.
  - Fix: adicionado `|\\s*GUIDELINES\\b` ao padrão `end` de todos os quatro tipos de campo (`chain`, `code`, `text`, `generic`), forçando o campo a terminar quando a gramática encontra a linha `GUIDELINES`.

## [0.5.21] - 2026-03-15

### Added
- **Semantic Tokens ativados nos temas** (`themes/synesis-dark-theme.json`, `themes/synesis-light-theme.json`)
  - `"semanticHighlighting": true` em ambos os temas — o editor agora aplica colorização AST do LSP.
  - `"semanticTokenColors"` mapeando os 6 tipos do servidor (keyword, variable, property, string, enumMember, namespace) às novas paletas.
  - TextMate `tokenColors` atualizado para manter consistência como fallback.
- **Novas paletas de cores** ("Midnight Scholar" dark / "Parchment & Ink" light)
  - Dark: fundo `#1a1b26` (azul-noite); keywords `#bb9af7` (rosa-magenta); @bibrefs `#e0af68` (dourado); campos `#7dcfff` (azul-celeste); valores `#9ece6a` (verde-salvia); códigos `#2ac3de` (turquesa); relações `#f7768e` (coral).
  - Light: fundo `#faf4ed` (pergaminho); keywords `#8839ef` (púrpura-real); @bibrefs `#df8e1d` (âmbar); campos `#1e66f5` (azul-tinta); valores `#40a02b` (verde-floresta); códigos `#179299` (teal); relações `#d20f39` (vermelho).
- **semanticTokenScopes** em `package.json` — mapeia token types LSP para escopos TextMate, garantindo compatibilidade com temas de terceiros (Dark+, Monokai, etc.).
- **Configurações de feature toggle** (`package.json`)
  - `synesisExplorer.diagnostics.enabled` — habilita/desabilita squiggles de diagnóstico.
  - `synesisExplorer.inlayHints.enabled` — habilita/desabilita hints inline "(Author, Year)".
  - `synesisExplorer.semanticHighlighting.enabled` — habilita/desabilita colorização AST.
  - `synesisExplorer.completion.autoImportCodes` — inclui/exclui códigos ontológicos nas sugestões de autocomplete.
- **Middleware LSP** (`src/lsp/synesisClient.js`)
  - `_buildMiddleware()` intercepta respostas de diagnostics, inlayHints, semanticTokens e completion de acordo com as configurações do usuário.
  - Hot-reload: toggles funcionam sem reiniciar a extensão.
- **Capability Validation expandida** (`extension.js`)
  - `validateLspCapabilities()` agora verifica 11 capabilities (5 required + 6 optional).
  - Optional features (SignatureHelp, References, CodeActions, SemanticTokens, InlayHints, DocumentHighlight) logadas no Output channel como disponíveis/indisponíveis.

## [0.5.20] - 2026-03-15

### Fixed
- **Syntax highlighting não aplica keywords/fields dentro de GUIDELINES** (`syntaxes/synesis.tmLanguage.json`)
  - O bloco `meta.block.field.synesis` incluía `#keywords` e `#fields` sem contexto de bloco — `CODE:`, `CHAIN:`, etc. dentro de GUIDELINES eram destacados como nome de campo.
  - Fix: nova regra `guidelines_block` com `begin`/`end` marcando `GUIDELINES ... END GUIDELINES` como `meta.block.guidelines.synesis`; o conteúdo interno só aceita `#comments`, ignorando keywords e fields. Incluída no `meta.block.field.synesis` antes de `#keywords`.

## [0.5.19] - 2026-03-15

### Changed
- **Versões LSP e compilador no rodapé** (`extension.js`)
  - `setLspStatus('ready', stats, lspVersion, compilerVersion)` agora exibe `[LSP v0.14.26 · synesis v0.4.1]` diretamente no texto da status bar.
  - Tooltip inclui `— LSP vX.Y.Z · synesis vX.Y.Z` quando versões disponíveis.
  - Valores provêm de `lsp_version` / `compiler_version` retornados por `synesis/loadProject` (LSP v0.14.26+).

## [0.5.18] - 2026-03-15

### Fixed
- **Bug 2.6: fallback indevido em `synesisClient.js`** (`src/lsp/synesisClient.js`)
  - O catch em `_actualSendRequest` fazia fallback para `client.sendRequest()` em **qualquer** erro, não apenas `-32601 Method Not Found`.
  - Consequência: erros de runtime do LSP eram mascarados como "LSP method not supported", disparando `onLspIncompatible` e exibindo "LSP Incompatível" na barra de status.
  - Fix: condição alterada para `this._isMethodNotFound(error)` — o fallback só ocorre quando o servidor LSP realmente não registrou o método como `executeCommand`.

## [0.5.17] - 2026-03-15

### Changed
- **Performance — Fase 6: esbuild minification em produção** (`esbuild.js`)
  - Adicionado `minify: !isWatch` — bundle é minificado em `npm run build` / `vscode:prepublish`, mas não durante `--watch` (dev).
  - Source maps continuam gerados em ambos os modos (`sourcemap: true`).

## [0.5.16] - 2026-03-15

### Changed
- **Performance — Fase 5: Mermaid.js local + CSP** (`src/viewers/graphViewer.js`, `extension.js`, `media/mermaid.min.js`)
  - `media/mermaid.min.js` (~3.2 MB) adicionado como asset local da extensão — grafo funciona sem conexão de rede.
  - `GraphViewer` aceita `extensionUri` como segundo argumento; `extension.js` passa `context.extensionUri`.
  - `showGraphPanel` define `localResourceRoots: [extensionUri/media]` para autorizar acesso ao asset.
  - `getWebviewContent` adiciona `<meta http-equiv="Content-Security-Policy">` com nonce por requisição:
    - Asset local: `script-src 'nonce-{nonce}'` (sem CDN permitido)
    - Fallback CDN (se `extensionUri` não disponível): `script-src 'nonce-{nonce}' https://cdn.jsdelivr.net`
  - `<link href="https://rsms.me/inter/inter.css">` removido — fonte Inter substituída por `system-ui, sans-serif`.
  - `getNonce()` adicionado como função utilitária de módulo (32 chars alfanuméricos).

## [0.5.15] - 2026-03-15

### Changed
- **Performance — Fase 4: `synesis/getExcerpts` LSP + fallback local** (`src/viewers/abstractViewer.js`, `src/services/dataService.js`, `extension.js`)
  - `AbstractViewer` agora aceita `dataService` como terceiro argumento do construtor.
  - `_extractExcerpts()` tenta LSP primeiro via `dataService.getExcerpts(bibref)` (novo método `synesis/getExcerpts` do LSP v0.14.25); se bem-sucedido, monta excerpts a partir dos dados já em memória no servidor sem nenhum I/O de disco na extensão.
  - Novo método `_buildExcerptsFromLspItems()` converte o formato LSP (`extra_fields`, `codes`, `chains`) para o mesmo shape de excerpts da lógica original, usando o `templateManager` para identificar os campos QUOTATION/MEMO/CHAIN/CODE do template do projeto.
  - Método `_extractExcerptsLocal()` preserva integralmente a lógica anterior (leitura de arquivos + regex) como fallback: acionado se LSP não disponível, retornar null, ou lançar exceção.
  - `DataService` e `LspDataProvider` recebem método `getExcerpts(bibref)`.
  - Requer `synesis-lsp >= 0.14.25`.

## [0.5.14] - 2026-03-15

### Changed
- **Performance — Fase 3: Remover fallback local do graphViewer** (`src/viewers/graphViewer.js`)
  - Removidos `_findBibrefLocal()` (33 linhas), `this.parser = new SynesisParser()` e o `require('../parsers/synesisParser')`.
  - `_findBibref()` agora confia exclusivamente no LSP (`_findBibrefViaLsp` via `vscode.executeDocumentSymbolProvider`).
  - Se o LSP não estiver pronto, exibe mensagem clara ("Synesis LSP is not ready. Cannot resolve reference.") ao invés de fallback silencioso com parsing regex local.
  - `synesisParser.js` permanece no projeto pois ainda é usado por `abstractViewer.js` (Fase 4).

## [0.5.13] - 2026-03-15

### Changed
- **Performance — Fase 2: Cache de responses LSP + deduplicação de requests** (`src/lsp/synesisClient.js`, `extension.js`)
  - `SynesisLspClient` agora mantém um cache em memória (TTL 5s) para respostas dos métodos `synesis/*` (exceto `synesis/loadProject`, que sempre vai ao servidor).
  - Requests idênticos simultâneos (mesmo método + params) são coalescidos numa única Promise em voo — nenhum request duplicado sai pelo stdio enquanto o primeiro ainda não retornou.
  - `invalidateCache()` adicionado ao cliente e chamado em `runLspLoadProject()` antes de cada `synesis/loadProject`, garantindo que os refreshes subsequentes sempre buscam dados frescos após recompilação.
  - Erros de requests cacheáveis não são armazenados — em caso de falha a entrada não é criada, permitindo nova tentativa no próximo `refresh()`.
  - Efeito prático: os 5 calls de `refreshAllExplorers()` disparados após `loadProject` resultam em 5 requests reais na primeira vez; chamadas subsequentes dentro do TTL (ex: segundo `refreshAllExplorers()` por debounce tardio ou comando manual) retornam do cache sem overhead de stdio.

## [0.5.12] - 2026-03-15

### Changed
- **Performance — Fase 1: Debounce factory + refresh seletivo por tipo de arquivo** (`extension.js`)
  - Substituído o debounce timer único compartilhado por instâncias `Debouncer` independentes, eliminando o risco de cancelamento cruzado entre `onDidChangeActiveTextEditor` e outros handlers.
  - Adicionado mapa `FILE_REFRESH_MAP` e função `refreshExplorersForFileType(ext)`: ao salvar um arquivo, apenas os explorers afetados pelo tipo são atualizados:
    - `.syn` → Reference Explorer, Code Explorer, Ontology Annotations
    - `.syno` → Ontology Topics Explorer, Ontology Annotations
    - `.synt` → todos os explorers (template altera tudo)
    - `.bib` → Reference Explorer apenas
    - `.synp` → todos os explorers (projeto altera tudo)
  - Comportamento de múltiplos saves no mesmo debounce: se dois tipos distintos são salvos antes do timer de 1000ms disparar, o escopo mais amplo prevalece (`'all'` vence qualquer tipo específico).
  - Caminhos que continuam com refresh completo: startup inicial, comando `synesis.lsp.loadProject`, rename de código, rename de referência.
  - Nenhuma funcionalidade existente foi alterada — apenas a granularidade do refresh após save.

## [0.5.11] - 2026-03-06

### Added
- `syntaxes/synesis.tmLanguage.json`: keyword `GUIDELINES` adicionado ao grupo
  `keyword.control.field.synesis`, aplicando syntax highlighting ao bloco
  `GUIDELINES...END GUIDELINES` dentro de `FIELD...END FIELD`.
- `src/core/templateManager.js`: campo `guidelines` extraído de `fieldDef` e
  incluído no field registry via `buildFieldRegistry()`, tornando o conteúdo
  das guidelines disponível para consumidores da extension.

## [0.5.10] - 2026-02-06

### Fixed
- Code Explorer and Ontology (Annotations) refresh now detect rename changes reliably by using a full data hash and avoiding premature cache clears.
- Ontology Topics refresh now detects changes reliably using a full tree hash to prevent stale results.

### Removed
- Removed "Rename Code" from the Code Explorer context menu (F2 and editor context rename remain).

## [0.5.9] - 2026-02-06

### Fixed
- **CRÍTICO - Rename (F2) scope error**: `renameSymbol()` chamava `refreshAllExplorers()` que estava fora de escopo, causando `ReferenceError` em runtime
  - Bug: `refreshAllExplorers()` definida dentro de `activate()`, mas `renameSymbol()` está no escopo módulo
  - Resultado: rename aplicava edições mas refresh falhava silenciosamente
- **Rename refresh prematuro**: `refreshAllExplorers()` era chamado antes do LSP recompilar, retornando dados stale
  - Fix: command handlers agora chamam `runLspLoadProject()` após rename bem-sucedido
  - LSP recompila → `refreshAllExplorers()` → dados frescos garantidos
- **Arquivos não salvos após rename**: `applyEdit()` deixava arquivos em estado dirty, dependendo de auto-save
  - Fix: `renameSymbol()` agora chama `await vscode.workspace.saveAll(false)` após `applyEdit()`
  - Garante persistência no disco independente de configuração de auto-save

### Changed
- **`renameSymbol()` assinatura**: Agora retorna `boolean` (true=sucesso, false=falha) ao invés de `void`
  - Remove `refreshAllExplorers()` e `showInformationMessage` (movidos para command handlers)
  - Adiciona `saveAll()` após `applyEdit()`
- **Command handlers (`synesis.code.rename`, `synesis.reference.rename`)**:
  - Capturam retorno de `renameSymbol()`
  - Se sucesso: chamam `runLspLoadProject()` (que já chama `refreshAllExplorers()` internamente)
  - Mostram mensagem de sucesso após refresh completo

### Architecture
- **Fluxo correto**: `renameSymbol()` → `applyEdit()` → `saveAll()` → retorna true → command handler → `runLspLoadProject()` → LSP recompila → `refreshAllExplorers()` → mensagem ao usuário
- **Integridade referencial**: LSP rename (`rename.py`) já cobre CODE, CHAIN e ONTOLOGY via template-driven field discovery
- **Scope safety**: Todas as chamadas de `runLspLoadProject()` e `refreshAllExplorers()` agora dentro do escopo correto de `activate()`

### Technical Details
- Double-reload é inofensivo: `scheduleLspLoadProject()` (1000ms delay) dispara após `saveAll()`, mas explorers usam hash-based caching
- Se dados não mudaram, segundo refresh é ignorado (custo: uma chamada LSP extra sem impacto visual)
- Verificar: rename via F2, menu contextual, cancelamento (Esc), e integridade CODE+CHAIN+ONTOLOGY

## [0.5.8] - 2026-02-05

### Fixed
- **CODE duplication in Ontology Annotations Explorer**: Campos CODE agora aparecem apenas 1x (não duplicados)
  - Bug estava no LSP (synesis-lsp v0.14.14) - faltava deduplicação final em `ontology_annotations.py`
  - Fix foi server-side: adicionada função `_dedupe_occurrences()` em `ontology_annotations.py`
  - Nenhuma alteração necessária na extension
- **Refresh after Rename**: Explorers agora atualizam automaticamente após rename bem-sucedido (F2 ou menu contextual)
  - Adicionada chamada `refreshAllExplorers()` após `applyEdit()` na função `renameSymbol()`
  - UX imediato: usuário vê mudanças instantaneamente sem necessidade de salvar arquivo
  - Padrão consistente com refresh após save

### Changed
- **Dependency**: Requer synesis-lsp v0.14.14+ para funcionamento correto de occurrences CODE em Ontology Annotations Explorer

## [0.5.7] - 2026-02-05

### Fixed
- **CHAIN last-occurrence-only bug**: Code Explorer agora mostra TODAS as occurrences de códigos em campos CHAIN consecutivos, não apenas a última
  - Bug estava no LSP (synesis-lsp v0.14.13) - Phase 2 de `_dedupe_occurrences` colapsava occurrences próximas
  - Exemplo: CCS_Support aparecendo em 4 chains consecutivas agora mostra todas as 4 occurrences
  - Nenhuma alteração necessária na extension - fix foi server-side

### Changed
- **Dependency**: Requer synesis-lsp v0.14.13+ para funcionamento correto de múltiplas CHAIN occurrences

## [0.5.6] - 2026-02-05

### Removed
- **Client-side deduplication band-aid**: Removed `_deduplicateOccurrences()` method from DataService that used 10-line proximity heuristic
  - Method was removing legitimate occurrences and compensating incorrectly for LSP data issues
  - Root cause now fixed in synesis-lsp v0.14.12 via server-side deduplication
  - Removed calls in `getCodes()` (line 111) and `getOntologyAnnotations()` (line 241)

### Changed
- **Data flow architecture**: Extension now consumes clean data directly from LSP without client-side deduplication
  - Occurrences are used directly after normalization (line number conversion 1-based → 0-based)
  - usageCount reflects actual occurrence count from LSP
  - Simpler, more maintainable code path

### Technical Details
- Removed ~50 lines of code (method + 2 call sites)
- Performance improvement: eliminated O(n²) proximity comparison on every tree refresh
- Data integrity: no risk of legitimate occurrences being filtered out by heuristics
- Requires synesis-lsp v0.14.12+ for correct behavior

## [0.5.5] - 2026-02-05

### Fixed
- **Duplicate Occurrences**: Fixed CODE field occurrences showing duplicate entries (line exact + line block ITEM) - now only shows exact lines
- **Inconsistent Duplications**: Fixed ontologyAnnotationExplorer showing duplicate occurrences similar to CODE fields
- **TreeView Refresh Performance**: Fixed slow/laggy tree refreshes when clicking items

### Performance
- **Cache System**: Added intelligent caching in all explorers (Code, Reference, Relation, Ontology, OntologyAnnotation) to prevent unnecessary tree refreshes when data hasn't changed
  - Hash-based comparison of data before updating tree
  - Skips tree rebuild if data identical to previous refresh
  - ~80% reduction in unnecessary tree redraws
- **Removed File Watchers**: Eliminated redundant file system watchers that duplicated onDidSaveTextDocument functionality
  - Removed synesisWatcher and all handleFileChange handlers
  - Prevents double-refresh on file save
- **Optimized Refresh Strategy**: Reduced refresh frequency - only updates when file is saved and LSP confirms data changed
  - Removed redundant refresh calls on every file change event
  - ~70% reduction in refresh operations
- **Removed Excessive Logging**: Cleaned up console.log statements in DataService and all explorers for production performance
  - Removed ~20 debug logs per refresh cycle
  - ~90% reduction in console output
  - Kept only critical error logging
- **Debounced Active Editor Changes**: Added 200ms debounce to ontologyAnnotationExplorer refresh on editor changes
  - Prevents refresh spam when quickly switching editors

### Changed
- **DataService**: Added `_deduplicateOccurrences()` method to remove near-duplicate occurrences (within 10 lines)
  - Groups by file + context + field
  - Keeps most specific line (highest line number)
  - Removes duplicates within 10-line range
- **All Explorers**: Implemented data hash comparison to skip updates when data unchanged
  - CodeExplorer: `_hashData()` with count + first/last code + occurrence count
  - ReferenceExplorer: `_hashData()` with count + first ref + occurrence count
  - RelationExplorer: `_hashData()` with count + first relation + triplet count
  - OntologyExplorer: `_hashData()` with count + first topic + child count
  - OntologyAnnotationExplorer: `_hashData()` with activeFile + count + first code + occurrence count
- **Extension.js**: Removed file watchers, kept only onDidSaveTextDocument with LSP reload for cleaner refresh flow
  - Removed `synesisWatcher`, `handleFileChange`, `refreshSynFiles`, `refreshOntologyFiles`, `refreshProjectFiles`
  - Single refresh path via LSP reload only

### Technical Details
- Deduplication algorithm: groups occurrences by `file|context|field`, sorts by line descending, removes near-duplicates
- Cache invalidation: hash changes trigger tree rebuild, otherwise skips `_onDidChangeTreeData.fire()`
- Memory impact: minimal (~100 bytes per explorer for hash storage)
- Performance gain: O(1) hash comparison vs O(n) tree rebuild

## [0.5.4] - 2026-02-04

### Fixed
- **Code Explorer**: Occurrence counts now reflect resolved occurrences (CODE/CHAIN) instead of raw usage totals.
- **Go to Definition/Rename**: Symbol position resolution now validates the token location before invoking LSP.

## [0.5.3] - 2026-02-04

### Changed
- **File Watchers**: Consolidated from 4 separate watchers into 1 unified watcher with glob pattern `**/*.{syn,syno,synp,synt}`
- **Debounced Refresh**: Added 300ms debounce to file watcher refreshes to prevent cascade of multiple refreshes when multiple files change

### Removed
- **Editor Config Modification**: Removed automatic `wordWrap: on` setting that was modifying user preferences without consent

### Performance
- Reduced file watcher overhead by ~75% (4 watchers → 1)
- Eliminated redundant refresh calls via debouncing
- Removed blocking I/O during activation (editor config write)

## [0.5.2] - 2026-02-03

### Fixed
- **Relations/Codes/Ontology**: Improved path normalization (including `file://` URIs) to restore navigation to source locations.
- **Go to Definition**: Uses first occurrence with a valid file before falling back to text search.

### Changed
- **Ontology Explorers**: Now consume LSP-only data (`getOntologyTopics` / `getOntologyAnnotations`).
- **LSP Validation**: Added custom method checks for ontology endpoints.

## [0.5.1] - 2026-02-03

### Fixed
- **SynesisParser**: Fixed duplicate field handling - fields with same name now correctly accumulate in arrays instead of overwriting
- **AbstractViewer**: Fixed display of multiple notes and chains - now creates separate excerpts for each (note, chain) pair instead of concatenating all values
- **OntologyAnnotationExplorer**: Fixed crash when processing array field values - added proper array handling for duplicate fields
- **Code Explorer**: Fixed non-clickable occurrences - added null checks for file paths and fallback display when location unavailable
- **Relation Explorer**: Fixed non-clickable triplets - added null checks and visual feedback (question mark icon) for items without location
- **GraphViewer**: Added local fallback for bibref extraction when LSP not available - now works without LSP using SynesisParser
- **Explorer Titles**: Added visual feedback showing "(LSP Loading...)" during LSP initialization

### Added
- **Comprehensive Diagnostic Logging**: Added extensive console logging in DataService, CodeExplorer, RelationExplorer for troubleshooting
  - Logs workspaceRoot, raw LSP data, and processed file paths
  - Warnings for null/undefined file paths
  - Helps identify LSP data issues quickly
- **Null-Safe TreeItems**: Code and Relation explorers now handle missing file locations gracefully
- **Visual Indicators**: Items without locations show question mark icon and "(no location)" description
- **Documentation**: Created BUGS_FIXED.md documenting all issues and fixes, RELOAD_EXTENSION.md with testing instructions

### Changed
- **Field Value Collection**: `collectFieldValues()` in AbstractViewer now properly handles both string and array field values
- **Explorer Error Handling**: Explorers now continue working even when some items lack location data
- **Path Resolution**: Enhanced path resolution logging in DataService for easier debugging

### Technical Details
- Modified `_addFieldValue()` in SynesisParser to accumulate duplicate fields into arrays
- Updated `collectFieldValues()` to iterate over array values when present
- Added `_findBibrefLocal()` to GraphViewer with three fallback strategies (ITEM → SOURCE → inline)
- Enhanced OccurrenceTreeItem and TripletTreeItem with null checks before accessing file paths
- Added `updateExplorerTitles()` function for LSP status feedback

### Breaking Changes
None - all changes are backward compatible

### Known Issues
- GraphViewer may show all chains from project instead of filtering by bibref (LSP server issue, not extension)

## [0.5.0] - 2026-02-02

### Added
- **LSP Strict Mode Now Default**: `synesisExplorer.lsp.strict` now defaults to `true` for LSP-only operation
- **New LSP Endpoints Support**: Added DataService methods for `synesis/getOntologyTopics` and `synesis/getOntologyAnnotations`
- **LSP-Exclusive Methods**: Ontology methods added to exclusive methods set (no regex fallback)
- **Deprecation Warnings**: LocalRegexProvider logs warnings when fallback to regex parsing occurs
- **LSP Capabilities Validation**: Automatic validation of LSP server capabilities on startup with detailed warnings
- **Enhanced Debug Logging**: Comprehensive logging in DataService and GraphViewer for troubleshooting
- **Troubleshooting Guide**: New `LSP_TROUBLESHOOTING.md` with diagnostic checklist and common solutions

### Changed
- **100% LSP Coverage**: All data retrieval now operates via LSP by default
- **No Regex Fallback by Default**: Local regex parsing only used if LSP unavailable and strict mode disabled
- **Improved Error Messages**: Clearer warnings when LSP is required but unavailable
- **Configuration Description**: Updated `lsp.strict` setting description for better clarity

### Technical Notes
- DataService now includes `getOntologyTopics()` and `getOntologyAnnotations()` in public API
- Both new methods added to `DEFAULT_LSP_EXCLUSIVE_METHODS` constant
- LocalRegexProvider stub methods emit console warnings (deprecated)
- `_resolveLspMethodName()` and `_emptyResultFor()` updated to support new methods
- Requires Synesis LSP v0.13.0+ for full functionality

### Migration Guide
- Users with `lsp.strict: false` in settings will need to update to `lsp.strict: true` or ensure LSP is properly installed
- Existing installations with LSP v0.13.0+ will work seamlessly
- Fallback to regex still available by setting `synesisExplorer.lsp.strict: false`

## [0.4.1] - 2026-02-01

### Added
- `synesisExplorer.lsp.args` setting to pass command arguments to the LSP executable (e.g. `["-m", "synesis_lsp"]`)

## [0.4.0] - 2025-01-31

### Added
- **LSP Integration**: Full Language Server Protocol support with automatic fallback to local regex parsing
  - Synesis LSP client (`vscode-languageclient` v9.x) connecting to Python-based LSP server
  - DataService adapter pattern: LSP-first with silent fallback to local parsing
  - Configurable via `synesisExplorer.lsp.enabled` and `synesisExplorer.lsp.pythonPath`
  - Status bar indicator showing LSP connection state
  - `Synesis: LSP Load Project` command for manual project loading
  - Auto-reload on file save (`.syn`, `.syno`, `.synp`, `.synt`, `.bib`)
- **Go to Definition**: Right-click a code in the Code Explorer to navigate to its ontology definition (`.syno`)
  - Requires LSP for cross-file definition resolution
- **Rename Symbol**: Right-click to rename codes or references across all workspace files
  - `Rename Code` in Code Explorer context menu
  - `Rename Reference` in Reference Explorer context menu
  - Cross-file rename powered by LSP `textDocument/rename`
- **LSP-powered features** (automatic when LSP is connected):
  - Diagnostics (syntax error squiggles)
  - Semantic token highlighting
  - Document symbols (Outline view)
  - Hover information for `@bibref`, fields, and codes
  - Inlay hints (author, year) after `@bibref`
  - Go-to-Definition via `Ctrl+Click`
  - Autocomplete for `@bibrefs`, ontology codes, and template fields
  - Signature help for field types
  - Rename via `F2`

### Changed
- **Reference Explorer**: Now uses DataService instead of direct parser access
- **Code Explorer**: Now uses DataService; codes show differentiated icons for ontology-defined vs. usage-only
- **Relation Explorer**: Now uses DataService; `hasChains` context derived from data availability
- **Graph Viewer**: Now uses DataService (`getRelationGraph`); removed ~150 lines of local chain parsing
- Extracted `mermaidUtils.js` for reusable Mermaid graph generation

### Technical Notes
- DataService implements Adapter Pattern with `LspDataProvider` and `LocalRegexProvider`
- All explorers and Graph Viewer consume normalized data shapes from DataService
- LSP fallback is transparent: `_tryLspThenLocal()` with warning-level logging
- Bundle includes all new modules via esbuild

## [0.3.0] - 2025-01-14

### Added
- **Ontology Topics Explorer**: New tree view for browsing TOPIC, ORDERED, and ENUMERATED fields in `.syno` files
- **Ontology Annotations Explorer**: View ontology annotations directly from `.syn` files
- New commands: `synesis.ontology.refresh` and `synesis.ontology.filter`
- Conditional view visibility based on active file type (`.syn` vs `.syno`)

### Changed
- Views now dynamically show/hide based on file context
- Improved context awareness for ontology-related features

## [0.2.0] - 2025-01-14

### Added
- **Relation Explorer**: Tree view for CHAIN relations with triplet visualization (A → REL → B)
- **Graph Viewer**: Interactive Mermaid.js visualization for relation graphs
- **Abstract Viewer**: BibTeX abstract display with highlighted excerpts
- Chain parser for extracting relation triplets
- Keyboard shortcuts:
  - `Ctrl+Alt+G` (Mac: `Cmd+Shift+G`): Show Relation Graph
  - `Ctrl+Shift+A` (Mac: `Cmd+Shift+A`): Show Abstract
- File icon theme for Synesis and BibTeX files

### Changed
- Enhanced syntax highlighting with dark and light themes
- Improved parser performance for large files

## [0.1.0] - 2025-01-13

### Added
- **Initial release**
- **Reference Explorer**: Tree view listing all `SOURCE @bibref` with ITEM counts
- **Code Explorer**: Tree view for CODE and CHAIN field values
- Basic syntax highlighting for `.syn`, `.synt`, `.synp`, `.syno` files
- Workspace scanner for automatic file discovery
- Template manager with lazy loading and caching
- Navigation support (click to jump to source location)
- Auto-refresh on file save
- Regex-based parser (MVP solution)

### Technical Notes
- Parser uses regex instead of Lark.js due to Unicode property incompatibility (`\p{L}`)
- Fallback to default templates when `.synt` not available

## [Unreleased]

### Changed
- Removed local regex fallback; all data requests are LSP-only
- Removed `synesisExplorer.lsp.strict` setting (LSP is always required)

### Planned
- Smart snippets for ITEM/ONTOLOGY blocks
- Smart Paste command for quick item creation
- Ontology Explorers via LSP (requires new server endpoints)
- Abstract Viewer via LSP (requires new server endpoint)

---

[0.4.0]: https://github.com/synesis-lang/synesis-vscode/releases/tag/v0.4.0
[0.4.1]: https://github.com/synesis-lang/synesis-vscode/releases/tag/v0.4.1
[0.3.0]: https://github.com/synesis-lang/synesis-vscode/releases/tag/v0.3.0
[0.2.0]: https://github.com/synesis-lang/synesis-vscode/releases/tag/v0.2.0
[0.1.0]: https://github.com/synesis-lang/synesis-vscode/releases/tag/v0.1.0
