/**
 * chatParticipant.js - @synesis chat participant (Via B prototype).
 *
 * Handler manual de tool-calling: envia mensagem + tools MCP ao modelo
 * selecionado, coleta LanguageModelToolCallPart da resposta, invoca via
 * vscode.lm.invokeTool, devolve o resultado ao modelo, repete até o modelo
 * parar de chamar ferramentas. Não usa @vscode/chat-extension-utils —
 * implementação direta para deixar o loop visível e fácil de depurar
 * no protótipo.
 */

const vscode = require('vscode');
const { buildSystemPromptWithDatabase, getSelectedDatabase } = require('./databaseSelection');
const { verifyCitations, describeUnverified } = require('./citationGuard');
const { renderLexicalCapability } = require('./lexicalCapability');
const {
    classifyIdentity,
    collectObserved,
    dedupeAgainstTemplate,
    identityCandidates,
    rankingCandidates,
    renderIdentityGuidance,
    renderObservedProperties,
    undeclaredFrom,
    unwrapNode,
    sampleSizeFor
} = require('./observedProperties');

/**
 * Quantos campos textuais entram na contagem de distintos por vértice.
 *
 * Oito cobre com folga os identificadores plausíveis (aqui: `bibtex`,
 * `candidate_key`, `title`) sem montar uma consulta gigante num vértice com
 * dezenas de campos de texto.
 */
const IDENTITY_FIELD_LIMIT = 8;

/**
 * Acima de quantos vértices a contagem de distintos deixa de valer a pena.
 *
 * Medido contra o banco remoto: 198ms nos 3.027 `Source`, 8.929ms nos 249.735
 * `Item`. 50.000 deixa passar os vértices de identidade (candidatos, conceitos)
 * e barra os de anotação, onde a pergunta de chave não se coloca.
 */
const IDENTITY_MAX_VERTICES = 50000;
const { PrefetchCache, SLOT, mapWithConcurrency, PROBE_CONCURRENCY } = require('./prefetchCache');
const {
    buildAuditPrompt,
    extractOriginRecords,
    groupByOrigin,
    renderAuditTrail,
    renderTurnReport,
    traceQueries
} = require('./auditTrail');
const {
    TurnKind,
    captureModel,
    createTurnTrace,
    recordToolCall,
    traceToolTexts,
    classifyTurn,
    TurnTraceStore
} = require('./turnTrace');
const { streamSourceAnchors, workspaceRoots, originKey } = require('./sourceAnchor');
const { measureTurn, summarize, renderReport, TRAP_QUESTIONS } = require('./chatMetrics');
const { readConnectionStatus, describeNextStep } = require('./connectionStatus');
const { readActiveConnection, migrateLegacyConnection } = require('./connectionProfiles');
const { readConnection: readLegacyConnection } = require('./connectionSettings');
const { createGraphClient, describeTools, isGraphTool, invokeGraphTool } = require('./graphClients');

const PARTICIPANT_ID = 'synesis.chatAssistant';
const AUDIT_COMMAND = 'synesis.chat.auditTrail';
const REASSESS_COMMAND = 'synesis.chat.reassess';
const METRICS_COMMAND = 'synesis.chat.showMetrics';

/**
 * Teto de rodadas de tool-calling por pergunta.
 *
 * Era 8 e se mostrou baixo: uma pergunta legítima ("cite as referências sobre
 * o tema") esgotou o limite só explorando o schema, sem sobrar rodada para
 * responder. Perguntas que atravessam Chain → Item → Source gastam várias
 * chamadas antes da consulta útil.
 *
 * O teto existe para conter loop degenerativo, não para economizar chamada.
 * 16 dá folga para exploração honesta e ainda corta cedo o que travou.
 */
const DEFAULT_MAX_TOOL_ROUNDS = 16;

/**
 * Teto efetivo, configurável em `synesisExplorer.chat.maxToolRounds`.
 *
 * Lido a cada pergunta, não na ativação: mudar a setting passa a valer sem
 * recarregar a janela. Os limites vêm do próprio `package.json` (4–40), mas são
 * reaplicados aqui porque um `settings.json` editado à mão não passa por
 * validação — um `0` desligaria o loop em silêncio.
 */
function readMaxToolRounds() {
    const raw = vscode.workspace.getConfiguration('synesisExplorer.chat').get('maxToolRounds');
    const value = Number(raw);
    if (!Number.isFinite(value)) {
        return DEFAULT_MAX_TOOL_ROUNDS;
    }
    return Math.min(40, Math.max(4, Math.trunc(value)));
}

/**
 * O botão de métricas está habilitado?
 *
 * Padrão **desligado**. O comando continua na paleta para quem o procura — o que
 * muda é ele não ser oferecido a quem não pediu. A diferença importa porque
 * estas métricas ainda são diagnóstico interno: precisão literal não é
 * fidelidade, as perguntas-armadilha são genéricas, e uma sessão pode misturar
 * modelos e bancos. Oferecer o número por botão é o que o transforma, na
 * leitura, num veredito sobre qual modelo é melhor.
 */
function metricsButtonEnabled() {
    return Boolean(vscode.workspace.getConfiguration('synesisExplorer.chat').get('showMetricsButton'));
}

/**
 * Ferramentas do servidor MCP do ArcadeDB que interessam ao chat.
 *
 * Esta lista é um SUBCONJUNTO deliberado. Verificado por `tools/list` contra o
 * servidor real (ArcadeDB 26.7.3, 2026-08-22): ele expõe 10 ferramentas, e as
 * cinco de fora ficam de fora de propósito — `profiler_start`, `profiler_stop`,
 * `profiler_status`, `get_server_settings` e `set_server_setting` são de
 * administração do servidor, não de consulta ao grafo, e `set_server_setting`
 * ainda por cima escreve. Ao acrescentar ferramentas novas aqui, verifique se
 * são de leitura do grafo antes de expor ao modelo.
 *
 * **`execute_command` saiu daqui (Etapa 1).** Ela estava na lista e chegava ao
 * modelo, com o prompt mandando nunca usá-la — ou seja, a única proteção real
 * era a permissão da credencial do `mcp.json`. Mínimo privilégio é a defesa que
 * não depende de o modelo obedecer a uma instrução, e o corpus que entra no
 * contexto é conteúdo não confiável: uma injeção indireta que convença o modelo
 * a escrever não deve encontrar a ferramenta disponível.
 */
const ARCADEDB_TOOL_NAMES = ['query', 'get_schema', 'list_databases', 'server_status'];

/**
 * Casa o nome de uma ferramenta contra a lista acima, tolerando o mangling que
 * o VSCode aplica a ferramentas vindas de MCP.
 *
 * O nome NÃO chega cru. Verificado na fonte (`vs/workbench`, VSCode 1.125): o
 * editor monta `mcp_` + nome do servidor (minúsculo, caracteres inválidos
 * viram `_`, truncado em ~13 chars) + sufixo de desambiguação + nome da
 * ferramenta. Na prática `list_databases` do servidor `arcadedb-face85` chega
 * como algo próximo de `mcp_arcadedb-face_list_databases`.
 *
 * Uma versão anterior comparava por igualdade exata e por isso **não casava
 * nada**: o participant seguia sem ferramenta alguma e o modelo, sem meio de
 * consultar, inventava bancos que não existem (observado ao vivo em
 * 2026-08-22: respondeu "OmniGraph" e "master" para um servidor que só tem
 * `face85`).
 *
 * A checagem é ancorada no FIM do nome, não um `includes` solto: `..._query`
 * casa, `gitnexus_query_builder` não. A âncora no fim é o que evita voltar ao
 * problema original do filtro por substring, que capturava ferramentas de
 * outros servidores MCP do mesmo workspace — `gitnexus_query` está ativo neste
 * próprio repositório.
 *
 * Não dá para filtrar pela ORIGEM: a issue microsoft/vscode#280530 confirma
 * que `LanguageModelToolInformation` não expõe de qual servidor MCP a
 * ferramenta veio. Casar pelo sufixo do nome é o teto do que existe hoje.
 *
 * Trecho esperado no nome do servidor MCP, dentro do nome manglado.
 *
 * LIMITAÇÃO CONHECIDA: se o pesquisador nomear o servidor no `mcp.json` sem
 * "arcade" (ex.: `"grafo"`), as ferramentas deixam de ser reconhecidas e o
 * chat avisa que não há ferramenta disponível — em vez de responder errado.
 * O onboarding antigo (`mcpSetup.js`, removido na 0.14.0) gravava a chave
 * `arcadedb`, que é a que os `mcp.json` existentes costumam ter. Desde a 0.14.0
 * o chat consulta o banco direto (graphClients.js); este casamento só cobre
 * ferramentas MCP publicadas por outros meios. Falhar visivelmente aqui é preferível a afrouxar o casamento e voltar a
 * capturar ferramentas de outros servidores.
 */
const ARCADEDB_SERVER_HINT = 'arcade';

function matchesArcadeDbTool(toolName) {
    if (typeof toolName !== 'string' || !toolName) {
        return false;
    }

    const matchesKnownSuffix = ARCADEDB_TOOL_NAMES.some((known) => toolName.endsWith(`_${known}`));

    // Nome cru, sem mangling: aceita direto. É o formato que aparece se o
    // VSCode mudar de política, e o que os testes usam.
    if (ARCADEDB_TOOL_NAMES.includes(toolName)) {
        return true;
    }

    if (!matchesKnownSuffix) {
        return false;
    }

    // O sufixo sozinho NÃO basta: `gitnexus_query` e `mcp_neo4j_query` também
    // terminam em `_query`. O nome do servidor precisa aparecer no prefixo —
    // é o único vínculo com a origem que sobra, já que a issue #280530
    // confirma que a API não expõe de qual servidor a ferramenta veio.
    //
    // A comparação usa um trecho ('arcade') e não o nome inteiro do servidor
    // porque o VSCode trunca em ~13 caracteres: `arcadedb-face85` chega como
    // `arcadedb-face`. O usuário também escolhe esse nome no mcp.json, então
    // qualquer coisa mais rígida quebraria com um rótulo diferente.
    const prefix = toolName.slice(0, toolName.lastIndexOf('_'));
    return prefix.toLowerCase().includes(ARCADEDB_SERVER_HINT);
}

/** Seleciona as ferramentas do ArcadeDB entre todas as disponíveis. */
function selectArcadeDbTools(allTools) {
    return (allTools || []).filter((tool) => matchesArcadeDbTool(tool && tool.name));
}

/** Garante que os servidores MCP configurados estão ativos antes de ler vscode.lm.tools. */
async function ensureMcpServersStarted() {
    try {
        await vscode.commands.executeCommand('workbench.mcp.startServer', '*', { waitForLiveTools: true });
    } catch (error) {
        // Comando pode não existir em versões mais antigas do VSCode, ou não
        // haver servidor MCP configurado — não é fatal, só significa que
        // vscode.lm.tools pode vir vazio de fontes MCP.
        console.warn('Synesis Chat: falha ao iniciar servidores MCP', error);
    }
}

/**
 * As ferramentas de grafo deste turno, e por qual caminho elas vieram.
 *
 * O chat tinha um caminho só: ferramentas MCP publicadas em `vscode.lm.tools`,
 * reconhecidas por um filtro que exige a string `'arcade'` no nome do servidor.
 * Isso amarrava o chat ao ArcadeDB sobre TCP e excluía o Neo4j por construção.
 *
 * Agora o perfil ativo decide. Quando existe um, o transporte é o dele — HTTP
 * para o ArcadeDB, Bolt para o Neo4j — e o `mcp.json` deixa de participar: some
 * a dependência de o servidor MCP ter subido nesta janela, some a credencial
 * duplicada no workspace, e "salvei a conexão" passa a significar "o chat
 * consulta".
 *
 * O caminho MCP permanece como fallback para quem ainda não migrou. Não é um
 * segundo lugar de verdade: só é consultado quando NÃO há perfil ativo.
 */
async function resolveGraphTools(context) {
    // Traz a configuração da versão anterior para o modelo novo, uma vez só.
    // Sem isto, quem já tinha o chat funcionando o veria parar de funcionar ao
    // atualizar — e a mensagem diria para configurar algo que já estava feito.
    await migrateLegacyConnection(context, await readLegacyConnection(context));

    const connection = await readActiveConnection(context);
    if (connection) {
        const client = createGraphClient(connection);
        if (client) {
            return {
                tools: describeTools(connection.backend),
                client,
                profile: connection,
                viaProfile: true
            };
        }
    }

    // Sem perfil: comportamento anterior, via MCP.
    await ensureMcpServersStarted();
    return { tools: selectArcadeDbTools(vscode.lm.tools), client: undefined, viaProfile: false };
}

/**
 * Invoca uma ferramenta, seja ela local (perfil) ou MCP.
 *
 * Os dois caminhos devolvem `LanguageModelToolResult` com JSON em uma parte de
 * texto, que é o que `citationGuard`, `sourceAnchor` e a trilha de auditoria
 * leem. Uniformizar aqui é o que permitiu trocar o transporte sem tocar em
 * nenhum dos três.
 */
async function invokeAnyTool(client, name, input, token, invocationToken) {
    if (client && isGraphTool(name)) {
        // A validação de argumentos vive dentro de `invokeGraphTool`, então
        // cobre os dois backends do perfil (ArcadeDB e Neo4j). O caminho MCP
        // abaixo não passa por ela de propósito: o servidor MCP valida o próprio
        // contrato e já devolve o erro no vocabulário da ferramenta — o defeito
        // que a validação corrige era do caminho direto, onde um argumento vazio
        // virava um `HTTP 400 command missing` que o modelo não sabia ler.
        return invokeGraphTool(client, name, input);
    }
    return vscode.lm.invokeTool(name, { input, toolInvocationToken: invocationToken }, token);
}

async function runToolCallingLoop(model, initialMessages, tools, stream, token, systemPrompt, trace, client) {
    const maxRounds = readMaxToolRounds();
    let messages = initialMessages;
    const options = {
        tools,
        justification: 'Consultar o grafo Synesis via MCP.',
        // Lido pelos providers do Synesis, que o traduzem para o campo nativo
        // de cada API (`system`, `messages[0].role='system'`, `systemInstruction`).
        modelOptions: { system: systemPrompt }
    };

    // Acumulados para o juiz de citações (`citationGuard`): o texto que o modelo
    // escreveu e o payload cru que as ferramentas devolveram. Guardar aqui é o
    // que permite conferir sem uma segunda chamada ao modelo.
    //
    // `trace` recebe os MESMOS dados, com a estrutura preservada: rodada,
    // `callId`, input e status. É o que a trilha determinística lê depois — sem
    // ele, o botão só podia pedir a um novo ciclo do modelo que reconstruísse o
    // percurso, que é justamente o defeito que a Etapa 1 corrige.
    const toolTexts = [];
    let answerText = '';

    for (let round = 0; round < maxRounds; round++) {
        if (trace) {
            trace.modelRequests += 1;
            // **A identidade do modelo é reconfirmada aqui, no objeto que de
            // fato responde.**
            //
            // `request.model` é lido no início do turno, antes das leituras de
            // prefetch — e a própria API adverte: *"this is the model that is
            // currently selected in the UI; don't hold onto this past the
            // lifetime of the request"* (`vscode.d.ts`, `ChatRequest.model`).
            // Trocar de modelo no meio da sessão fazia o relatório nomear o
            // modelo anterior, e uma campanha que compara modelos atribuía o
            // turno ao errado — o pior tipo de erro numa medição.
            //
            // `model` aqui é o objeto passado a `sendRequest`, lido no instante
            // da chamada: é a identidade correta, aconteça o que acontecer com
            // a seleção da UI antes ou depois.
            captureModel(trace, model);
        }
        const response = await model.sendRequest(messages, options, token);

        const toolCalls = [];
        const assistantContentParts = [];
        // **O texto da rodada é acumulado, não emitido de imediato (Etapa 3).**
        //
        // Antes, todo `LanguageModelTextPart` ia direto para a tela — inclusive
        // a prosa que o modelo escreve ANTES de decidir chamar uma ferramenta
        // ("vou verificar quantos itens existem…"). Esse raciocínio
        // intermediário aparecia como se fosse resposta e ainda entrava em
        // `answerText`, contaminando o juiz, a trilha e as métricas.
        //
        // Sem custo prático: os providers do Synesis já fazem requisição
        // não-streaming, então a rodada inteira chega de uma vez de qualquer
        // forma. Streaming real pode voltar depois, com buffer por bloco.
        let roundText = '';
        for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                roundText += part.value;
                assistantContentParts.push(part);
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push(part);
                assistantContentParts.push(part);
            }
        }

        if (toolCalls.length === 0) {
            // Só agora se sabe que esta rodada é a resposta, e não um passo
            // exploratório: é o texto que o pesquisador deve ver.
            stream.markdown(roundText);
            answerText += roundText;

            // Resposta final: confere as citações contra os registros que o
            // banco devolveu — um a um, não contra a colagem de todos.
            const { unverified, supported } = verifyCitations(answerText, toolTexts);
            const warning = describeUnverified(unverified);
            if (warning) {
                stream.markdown(warning);
            }

            // Âncoras até o `.syn`: fecham a trilha do conceito ao texto que o
            // pesquisador escreveu. Saem do payload das ferramentas, não do
            // texto da resposta — reparsear a prosa do modelo seria confiar
            // justamente no que a âncora existe para verificar.
            //
            // Só as origens efetivamente CITADAS (Etapa 3): as exploratórias que
            // o modelo consultou e descartou viravam links sem afirmação
            // correspondente.
            const cited = new Set(
                [...supported.values()].map((record) => originKey(record.sourceFile, record.sourceLine))
            );
            // Multi-root e contenção (Etapa 5): todas as raízes abertas, a do
            // editor ativo primeiro. As origens recusadas — caminho fora da raiz
            // — vão para o trace, onde o relatório do turno pode explicá-las em
            // vez de simplesmente não mostrar o link.
            const { roots, preferredRoot } = workspaceRoots();
            streamSourceAnchors(stream, groupByOrigin(extractOriginRecords(toolTexts)), preferredRoot, {
                citedOnly: cited,
                roots,
                preferredRoot,
                onSkipped: (groups) => {
                    if (trace) {
                        trace.unanchorable = groups.map((group) => ({
                            file: group.file,
                            line: group.line,
                            bibtex: group.bibtex
                        }));
                    }
                }
            });

            if (trace) {
                trace.finalAnswer = answerText;
                trace.finishedAt = new Date().toISOString();
            }

            // **Respondeu sem consultar o banco.**
            //
            // É o modo de falha típico do modelo pequeno, e o mais perigoso:
            // ele produz um texto plausível sobre o corpus sem nunca chamar uma
            // ferramenta, e hoje isso era indistinguível de uma resposta boa. Um
            // registro com zero ITEMs já foi dado como OK por esse caminho.
            //
            // O aviso é o que torna legível uma campanha de "qual o menor modelo
            // que dá conta": sem ele, o modelo que ignora as ferramentas parece
            // ter respondido, e a medição registra sucesso onde houve invenção.
            //
            // A condição é **o modelo não chamou ferramenta**, e não "o turno
            // não tocou o banco": as leituras de prefetch ficam de fora de
            // propósito, porque elas acontecem sempre e não dizem nada sobre o
            // que o modelo fez.
            //
            // Consequência assumida: uma resposta legítima apoiada só no
            // `ProjectContext` ("quantos conceitos existem?" sai do resumo)
            // também recebe o aviso. É o lado seguro do erro — o texto diz para
            // tratar como hipótese, o que é verdade nesse caso, e o custo de
            // silenciar um modelo que inventa é muito maior.
            //
            // Note que a partir do 2º turno o cache de prefetch faz `toolCalls`
            // ficar vazio quando o modelo não consulta; o aviso continua correto
            // ali, porque continua sendo verdade que ele não consultou.
            const modelQueried = (trace ? trace.toolCalls : []).some((call) => !call.prefetch);
            if (!modelQueried) {
                stream.markdown(
                    '\n\n---\n\n⚠️ **Esta resposta não consultou o banco.** ' +
                        'Nenhuma ferramenta foi chamada neste turno, então o que está acima ' +
                        'vem do que o modelo já trazia — não do seu corpus. Trate como ' +
                        'hipótese, não como resultado.\n\n' +
                        'Se a pergunta era sobre os dados, refaça-a de forma mais concreta ' +
                        '(citando o conceito ou o campo de interesse); se o modelo ignora as ' +
                        'ferramentas de forma consistente, ele não serve para esta tarefa.'
                );
            }

            // `kind` substitui o antigo booleano `consultedCorpus`, que era
            // `toolTexts.length > 0` e por isso valia `true` para um payload de
            // schema ou uma consulta vazia — oferecendo trilha de evidência onde
            // não havia evidência. `rounds` e `toolTexts` alimentam as métricas
            // (Etapa H) sem custo extra: são o que o turno já produziu.
            return {
                answerText,
                kind: classifyTurn(trace),
                rounds: round + 1,
                toolTexts
            };
        }

        // A rodada teve tool call: `roundText` é raciocínio intermediário. Fica
        // no trace (explica por que o modelo consultou o que consultou) mas não
        // vai à tela nem a `answerText`.
        if (trace && roundText.trim()) {
            trace.intermediateText.push({ round: round + 1, text: roundText });
        }

        messages = [
            ...messages,
            vscode.LanguageModelChatMessage.Assistant(assistantContentParts)
        ];

        const toolResultParts = [];
        for (const call of toolCalls) {
            stream.progress(`Consultando ferramenta \`${call.name}\`...`);
            const startedAt = new Date().toISOString();
            try {
                const result = await invokeAnyTool(
                    client,
                    call.name,
                    call.input,
                    token,
                    stream.toolInvocationToken
                );
                toolResultParts.push(new vscode.LanguageModelToolResultPart(call.callId, result.content));

                // O payload cru é o que o juiz confere depois. Guardado aqui, no
                // caminho por onde ele efetivamente chegou — não reconstruído.
                const texts = [];
                for (const part of result.content || []) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        toolTexts.push(part.value);
                        texts.push(part.value);
                    }
                }
                recordToolCall(trace, {
                    round: round + 1,
                    callId: call.callId,
                    toolName: call.name,
                    input: call.input,
                    startedAt,
                    finishedAt: new Date().toISOString(),
                    status: 'ok',
                    texts
                });
            } catch (error) {
                const message = error.message || String(error);
                toolResultParts.push(
                    new vscode.LanguageModelToolResultPart(call.callId, [
                        new vscode.LanguageModelTextPart(`Erro ao chamar a ferramenta: ${message}`)
                    ])
                );
                // A falha entra na trilha: um relatório que mostra só o que deu
                // certo esconde justamente por que a resposta ficou pobre.
                recordToolCall(trace, {
                    round: round + 1,
                    callId: call.callId,
                    toolName: call.name,
                    input: call.input,
                    startedAt,
                    finishedAt: new Date().toISOString(),
                    status: 'error',
                    error: message
                });
            }
        }

        messages = [...messages, vscode.LanguageModelChatMessage.User(toolResultParts)];
    }

    // Chegar aqui significa que o modelo ainda queria consultar quando o teto
    // estourou — ou seja, NÃO houve resposta final. A nota discreta que ficava
    // aqui antes ("_limite de rodadas atingido_") passava por rodapé e deixava
    // o texto exploratório parecer uma conclusão. O aviso precisa dizer que a
    // resposta está incompleta.
    //
    // Desde a Etapa 3 o texto das rodadas não é emitido, então o aviso vem
    // primeiro e o raciocínio depois, explicitamente rotulado — em vez de o
    // pesquisador ler prosa exploratória e só no fim descobrir o que era.
    stream.markdown(
        `\n\n---\n\n⚠️ **Resposta incompleta.** Parei após ${maxRounds} consultas ao banco ` +
            'sem chegar a uma conclusão.\n\n' +
            'Tente uma pergunta mais específica (por exemplo, citando o conceito exato de interesse), ' +
            'ou pergunte antes pela estrutura: *"como Chain se conecta a Source?"*'
    );

    const reasoning = ((trace && trace.intermediateText) || [])
        .map((entry) => entry.text.trim())
        .filter(Boolean)
        .join('\n\n');
    if (reasoning) {
        stream.markdown(`\n\n---\n\n**Raciocínio intermediário** (não é a resposta):\n\n${reasoning}`);
    }

    // Teto estourado não é resposta: não vale oferecer trilha de evidência de um
    // texto que o próprio aviso acima declara ser raciocínio intermediário. O
    // trace continua guardado — as consultas feitas até aqui são justamente o
    // que explica por que o turno não concluiu.
    if (trace) {
        trace.finalAnswer = answerText;
        trace.finishedAt = new Date().toISOString();
        trace.incomplete = true;
    }
    return { answerText, kind: TurnKind.NONE, rounds: maxRounds, toolTexts };
}

/**
 * Parte fixa do prompt de sistema — vale com ou sem banco selecionado.
 *
 * A instrução sobre QUAL banco usar não mora aqui de propósito: ela é
 * condicional e é acrescentada por `buildSystemPromptWithDatabase()`. Uma
 * versão anterior mandava "sempre chame list_databases primeiro" neste texto
 * fixo e, quando havia banco selecionado, anexava "não chame list_databases" —
 * duas ordens contraditórias no mesmo prompt.
 */
/**
 * Trilha de auditoria: a regra que obriga a mostrar a origem de cada afirmação.
 *
 * O grafo já carregava a proveniência — `Item.citation` é o trecho literal que o
 * pesquisador anotou, ligado por `FROM_SOURCE` à referência — mas nada no prompt
 * mandava citar. O modelo respondia sobre o corpus sem dizer de onde tirou, e as
 * três origens possíveis chegavam com o mesmo tom de confiança: o que está num
 * trecho anotado, o que decorre do template, e o que ele sintetizou.
 *
 * Em pesquisa qualitativa essa indistinção é grave: uma citação errada atribuída
 * a um autor real é pior do que um erro óbvio, porque é a que passa despercebida
 * e chega ao texto publicado.
 *
 * **Ordem quote-first, e não é estilo.** Mandar imprimir o trecho ANTES da
 * síntese muda o que o modelo está fazendo: a citação vem da ferramenta, então
 * gerá-la primeiro é essencialmente cópia, não geração — e a evidência fica na
 * janela imediata quando a síntese começar. Escrevendo a resposta primeiro, o
 * modelo tende a forjar uma citação que valide o que já afirmou.
 *
 * A condição é o que o modelo ENCONTROU, não o tipo de pergunta: "cite quando a
 * afirmação vier de trechos". Classificar a pergunta por palavra-chave erraria
 * nos dois sentidos, e citação em resposta que não é sobre o corpus ("quantos
 * conceitos existem?") é ruído que treina o pesquisador a ignorar a trilha —
 * o oposto do objetivo.
 */
/**
 * Contagem: ao banco, não de cabeça.
 *
 * Observado ao vivo (2026-08-24). Perguntado pelos conceitos do tópico
 * "Finanças", o modelo navegou artigo por artigo e **contou enquanto lia**.
 * Errou: disse 8 artigos (são 9), `souza2022c: 6` (são 3), `correa2012: 8`
 * (são 6). A auditoria seguinte encontrou tudo — e gastou 16 rodadas, estourando
 * o teto antes de concluir.
 *
 * As citações estavam todas corretas; o juiz não acusou nada. **O defeito é
 * específico: quantidade afirmada sem consulta que a produza.** Modelos contam
 * mal por natureza; o banco não.
 *
 * O custo agrava o erro: verificar em série o que o Cypher agrega numa consulta
 * gasta o orçamento de rodadas e ainda perde a conta no caminho. A distribuição
 * inteira que custou quinze consultas sai de uma:
 *
 *     MATCH (c:Chain)-[:GROUPED_BY]->(t:Topic {name:'Finanças'})
 *     MATCH (c)<-[:MENTIONS]-(i:Item)-[:FROM_SOURCE]->(s:Source)
 *     RETURN s.bibtex, count(DISTINCT c.name) ORDER BY 2 DESC
 *
 * Por que isto importa além da precisão: a auditoria (Etapa F) confere a
 * resposta anterior. Se ela contradiz números a cada turno, o pesquisador deixa
 * de confiar nas duas — na primeira resposta porque erra, na auditoria porque
 * discorda. A divergência tem de ser exceção, não rotina.
 */
const COUNTING_RULES =
    'Counting — never from memory:\n' +
    '- **Every quantity you state must come from a `count()` in the database.** ' +
    'If you did not run a query that produced the number, do not state it. ' +
    'Counting while you read results is unreliable, and a wrong count discredits ' +
    'the correct parts of your answer.\n' +
    '- **Aggregate instead of iterating.** Before repeating the same query ' +
    'varying one value, ask whether `count()` with grouping answers it in one ' +
    'call. `RETURN s.bibtex, count(DISTINCT c.name)` gives the whole ' +
    'distribution at once — running one query per concept wastes your query ' +
    'budget and is exactly where miscounts creep in.\n' +
    '- Use `count(DISTINCT x)` when the same row can repeat: one `ITEM` block ' +
    'with several chains yields several `Item` vertices for the same excerpt, so ' +
    'a plain `count()` inflates the number.\n' +
    // A regra que faltava, e o defeito que ela corrige: um número sem unidade
    // não é comparável com nada, e foi comparar menções com trechos que fez uma
    // auditoria contradizer uma resposta correta.
    '- **Always name the unit.** Never write a bare number: write "20 mentions", ' +
    '"11 excerpts", "8 distinct concepts". The same corpus answers different ' +
    'numbers to different units, and a bare number cannot be checked against ' +
    'anything:\n' +
    '  - **sources** — `count(DISTINCT s.bibtex)`\n' +
    '  - **annotated excerpts (ITEM blocks)** — `count(DISTINCT i.annotation_id)`\n' +
    '  - **analytical items** — `count(DISTINCT i.item_id)`; one excerpt with four ' +
    'chains is four items\n' +
    '  - **mentions** — the `MENTIONS` edges, `count(*)` over the match\n' +
    '  - **concepts** — `count(DISTINCT c.name)`\n' +
    '  If the graph has no `annotation_id` (older `synesis-graph`), say that ' +
    'excerpt counts are unavailable rather than substituting item counts.\n' +
    '- **Before finishing, re-read your own numbers.** For each quantity in your ' +
    'answer, confirm it came from a query result you actually received. If any ' +
    'did not, either query for it or drop the claim — do not estimate.\n' +
    // Regra de divergência (Etapa M). Bloqueadora de propósito: uma auditoria
    // que contradiz sem estar certa destrói a confiança nas duas respostas, e é
    // pior do que não auditar.
    '- **Disagreeing with an earlier number is a hypothesis, not a verdict.** ' +
    'Before contradicting a count from a previous answer, first check whether ' +
    'the two numbers use the SAME unit. If they do not, they are not in ' +
    'conflict — say which unit each one measures and stop. If they do, re-run ' +
    'the original query, show it, and only then report the difference. Never ' +
    'announce that an earlier answer was wrong on the strength of a query you ' +
    'wrote differently.';

const CITATION_RULES =
    'Audit trail — the researcher must know where every claim came from:\n' +
    // A ressalva de compatibilidade ficava NESTA linha ("podem não existir em
    // grafos antigos — siga sem eles") e virou permissão para omitir: o modelo,
    // otimizando a consulta, deixava `source_file`/`source_line` de fora, e sem
    // eles no payload a âncora até o `.syn` (Etapa G) não tem o que ancorar.
    // Observado ao vivo. A tolerância continua existindo — mas como tratamento
    // de ERRO, na regra separada abaixo, não como alternativa oferecida de saída.
    '- When querying the corpus, **always** return in the SAME query, without ' +
    'exception: `i.citation`, `i.source_file`, `i.source_line`, `i.item_id`, ' +
    '`s.bibtex`, `s.title`, `s.year`. `source_file`/`source_line` are the trail ' +
    'back to the annotation file — without them the researcher cannot verify ' +
    'your answer.\n' +
    '- Only if the query **fails** because a property does not exist (graph built ' +
    'by an older `synesis-graph`), retry without `source_file`/`source_line`. ' +
    'Never omit them pre-emptively.\n' +
    '- **Quote first, analyse second.** Print the literal text the tool returned, ' +
    'and only then write your synthesis. Never write the conclusion before the ' +
    'evidence, and never reword a quotation.\n' +
    '- Format: `> "literal excerpt" — Author (year)`.\n' +
    // O vínculo afirmação → evidência. Sem ele, uma resposta com dezenas de
    // citações não diz qual sustenta qual frase, e a aparência de rigor cresce
    // mais rápido que o rigor.
    '- **One quotation belongs to exactly one excerpt.** Never join text from two ' +
    'different records into a single quotation, not even with `(...)`. If two ' +
    'excerpts support a claim, quote them separately.\n' +
    '- When a claim rests on a specific excerpt, mark it: write the claim, then ' +
    'the excerpt that supports it. Keep each claim next to its own evidence ' +
    'rather than listing every excerpt and then every conclusion — the researcher ' +
    'needs to see which excerpt backs which statement.\n' +
    '- If a claim of yours has **no** excerpt supporting it, say so explicitly ' +
    'instead of stating it in the same tone as the supported ones. Always ' +
    'distinguish three origins: what is in the excerpts, what comes from the ' +
    "project's template, and what is your own synthesis.\n" +
    '- Questions about the template or about graph structure (counts, labels) do ' +
    '**not** need an excerpt citation — attribute them to the template or the ' +
    'schema and move on.\n' +
    '- Empty query result: answer that the corpus does not support the claim. Do ' +
    'not fill the gap with your general knowledge of the subject.\n' +
    // O idioma da RESPOSTA é o do pesquisador, não o desta instrução. Instruir
    // em inglês melhora a aderência (é a maior parte do treino dos modelos) sem
    // impor o idioma da saída — é a separação que ferramentas profissionais
    // fazem: instrução em inglês, resposta na língua de quem perguntou.
    '- **Answer in the language of the question.** These instructions are in ' +
    'English; your reply must not be. Quotations are always reproduced verbatim ' +
    'in the original language of the corpus — never translate an excerpt.\n\n' +
    // Instrução negativa ("não invente") é justamente a que modelos menores
    // ignoram com mais frequência; padrão bate melhor que regra. Precedente
    // local: um modelo fraco produziu registro com ZERO ITEMs marcado como OK,
    // sintaticamente válido — a prosa não bastou.
    'Expected behaviour when there is no support (Portuguese corpus example):\n' +
    'Tool returned: `{"records": []}`\n' +
    'Reply: "O corpus não tem trechos anotados que sustentem uma afirmação sobre ' +
    'este tema. Isso não significa que o tema seja irrelevante — significa que não ' +
    'foi anotado neste projeto. Verifique os termos de busca ou o template."\n\n' +
    'The same, for an English corpus:\n' +
    'Tool returned: `{"records": []}`\n' +
    'Reply: "The corpus has no annotated excerpts supporting a claim about this ' +
    'topic. That does not mean the topic is irrelevant — it means it was not ' +
    'annotated in this project. Check your search terms or the template."\n\n' +
    'Expected behaviour when there IS support:\n' +
    'Tool returned an excerpt from `ashworth2019` (2019).\n' +
    'Reply: "> \\"male respondents (...) were more likely to support CCS\\" — ' +
    'ashworth2019 (2019)\n\n' +
    'The excerpt links gender to acceptance. **My synthesis:** this converges with ' +
    'the risk-perception pattern, but that connection is my reading, not in the ' +
    'excerpt."';

const SYSTEM_PROMPT =
    'You are the Synesis assistant. You have access to an ArcadeDB MCP server with ' +
    'read-only tools: list_databases, get_schema and query. Prefer Cypher ' +
    '(language: "cypher") for graph questions. No write tool is available to you — ' +
    'this database is read-only for the chat.\n\n' +
    // O modelo não conhece o modelo de dados do Synesis, e descobri-lo por
    // tentativa e erro consome rodadas inteiras — foi o que esgotou o limite
    // numa pergunta legítima sobre referências bibliográficas.
    //
    // IMPORTANTE: só entra aqui o que é INVARIANTE entre projetos Synesis.
    // O rótulo do conceito e as arestas de taxonomia dependem do template
    // (.synt) de cada projeto — ver `describeProjectSchema()`, que lê o schema
    // real do banco. Fixar aqui o vocabulário de um projeto específico faria o
    // assistente errar em todos os outros.
    'Structure common to every Synesis graph (qualitative research):\n' +
    '- `Source` — the bibliographic reference (title, bibtex, abstract, method).\n' +
    '- `Item` — one analysed excerpt of a Source (item_id, citation, description). ' +
    '`citation` is the literal annotated text; `source_file`/`source_line` point to ' +
    'the `.syn` file and line it came from — the audit trail back to the original ' +
    'annotation.\n' +
    '- A **concept** vertex, whose label varies by project (may be `Chain`, ' +
    '`Concept`, `Code`…): it has `name` and `ontology_description`.\n' +
    '- **Taxonomy** vertices, also project-specific (`Topic`, `Aspect`, ' +
    '`Dimension`…), derived from the fields declared in the project template.\n\n' +
    'Invariant edges, with the direction that matters:\n' +
    '- `(Item)-[:FROM_SOURCE]->(Source)` — which reference the excerpt came from.\n' +
    '- `(Item)-[:MENTIONS]->(concept)` — which concepts the excerpt mentions.\n' +
    '- `(concept)-[:RELATES_TO]->(concept)` — relation between concepts.\n' +
    'Taxonomy edges follow the template field: `GROUPED_BY` (topic), ' +
    '`QUALIFIED_BY` (aspect), `BELONGS_TO` (dimension), `RATED_AS` (confidence), ' +
    'or `HAS_<FIELD>` for any other declared field.\n\n' +
    'To go from a concept to its references, already bringing the evidence ' +
    '(replace `Chain` with the real label):\n' +
    '`MATCH (c:Chain)<-[:MENTIONS]-(i:Item)-[:FROM_SOURCE]->(s:Source)`\n' +
    '`RETURN i.citation, i.source_file, i.source_line, s.bibtex, s.year`\n\n' +
    'Working rules:\n' +
    // O bloco acima é o FALLBACK genérico. Quando a mensagem traz a seção
    // "Semântica do template deste projeto" (lida do vértice ProjectContext),
    // ela descreve ESTE banco — rótulo de conceito, taxonomias e arestas reais,
    // derivados das mesmas funções que gravaram o grafo. O plano previa remover
    // este bloco, mas ele fica: o template_doc só é carregado quando a pergunta
    // pede semântica, e sem o fallback uma pergunta comum ficaria sem nenhuma
    // orientação de navegação.
    "- If the message carries this project's template semantics, **it takes " +
    'precedence** over the generic structure above.\n' +
    '- **Call `get_schema` before the first query** to discover this ' +
    "project's labels and edges. Do not assume this database uses the same names " +
    'as another.\n' +
    // CORREÇÃO (2026-08-24): este texto afirmava "nomes de conceito são
    // snake_case e minúsculos". É FALSO fora do face85 — o `social_acceptance`
    // usa `Acceptance_Criteria`, `Acceptability_Stability`. Generalizei de um
    // projeto para todos, que é exatamente o defeito que `describeProjectSchema`
    // adverte. A convenção vem da ontologia do pesquisador e varia por projeto.
    '- **Naming conventions vary by project.** One corpus uses ' +
    '`social_acceptance` (lowercase snake_case), another uses ' +
    '`Acceptance_Criteria` (capitalised). Never assume — read the actual names ' +
    'from `get_schema` or from a `LIMIT` query, and match what you see. For ' +
    'approximate matching use `CONTAINS`, not equality.\n' +
    // Observado ao vivo (2026-08-24): o modelo procurou
    // `fatores_sociais_e_psicologicos`, não achou, e afirmou que o conceito não
    // existe no corpus. Ele existe — como `fatores_sociais_e_psicológicos`.
    // A regra vale para qualquer alfabeto com diacrítico (pt, es, fr, de…), e
    // não só para as vogais acentuadas do português: o corte é antes do primeiro
    // caractere que possa estar grafado de outra forma. Substituir a heurística
    // por `SEARCH_INDEX` (que o grafo já implementa com analyzer por idioma) é
    // a Etapa 6 — enquanto isso, a instrução não deve presumir o idioma.
    // Esta é a regra de FALLBACK. Quando o grafo declara índice full-text, a
    // seção de busca lexical (`renderLexicalCapability`) entra depois e ensina
    // `SEARCH_INDEX`, que resolve acento deterministicamente — o prompt manda
    // preferir o que a mensagem trouxer sobre este bloco genérico.
    '- **Comparison with `CONTAINS` is diacritic-sensitive and case-sensitive.** ' +
    'If this message declares a full-text index, prefer `SEARCH_INDEX` over the ' +
    'rule below — it handles accents through the analyzer instead of by hand. ' +
    'Searching ' +
    '`psicologicos` will not find `psicológicos`, and `acceptance` will not find ' +
    '`Acceptance`. Search by the **longest prefix of the term that carries no ' +
    "diacritic**: `CONTAINS 'psicol'` finds `psicológicos`, `CONTAINS 'dist'` " +
    "finds `distância`, `CONTAINS 'cria'` finds `criação`, `CONTAINS 'Fran'` " +
    'finds `Française`. Including the ' +
    'accented character, or anything after it, fails — `distanc` finds nothing. ' +
    'For case, try both the lowercase and the capitalised form before concluding ' +
    'anything.\n' +
    '- An empty result does **not** prove absence of data: suspect the accent or ' +
    'the capitalisation first, then the arrow direction or the label. **Never ' +
    'state that a concept does not exist in the corpus without having tried the ' +
    'unaccented stem and the other capitalisation** — saying something was not ' +
    'annotated is a strong claim, and the researcher may read it as a gap in ' +
    'their own material. ' +
    'If you cannot find it, say what you tried instead of groping further.\n\n' +
    COUNTING_RULES +
    '\n\n' +
    CITATION_RULES;

/**
 * Resume o schema REAL do banco para o prompt de sistema.
 *
 * Cada projeto Synesis tem um template (.synt) próprio, e o template decide o
 * rótulo do conceito e os vértices/arestas de taxonomia — `synesis-graph`
 * mapeia cada campo declarado para `GROUPED_BY`/`QUALIFIED_BY`/`BELONGS_TO`/
 * `RATED_AS`, ou `HAS_<CAMPO>` para os demais. Um vocabulário fixo no prompt
 * serviria a um projeto e enganaria todos os outros.
 *
 * Buscar o schema aqui, uma vez por pergunta, troca N rodadas de tentativa e
 * erro por uma chamada determinística — e o modelo passa a ver os rótulos
 * deste projeto, não os de um exemplo.
 *
 * Best-effort: qualquer falha devolve `undefined` e o assistente segue com a
 * parte invariante do prompt, que instrui a chamar `get_schema` sozinho.
 */
/**
 * Quando carregar o `template_doc` inteiro.
 *
 * O documento custa ~6,5k tokens (medido no face85, com GUIDELINES em 9 de 9
 * campos), contra ~150 tokens de `description` + `project_summary`. Injetá-lo em
 * toda pergunta desperdiçaria contexto em "quantos conceitos existem?" — daí a
 * decisão existir.
 *
 * **O critério deixou de ser lexical (Etapa 2).** A versão anterior casava a
 * pergunta contra 26 palavras em português (`campo`, `escala`, `tópico`,
 * `referência`…). Num corpus em inglês nenhuma casa: o `template_doc` **nunca**
 * era carregado, e o chat perdia justamente a camada que o adapta ao projeto.
 * O defeito era silencioso — o assistente respondia, só que adivinhando a
 * semântica em vez de lê-la.
 *
 * O sinal agora é **estrutural** e vale em qualquer idioma:
 *
 * - **Primeira pergunta da conversa.** É quando o modelo ainda não viu nada
 *   deste projeto, e é o turno em que errar a semântica sai mais caro: a
 *   resposta errada vira contexto das seguintes.
 * - **Pergunta que não cita nenhum nome do grafo.** Se o pesquisador nomeia um
 *   conceito que existe no schema, ele já está navegando o dado; se não nomeia
 *   nada reconhecível, a pergunta é sobre o que as coisas SÃO — que é o que o
 *   template responde.
 *
 * Continua deliberadamente generoso, pela mesma razão de antes: carregar à toa
 * custa contexto, não carregar quando precisava custa uma resposta inventada.
 *
 * `knownNames` são os rótulos e nomes de propriedade que o schema real trouxe.
 * Sem eles (schema indisponível), só o sinal de primeiro turno decide — que é o
 * comportamento seguro, porque é o turno mais barato para carregar.
 */
function questionNeedsTemplateSemantics(prompt, { isFirstTurn = true, knownNames = [] } = {}) {
    const text = String(prompt || '').trim();
    if (!text) {
        return false;
    }
    if (isFirstTurn) {
        return true;
    }
    if (!knownNames || knownNames.length === 0) {
        return false;
    }

    // Casamento por substring nos dois sentidos: o pesquisador escreve
    // "aspecto" para o rótulo `Aspect`, e escreve `Acceptance_Criteria` inteiro
    // quando cita o conceito. Comparar em minúsculas cobre as duas convenções
    // de caixa que os projetos reais usam.
    const lowered = text.toLowerCase();
    const mentionsKnownName = knownNames.some((name) => {
        const candidate = String(name || '').toLowerCase();
        if (candidate.length < 4) {
            return false;
        }
        return lowered.includes(candidate);
    });

    return !mentionsKnownName;
}

/**
 * Os nomes que o schema real declara — rótulos de vértice e de aresta.
 *
 * Servem a duas decisões desta etapa: saber se a pergunta já nomeia algo do
 * grafo (acima) e descobrir as taxonomias deste projeto sem presumir as de
 * outro (`readTopTaxonomy`).
 */
function schemaNames(parsedSchema) {
    const types = (parsedSchema && Array.isArray(parsedSchema.types) && parsedSchema.types) || [];
    return types.map((type) => type && type.name).filter(Boolean);
}

/**
 * Lê o vértice `ProjectContext`, gravado pelo `synesis-graph` a partir de 0.8.0.
 *
 * É o que transforma um grafo de sintaxe em um grafo com semântica: o schema diz
 * que existe um vértice `Aspect` com a propriedade `name`, mas não que aquilo é
 * a escala modal de Dooyeweerd nem o que `[15] Fiducial` significa. Isso está no
 * template do pesquisador e, até a 0.8.0, era descartado na exportação.
 *
 * Lê do BANCO, não do `.synt` local — de propósito. O template é o estado atual
 * do projeto; o grafo é um snapshot de quando o sync rodou. Ler o arquivo local
 * faria o assistente descrever com confiança um grafo que não existe mais.
 *
 * `full` controla o custo: sem ele vêm só `description` e `project_summary`
 * (~150 tokens); com ele vem também o `template_doc` (~6,5k).
 *
 * Grafo gerado por versão anterior simplesmente não tem o vértice — devolve
 * `undefined` e o chat segue com o schema apenas, que é o comportamento antigo.
 */
/**
 * Reconhece a recusa de acesso do ArcadeDB no texto da resposta.
 *
 * Precisa ser pelo texto: o MCP marca a resposta com `isError: true`, mas o
 * `LanguageModelToolResult` do VSCode expõe **apenas `content`** — o sinal não
 * chega à extensão. Verificado em `vscode.d.ts` (1.104) e contra o servidor
 * real, que devolve HTTP 200 com o texto cru, não JSON.
 *
 * Distinguir isso importa porque os dois casos pedem ações opostas: sem o
 * vértice, o pesquisador deve **re-exportar** o projeto; sem permissão,
 * re-exportar não resolve nada — é a credencial do `mcp.json` que precisa
 * mudar. Observado ao vivo: `face85_reader` não alcança o banco
 * `social_acceptance`, e a saudação mandava re-exportar um grafo que já tinha
 * o contexto.
 */
function describeAccessFailure(text, database) {
    if (typeof text !== 'string') {
        return undefined;
    }
    if (/not authorized/i.test(text)) {
        return (
            `A credencial configurada não tem acesso ao banco **${database}**.\n\n` +
            'O servidor MCP do ArcadeDB é o mesmo para todos os bancos; quem limita o ' +
            'alcance é o usuário. Informe um com permissão neste banco em ' +
            '**Synesis: Configurar Conexão do Banco**, e depois regrave a conexão com ' +
            '**Synesis: Conectar ao ArcadeDB (MCP)**.'
        );
    }
    if (/does not exist/i.test(text)) {
        return (
            `O banco **${database}** não existe neste servidor.\n\n` +
            'Use **Synesis: Selecionar Banco do Chat** para escolher um dos disponíveis.'
        );
    }
    return undefined;
}

async function readProjectContext(tools, database, token, { full = false, trace, client } = {}) {
    if (!database) {
        return undefined;
    }
    // `matchesArcadeDbTool` e não só o sufixo: `gitnexus_query` também termina
    // em `_query`, e o `.find()` devolve o PRIMEIRO que casar. Os chamadores de
    // hoje passam a lista já filtrada por `selectArcadeDbTools`, mas esta função
    // é exportada e testada isoladamente — depender do filtro do chamador é
    // exatamente o defeito que `matchesArcadeDbTool` existe para evitar.
    const queryTool = tools.find(
        (tool) => isGraphTool(tool.name) || (matchesArcadeDbTool(tool.name) && tool.name.endsWith('_query'))
    );
    if (!queryTool) {
        return undefined;
    }

    // Identificadores e contagens vêm sempre: são inteiros e strings curtas,
    // e a saudação precisa deles para descrever o projeto sem uma segunda
    // consulta. O `template_doc` é o único caro, daí o `full`.
    const base =
        'p.description AS description, p.project_summary AS summary, ' +
        'p.project_name AS projectName, p.concept_label AS conceptLabel, ' +
        'p.source_count AS sourceCount, p.item_count AS itemCount, ' +
        'p.concept_count AS conceptCount, p.generated_at AS generatedAt, ' +
        // Capacidade semântica, declarada pelo synesis-graph. Sempre lida: é
        // barata (duas strings curtas) e decide se a instrução de busca vetorial
        // entra ou não no prompt.
        'p.embedding_fields AS embeddingFields, p.embedding_model AS embeddingModel, ' +
        // Capacidade lexical (Etapa 6). Barata — quatro strings curtas — e decide
        // se o prompt ensina `SEARCH_INDEX` ou a heurística de prefixo.
        'p.fulltext_concept_fields AS fulltextConceptFields, ' +
        'p.fulltext_item_fields AS fulltextItemFields, ' +
        'p.fulltext_source_fields AS fulltextSourceFields, ' +
        'p.fulltext_analyzer AS fulltextAnalyzer, ' +
        // Escopo das métricas de rede (Etapa 7): muda como o número deve ser
        // lido, e o consumidor não tem como saber pelo escore.
        'p.metrics_backend AS metricsBackend, p.metrics_scope AS metricsScope';
    const fields = full ? `${base}, p.template_doc AS templateDoc` : base;

    const input = {
        database,
        language: 'cypher',
        query: `MATCH (p:ProjectContext) RETURN ${fields}`
    };

    try {
        const result = await invokeAnyTool(client, queryTool.name, input, token, undefined);
        const texts = (result.content || [])
            .filter((part) => part instanceof vscode.LanguageModelTextPart)
            .map((part) => part.value);
        const text = texts.join('');

        // Prefetch: consulta real ao banco, feita pela extensão e não pelo
        // modelo. Marcada como tal para aparecer no custo sem se confundir com
        // o que o modelo pediu.
        recordToolCall(trace, {
            toolName: queryTool.name,
            input,
            prefetch: true,
            status: 'ok',
            texts
        });

        // Recusa do servidor: chega como texto cru, não JSON. Devolvida como
        // problema NOMEADO em vez de virar "banco sem contexto", que mandaria
        // o pesquisador re-exportar um grafo que já está correto.
        const accessFailure = describeAccessFailure(text, database);
        if (accessFailure) {
            return { accessFailure };
        }

        const record = (JSON.parse(text).records || [])[0];
        if (!record) {
            return undefined;
        }
        return record;
    } catch (error) {
        // Banco sem o vértice ou resposta inesperada: não é fatal — o chat
        // continua funcionando com o schema.
        recordToolCall(trace, {
            toolName: queryTool.name,
            input,
            prefetch: true,
            status: 'error',
            error: error.message || String(error)
        });
        console.warn('Synesis Chat: sem ProjectContext neste banco', error);
        return undefined;
    }
}

/**
 * Métricas de rede pré-calculadas, quando o grafo as tem.
 *
 * O `synesis-graph` roda PageRank, betweenness e Louvain no sync e grava o
 * resultado em cada conceito. Observado ao vivo (2026-08-24): perguntado pelos
 * conceitos "mais centrais", o modelo **contou arestas à mão** e devolveu um
 * ranking de grau — porque as propriedades estavam gravadas mas **não declaradas
 * no schema**, e portanto invisíveis ao `get_schema`.
 *
 * Não é diferença cosmética: no face85, os dois primeiros por grau
 * (`contabilidade`, `uberismo`) **não estão no top-5 por PageRank**. Grau conta
 * vizinhos; PageRank pesa a importância deles.
 *
 * Detectada do schema real, nunca presumida — mesma disciplina da busca
 * semântica. E o custo é o oposto do que parece: ler uma propriedade evita as
 * rodadas que contar arestas de centenas de conceitos consome.
 */
const METRIC_HINTS = {
    // CORREÇÃO (Etapa 2): esta linha dizia que PageRank é "a resposta certa para
    // mais central". Centralidade não é um fato do grafo, é uma
    // operacionalização metodológica — grau, PageRank e betweenness respondem
    // perguntas diferentes, e escolher por conta do pesquisador é decidir o
    // método dele. Pior no ArcadeDB, onde `algo.*` roda sobre o grafo INTEIRO
    // (conceitos, Items, Sources e taxonomias), enquanto o GDS do Neo4j projeta
    // só o subgrafo de conceitos: os escores não são comparáveis entre backends.
    pagerank: 'prestígio recursivo — pesa a importância dos vizinhos, não só quantos são',
    betweenness: 'ponte: quanto o conceito liga partes distantes da rede',
    community: 'agrupamento detectado por Louvain; o número é rótulo interno desta execução, não categoria estável',
    degree: 'conectividade direta — número de vizinhos (bruto, não ponderado)',
    in_degree: 'conectividade de entrada',
    out_degree: 'conectividade de saída',
    mention_count: 'presença no corpus: em quantos trechos o conceito é mencionado',
    source_count: 'presença no corpus: em quantas referências bibliográficas aparece'
};

/** Quais métricas este grafo realmente tem, pelo schema. */
function availableMetrics(vertices) {
    const found = new Set();
    for (const type of vertices || []) {
        for (const property of type.properties || []) {
            if (property && METRIC_HINTS[property.name]) {
                found.add(property.name);
            }
        }
    }
    return [...found];
}

function describeGraphMetrics(vertices, scope) {
    const found = new Map();

    for (const type of vertices || []) {
        for (const property of type.properties || []) {
            const hint = METRIC_HINTS[property.name];
            if (hint && !found.has(property.name)) {
                found.set(property.name, { label: type.name, hint });
            }
        }
    }

    if (found.size === 0) {
        return undefined;
    }

    const label = [...found.values()][0].label;
    const lines = [...found.entries()].map(([name, { hint }]) => `- \`${name}\` — ${hint}`);

    // A consulta de exemplo usa uma métrica que este grafo TEM. Ensinar
    // `pagerank` num grafo que só calculou `degree` gastaria uma rodada com erro
    // — a mesma disciplina condicional do resto do prompt.
    const example = found.has('pagerank') ? 'pagerank' : [...found.keys()][0];

    return (
        'Métricas de rede já calculadas neste grafo (não recalcule):\n' +
        `${lines.join('\n')}\n` +
        `Exemplo: \`MATCH (c:${label}) RETURN c.name, c.${example} ORDER BY c.${example} ` +
        'DESC LIMIT 10` — **não conte arestas à mão**, o resultado é diferente e custa ' +
        'várias consultas.\n' +
        // O ponto metodológico: "mais central" é uma pergunta ambígua, e
        // responder sem dizer qual sentido foi adotado esconde uma escolha do
        // pesquisador dentro de um número.
        //
        // A lista de sentidos é montada só com o que ESTE grafo tem — citar
        // `betweenness` num grafo que não o calculou é a mesma promessa vazia
        // que a detecção condicional existe para evitar.
        '**"Mais central" não tem resposta única.** Escolha a métrica pelo sentido da ' +
        `pergunta — ${[...found.keys()].map((name) => `\`${name}\``).join(', ')} medem ` +
        'coisas diferentes — e **diga qual métrica usou e por quê**. Se a pergunta não ' +
        'deixar claro o sentido, pergunte ou responda com mais de uma.\n' +
        // O escopo vem do `ProjectContext` quando declarado (Etapa 7). O texto
        // fixo continua como fallback: no ArcadeDB — o único backend que hoje
        // grava vetores e métricas — o escopo É o grafo inteiro, e um grafo
        // gerado antes da declaração não deixa de ter essa propriedade.
        (scope
            ? `Estas métricas foram calculadas pelo backend \`${scope.backend}\`, escopo ` +
              `\`${scope.scope}\`. Diga isso ao apresentar um ranking.`
            : 'Estas métricas foram calculadas sobre o grafo inteiro (conceitos, trechos, ' +
              'referências e taxonomias), não apenas sobre a rede de conceitos. Diga isso ao ' +
              'apresentar um ranking.')
    );
}

/**
 * Instrução de busca semântica — só quando o grafo declara ter vetores.
 *
 * **Condicional de propósito.** Mandar usar `vectorNeighbors` num banco sem
 * índice faz o modelo gastar rodadas com erro, e é a mesma classe de defeito
 * que o prompt já teve com `list_databases` (duas ordens contraditórias no
 * mesmo texto). Hoje só o backend ArcadeDB do `synesis-graph` grava vetores;
 * um grafo Neo4j, ou um exportado sem `--vector-embeddings`, simplesmente não
 * recebe esta seção.
 *
 * A capacidade vem do vértice `ProjectContext`, **não** da introspecção do
 * schema. O índice sobrevive a um re-sync sem vetores — inferir dele anunciaria
 * uma capacidade que o dado não tem.
 *
 * A forma da consulta foi verificada contra o ArcadeDB 26.7.3 (2026-08-24), e a
 * escolha importa: o subselect inline falha com `Unsupported query vector type:
 * ResultInternal`; a atribuição por `LET` funciona e evita trafegar 384 floats
 * no texto da consulta.
 */
function renderSemanticCapability(context) {
    const fields = (context && context.embeddingFields) || '';
    if (!fields) {
        return undefined;
    }
    const label = (context && context.conceptLabel) || 'Chain';
    const list = fields
        .split(',')
        .map((f) => `\`${f.trim()}\``)
        .filter(Boolean)
        .join(', ');

    return (
        'Busca semântica disponível neste banco:\n' +
        `- Conceitos (\`${label}\`) têm índice vetorial construído a partir de: ${list}.\n` +
        '- Use para encontrar conceitos **relacionados por significado** quando a busca ' +
        'por nome falhar ou vier pobre. Não substitui a busca exata: tente `CONTAINS` antes.\n' +
        '- A consulta é SQL (`language: "sql"`), não Cypher, e parte de um conceito que já ' +
        'existe no grafo — não é preciso gerar vetor nenhum:\n' +
        '```sql\n' +
        'SELECT record.name AS conceito, distance AS dist FROM (\n' +
        `  SELECT expand(vectorNeighbors('${label}[embedding]', $v, 8))\n` +
        `  LET $v = (SELECT embedding FROM ${label} WHERE name = 'nome_do_conceito')[0].embedding)\n` +
        '```\n' +
        '- `distance` menor = mais próximo. O próprio conceito volta com distância ~0.\n' +
        '- **Nunca** peça a propriedade `embedding` numa resposta: são centenas de números ' +
        'sem uso para o pesquisador.\n\n' +
        // A distinção que dá valor de pesquisa: sem ela, uma vizinhança vetorial
        // passa por menção do corpus, e o pesquisador não tem como saber que
        // aquilo foi inferido por um modelo de embeddings.
        'Ao usar busca semântica, **diga que o resultado é por proximidade**, não por menção. ' +
        'São coisas diferentes:\n' +
        '- "estes conceitos mencionam X" — afirmação sobre o corpus, verificável no trecho;\n' +
        '- "estes conceitos são semanticamente próximos de X" — inferência do modelo de ' +
        'embeddings, que é **sugestão de leitura**, não algo que o pesquisador afirmou.\n' +
        'Marque a diferença na resposta. Um conceito próximo que o pesquisador nunca ligou a X ' +
        'continua sendo um achado útil — desde que apresentado como tal.'
    );
}

/** Monta o trecho de prompt a partir do contexto lido. */
function renderProjectContext(context) {
    // `accessFailure` é diagnóstico para o pesquisador, não contexto para o
    // modelo: numa pergunta comum o erro já aparece na resposta da ferramenta.
    if (!context || context.accessFailure) {
        return undefined;
    }
    const parts = [];
    if (context.description) {
        parts.push(`Sobre este projeto de pesquisa:\n${context.description}`);
    }
    if (context.summary) {
        parts.push(context.summary);
    }
    if (context.templateDoc) {
        parts.push(
            'Semântica do template deste projeto — use estes campos, escalas e ' +
                `arestas, não os de um exemplo:\n${context.templateDoc}`
        );
    }
    const lexical = renderLexicalCapability(context);
    if (lexical) {
        parts.push(lexical);
    }
    const semantic = renderSemanticCapability(context);
    if (semantic) {
        parts.push(semantic);
    }
    const staleness = describeStaleness(context.generatedAt);
    if (staleness) {
        parts.push(staleness);
    }
    return parts.length ? parts.join('\n\n') : undefined;
}

/**
 * Aviso de snapshot velho, quando couber.
 *
 * O grafo não se atualiza sozinho: se o pesquisador anotou mais desde o último
 * `synesis-graph`, o banco está atrás do projeto. Dizer isso é melhor do que
 * apresentar dado velho como atual — e o limiar é generoso (90 dias) para não
 * virar ruído em quem sincroniza com frequência.
 */
function describeStaleness(generatedAt) {
    if (!generatedAt) {
        return undefined;
    }
    const generated = new Date(generatedAt);
    if (Number.isNaN(generated.getTime())) {
        return undefined;
    }
    const days = Math.floor((Date.now() - generated.getTime()) / 86400000);
    if (days < 90) {
        return undefined;
    }
    return (
        `Atenção: este grafo foi gerado há cerca de ${days} dias. Se o projeto mudou ` +
        'desde então, avise que a resposta reflete um snapshot, não o estado atual.'
    );
}

async function describeProjectSchema(tools, database, token, trace, metricsScope, client) {
    if (!database) {
        return undefined;
    }
    const schemaTool = tools.find(
        (tool) => isGraphTool(tool.name) || (matchesArcadeDbTool(tool.name) && tool.name.endsWith('_get_schema'))
    );
    if (!schemaTool) {
        return undefined;
    }

    try {
        const result = await invokeAnyTool(client, schemaTool.name, { database }, token, undefined);
        const texts = (result.content || [])
            .filter((part) => part instanceof vscode.LanguageModelTextPart)
            .map((part) => part.value);
        const text = texts.join('');
        recordToolCall(trace, {
            toolName: schemaTool.name,
            input: { database },
            prefetch: true,
            status: 'ok',
            texts
        });
        const parsed = JSON.parse(text);
        const types = Array.isArray(parsed.types) ? parsed.types : [];
        if (types.length === 0) {
            return undefined;
        }

        const vertices = types.filter((t) => t.category === 'vertex');
        const edges = types.filter((t) => t.category === 'edge');

        const vertexLines = vertices.map((t) => {
            const names = (t.properties || []).map((p) => p.name);
            // O VALOR de `embedding` é lixo no prompt (centenas de floats), mas a
            // EXISTÊNCIA dele não: é o que diz que este vértice tem busca
            // semântica. Filtrar os dois juntos escondia a capacidade — o
            // defeito que a Etapa D corrige. A instrução de como consultar vem de
            // `renderSemanticCapability`, a partir do `ProjectContext`.
            const props = names.filter((name) => name !== 'embedding');
            const vector = names.includes('embedding') ? ' + índice vetorial' : '';
            return `  - \`${t.name}\`${props.length ? ` (${props.join(', ')})` : ''}${vector}`;
        });

        // Métricas de rede: detectadas no schema real, não presumidas. Um grafo
        // gerado sem elas (ou por versão anterior do synesis-graph) simplesmente
        // não recebe a instrução — mandar usar `pagerank` onde ele não existe
        // gastaria rodadas com erro.
        const metrics = describeGraphMetrics(vertices, metricsScope);

        // Devolve o texto do prompt E o schema parseado. O parseado é o que
        // permite às decisões desta etapa — quais taxonomias existem, quais
        // nomes o pesquisador pode ter citado, quais métricas foram calculadas —
        // saírem do banco em vez de um vocabulário fixo (Etapa 2).
        return {
            text:
                `Schema real do banco "${database}" — use estes nomes, não os do exemplo acima:\n` +
                `Vértices:\n${vertexLines.join('\n')}\n` +
                `Arestas: ${edges.map((t) => `\`${t.name}\``).join(', ')}` +
                (metrics ? `\n\n${metrics}` : ''),
            vertices,
            edges,
            names: schemaNames(parsed),
            metricNames: availableMetrics(vertices)
        };
    } catch (error) {
        console.warn('Synesis Chat: falha ao ler o schema do banco', error);
        return undefined;
    }
}

/**
 * Rótulo seguro para interpolar numa consulta.
 *
 * O nome vem do `get_schema` — do servidor, portanto — mas entra numa string de
 * consulta, e a sondagem varre TODOS os vértices em vez de um nome escolhido a
 * dedo. Um rótulo com aspa ou parêntese quebraria a sintaxe; validar por lista
 * branca é mais barato que confiar na origem. Grafo com rótulo exótico
 * simplesmente não é sondado, que é a falha correta aqui.
 */
function validLabel(name) {
    return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * Mede quais campos identificam uma linha deste vértice (A2).
 *
 * Uma consulta por vértice, contando o total e os distintos de cada candidato de
 * uma vez — 207ms medidos sobre os 3.027 Sources deste corpus. Contar campo a
 * campo custaria uma consulta por campo.
 *
 * O teto de campos existe porque a lista sai do dado observado: um vértice com
 * quarenta propriedades textuais geraria uma consulta enorme para uma pergunta
 * que os primeiros campos já respondem.
 */
async function probeIdentity(client, toolName, database, label, candidates, token, trace) {
    const fields = (candidates || []).filter(validLabel).slice(0, IDENTITY_FIELD_LIMIT);
    // Com menos de dois campos textuais não há escolha de chave a errar, e a
    // contagem `count(DISTINCT ...)` varre o vértice inteiro — 249.735 linhas no
    // `Item` deste corpus. Não vale pagá-la para descobrir que só existe um
    // candidato. Medido: sem este corte, a sondagem passou de 7 para 15
    // consultas e de 0,2s para 14,2s.
    if (fields.length < 2) {
        return undefined;
    }

    // **Portão de tamanho.** `count(DISTINCT ...)` varre o vértice: medido, 198ms
    // nos 3.027 `Source` e **8.929ms** nos 249.735 `Item` — sozinho, mais que
    // todo o resto do prefetch somado. Um `count(*)` puro custa 14ms mesmo no
    // vértice grande, então perguntar o tamanho antes é praticamente de graça e
    // evita a varredura cara.
    //
    // O corte não perde o caso que interessa: a armadilha de chave aparece onde
    // o pesquisador agrupa por um rótulo humano (nome de candidato, título), e
    // esses vértices são os de identidade — dezenas de milhares no máximo, não
    // centenas de milhares de trechos anotados.
    const sizeInput = {
        database,
        language: 'cypher',
        query: `MATCH (n:${label}) RETURN count(n) AS total`
    };
    try {
        const sizeResult = await invokeAnyTool(client, toolName, sizeInput, token, undefined);
        const sizeTexts = (sizeResult.content || [])
            .filter((part) => part instanceof vscode.LanguageModelTextPart)
            .map((part) => part.value);
        recordToolCall(trace, {
            toolName,
            input: sizeInput,
            prefetch: true,
            status: 'ok',
            texts: sizeTexts
        });
        const sizeParsed = JSON.parse(sizeTexts.join(''));
        const sizeRow = (sizeParsed.records || sizeParsed.result || [])[0];
        const size = sizeRow && Number(sizeRow.total);
        if (!Number.isFinite(size) || size === 0 || size > IDENTITY_MAX_VERTICES) {
            return undefined;
        }
    } catch (error) {
        recordToolCall(trace, {
            toolName,
            input: sizeInput,
            prefetch: true,
            status: 'error',
            error: error.message || String(error)
        });
        return undefined;
    }

    const projections = fields.map((f) => `count(DISTINCT n.${f}) AS ${f}`).join(', ');
    const input = {
        database,
        language: 'cypher',
        query: `MATCH (n:${label}) RETURN count(n) AS __total, ${projections}`
    };
    try {
        const result = await invokeAnyTool(client, toolName, input, token, undefined);
        const texts = (result.content || [])
            .filter((part) => part instanceof vscode.LanguageModelTextPart)
            .map((part) => part.value);
        recordToolCall(trace, { toolName, input, prefetch: true, status: 'ok', texts });
        const parsed = JSON.parse(texts.join(''));
        const row = (parsed.records || parsed.result || [])[0];
        if (!row) {
            return undefined;
        }
        const { __total: total, ...counts } = row;
        return classifyIdentity(total, counts);
    } catch (error) {
        // Vértice que recuse a contagem simplesmente não recebe a orientação.
        recordToolCall(trace, {
            toolName,
            input,
            prefetch: true,
            status: 'error',
            error: error.message || String(error)
        });
        return undefined;
    }
}

/**
 * Sonda o DADO em busca do que o schema não declara.
 *
 * O `get_schema` lista só propriedades declaradas, e um grafo pode ter
 * propriedades gravadas em todos os vértices sem nenhuma declaração — foi o que
 * escondeu `total_score` do modelo no `candidatos_quinto_andar`. Ver
 * `observedProperties.js` para o caso observado e a justificativa.
 *
 * Uma consulta por vértice, devolvendo o nó inteiro — o tamanho da amostra sai
 * de `sampleSizeFor`, que encolhe para uma linha quando o vértice declara
 * embedding (o vetor domina o tráfego e é descartado de qualquer forma).
 * Medido contra o banco remoto: 225ms para os sete vértices deste corpus, e
 * ~340 tokens de seção no prompt.
 *
 * Só os vértices de dado são sondados: `ProjectContext` fica de fora porque é
 * metadado já lido por `readProjectContext`, e sondá-lo traria o `template_doc`
 * de 28k chars inteiro para dentro de uma amostra que seria descartada.
 *
 * Best-effort em cada etapa: um vértice que recuse a consulta é pulado sem
 * derrubar os outros, e falha geral devolve `undefined` — o chat segue com o
 * schema declarado, que é o comportamento anterior a esta função.
 */
async function probeUndeclaredProperties(tools, database, schema, token, trace, client) {
    if (!database || !schema || !Array.isArray(schema.vertices) || schema.vertices.length === 0) {
        return undefined;
    }
    const queryTool = tools.find(
        (tool) => isGraphTool(tool.name) || (matchesArcadeDbTool(tool.name) && tool.name.endsWith('_query'))
    );
    if (!queryTool) {
        return undefined;
    }

    const probes = schema.vertices.filter((vertex) => {
        const label = vertex && vertex.name;
        return Boolean(label) && label !== 'ProjectContext' && validLabel(label);
    });

    // Em paralelo, com concorrência limitada (P2). `mapWithConcurrency` preserva
    // a ordem da entrada, então a seção de prompt não muda conforme a ordem em
    // que o servidor responder.
    const probed = await mapWithConcurrency(probes, PROBE_CONCURRENCY, async (vertex) => {
        const label = vertex.name;
        const declaredNames = (vertex.properties || []).map((p) => p && p.name).filter(Boolean);
        const input = {
            database,
            language: 'cypher',
            query: `MATCH (n:${label}) RETURN n LIMIT ${sampleSizeFor(vertex)}`
        };
        try {
            const result = await invokeAnyTool(client, queryTool.name, input, token, undefined);
            const texts = (result.content || [])
                .filter((part) => part instanceof vscode.LanguageModelTextPart)
                .map((part) => part.value);
            const text = texts.join('');
            recordToolCall(trace, {
                toolName: queryTool.name,
                input,
                prefetch: true,
                status: 'ok',
                texts
            });
            const parsed = JSON.parse(text);
            const rows = (parsed.records || parsed.result || []).map(unwrapNode).filter(Boolean);
            const observed = collectObserved(rows);
            const undeclared = undeclaredFrom(observed, declaredNames);
            const identity = await probeIdentity(
                client,
                queryTool.name,
                database,
                label,
                identityCandidates(observed),
                token,
                trace
            );
            const guidance = renderIdentityGuidance(label, identity);
            // `ranking` sai do observado INTEIRO, não de `undeclared`: a escolha
            // entre dois campos de pontuação existe mesmo quando ambos já estão
            // declarados no schema (A1).
            const ranking = [...observed].map(([name, type]) => ({ name, type }));
            // Qualquer um dos três sinais basta para o vértice entrar: um grafo
            // com schema completo pode não ter nada a declarar e ainda assim
            // precisar do aviso de chave ou de ranking.
            const hasRanking = rankingCandidates(ranking).length >= 2;
            return undeclared.length > 0 || guidance || hasRanking
                ? { label, undeclared, guidance, ranking }
                : undefined;
        } catch (error) {
            // Vértice vazio, sem permissão, ou resposta inesperada: os demais
            // continuam. Sondagem é oportunista por definição.
            recordToolCall(trace, {
                toolName: queryTool.name,
                input,
                prefetch: true,
                status: 'error',
                error: error.message || String(error)
            });
            return undefined;
        }
    });

    const byLabel = probed.filter(Boolean);

    if (byLabel.length === 0) {
        return undefined;
    }
    // Devolve só o OBSERVADO, não o texto pronto: a renderização depende de
    // saber se o `template_doc` entrou neste turno (R1), o que só se decide
    // depois — e este valor fica em cache entre turnos, em que essa decisão
    // muda. Renderizar aqui congelaria a versão do primeiro turno.
    return { byLabel };
}

/**
 * Reconstrói as mensagens dos turnos anteriores desta conversa.
 *
 * Sem isto o participant não tem memória entre turnos, apesar de `isSticky`:
 * cada pergunta chegava ao modelo sozinha, e um follow-up ("e liste 3 nomes
 * desses") não tinha a que se referir.
 *
 * Só o texto é reconstruído. As chamadas de ferramenta de turnos passados
 * ficam de fora de propósito: um `LanguageModelToolCallPart` antigo exigiria
 * o `LanguageModelToolResultPart` correspondente na mesma ordem para os
 * provedores aceitarem o histórico, e o resultado bruto da ferramenta não fica
 * disponível em `ChatResponseTurn`. O texto da resposta já carrega a conclusão
 * que o follow-up precisa.
 */
function buildHistoryMessages(history) {
    const messages = [];
    for (const turn of history || []) {
        if (turn instanceof vscode.ChatRequestTurn) {
            if (turn.prompt) {
                messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
            }
            continue;
        }

        if (turn instanceof vscode.ChatResponseTurn) {
            const text = (turn.response || [])
                .filter((part) => part instanceof vscode.ChatResponseMarkdownPart)
                .map((part) => (part.value && part.value.value) || '')
                .join('')
                .trim();
            if (text) {
                messages.push(vscode.LanguageModelChatMessage.Assistant(text));
            }
        }
    }
    return messages;
}

/**
 * Sugestão mostrada quando o pesquisador invoca `@synesis` sem escrever nada.
 *
 * Sem esta guarda, o prompt vazio virava um bloco de texto vazio no corpo da
 * requisição e o provedor rejeitava com um erro incompreensível para quem só
 * digitou "@synesis" — na Anthropic, `text content blocks must be non-empty`.
 */
/**
 * Lê os tópicos mais frequentes, para a saudação sugerir perguntas concretas.
 *
 * "Liste os conceitos de Finanças" vale mais que "liste os conceitos de um
 * tópico": o pesquisador reconhece o próprio corpus e vê que o assistente já
 * está olhando para ele.
 *
 * Best-effort — a saudação funciona sem isto.
 */
/**
 * Descobre a taxonomia deste projeto a partir do schema real.
 *
 * **O que estava errado (Etapa 2).** A versão anterior fixava `GROUPED_BY` e
 * `Topic` na consulta. Isso é o template do face85, não um invariante do
 * Synesis: `synesis-graph` mapeia cada campo declarado para `GROUPED_BY`
 * (topic), `QUALIFIED_BY` (aspect), `BELONGS_TO` (dimension), `RATED_AS`
 * (confidence) ou `HAS_<CAMPO>` para os demais. Um projeto cujo template não
 * declara `topic` caía no `catch` e perdia as sugestões da saudação — em
 * silêncio, porque falhar assim é indistinguível de um corpus sem tópicos.
 *
 * A taxonomia agora sai do schema: os vértices que não são os invariantes
 * (`Item`, `Source`, `ProjectContext`) nem o próprio conceito são, por
 * construção, os campos de taxonomia do template.
 *
 * A ordem de preferência existe só para a saudação escolher UMA quando há
 * várias: `Topic` costuma ser a mais legível como "temas mais presentes". Não é
 * requisito — qualquer taxonomia serve, e a primeira do schema é usada quando
 * nenhuma das conhecidas aparece.
 */
const INVARIANT_VERTEX_LABELS = ['Item', 'Source', 'ProjectContext'];
const TAXONOMY_PREFERENCE = ['Topic', 'Dimension', 'Aspect'];

function findTaxonomyLabel(schema, conceptLabel) {
    const vertices = (schema && schema.vertices) || [];
    const candidates = vertices
        .map((type) => type && type.name)
        .filter(Boolean)
        .filter((name) => !INVARIANT_VERTEX_LABELS.includes(name) && name !== conceptLabel);

    if (candidates.length === 0) {
        return undefined;
    }
    const preferred = TAXONOMY_PREFERENCE.find((name) => candidates.includes(name));
    return preferred || candidates[0];
}

/**
 * A aresta que liga o conceito a uma taxonomia, pelo schema.
 *
 * O nome vem do campo do template, então adivinhá-lo é o mesmo defeito de
 * adivinhar o rótulo. Quando o schema não permite decidir, a consulta usa uma
 * aresta livre (`-->`), que casa qualquer nome: é mais lento que nomear, e é
 * exatamente o que se quer quando não se sabe o nome.
 */
const TAXONOMY_EDGE_BY_LABEL = {
    Topic: 'GROUPED_BY',
    Aspect: 'QUALIFIED_BY',
    Dimension: 'BELONGS_TO',
    Confidence: 'RATED_AS'
};

function taxonomyEdgePattern(schema, taxonomyLabel) {
    const edges = ((schema && schema.edges) || []).map((type) => type && type.name).filter(Boolean);
    const known = TAXONOMY_EDGE_BY_LABEL[taxonomyLabel];
    if (known && edges.includes(known)) {
        return `-[:${known}]->`;
    }
    // `HAS_<CAMPO>`: o nome que o synesis-graph gera para campos sem mapeamento
    // dedicado. Casado contra o schema, não presumido.
    const generated = `HAS_${String(taxonomyLabel || '').toUpperCase()}`;
    if (edges.includes(generated)) {
        return `-[:${generated}]->`;
    }
    return '-->';
}

async function readTopTaxonomy(tools, database, conceptLabel, schema, token, limit = 3, client) {
    if (!database || !conceptLabel) {
        return { label: undefined, values: [] };
    }
    const taxonomyLabel = findTaxonomyLabel(schema, conceptLabel);
    if (!taxonomyLabel) {
        return { label: undefined, values: [] };
    }
    // Mesmo guarda da sondagem (R3): os dois rótulos são interpolados na
    // consulta abaixo. Vêm do `get_schema`, mas validar aqui custa nada e
    // elimina a inconsistência de tratar a mesma classe de risco de dois jeitos
    // em funções vizinhas.
    if (!validLabel(conceptLabel) || !validLabel(taxonomyLabel)) {
        return { label: undefined, values: [] };
    }
    const queryTool = tools.find(
        (tool) => isGraphTool(tool.name) || (matchesArcadeDbTool(tool.name) && tool.name.endsWith('_query'))
    );
    if (!queryTool) {
        return { label: undefined, values: [] };
    }
    try {
        const result = await invokeAnyTool(
            client,
            queryTool.name,
            {
                database,
                language: 'cypher',
                query:
                    `MATCH (c:${conceptLabel})${taxonomyEdgePattern(schema, taxonomyLabel)}(t:${taxonomyLabel}) ` +
                    `RETURN t.name AS name, count(c) AS n ORDER BY n DESC LIMIT ${limit}`
            },
            token,
            undefined
        );
        const text = (result.content || [])
            .filter((part) => part instanceof vscode.LanguageModelTextPart)
            .map((part) => part.value)
            .join('');
        const values = (JSON.parse(text).records || []).map((r) => r.name).filter(Boolean);
        return { label: taxonomyLabel, values };
    } catch {
        // Consulta recusada ou taxonomia sem valores: a saudação simplesmente
        // não sugere um recorte concreto.
        return { label: taxonomyLabel, values: [] };
    }
}

/**
 * Perguntas sugeridas para a saudação, adaptadas ao que este projeto tem.
 *
 * Devolvidas também pelo `followupProvider`, que as renderiza como itens
 * clicáveis — `stream.button()` executa comandos, não insere texto no chat,
 * então não serve para sugerir perguntas.
 */
function buildSuggestedQuestions(context, taxonomy = {}, metricNames = []) {
    const label = (context && context.conceptLabel) || 'conceito';
    const values = taxonomy.values || [];
    // O rótulo real do template, em minúscula, para a pergunta soar natural:
    // "do tópico X" num projeto com `Topic`, "da dimensão X" num com `Dimension`.
    const taxonomyWord = taxonomy.label ? String(taxonomy.label).toLowerCase() : 'grupo';
    const suggestions = [];

    if (values.length) {
        suggestions.push({
            prompt: `Liste os conceitos do ${taxonomyWord} ${values[0]} e diga em que artigos aparecem`,
            label: `Conceitos de ${values[0]}, com as fontes`
        });
    }
    suggestions.push({
        prompt: 'Que campos o template deste projeto define, e o que cada um significa?',
        label: 'Entender o template do projeto'
    });

    // Condicional (Etapa 2): sugerir PageRank num grafo que não o calculou —
    // Neo4j, ou export sem métricas — entrega ao pesquisador uma pergunta que
    // falha. `describeGraphMetrics` já era condicional; a sugestão não era.
    const centrality = ['pagerank', 'degree', 'mention_count'].find((name) =>
        (metricNames || []).includes(name)
    );
    if (centrality) {
        suggestions.push({
            prompt:
                `Quais são os 10 ${label} mais centrais na rede por \`${centrality}\`? ` +
                'Diga o que essa métrica mede.',
            label: 'Conceitos mais centrais'
        });
    }

    if (values.length > 1) {
        suggestions.push({
            prompt: `Como os conceitos de ${values[0]} se relacionam com os de ${values[1]}?`,
            label: `${values[0]} × ${values[1]}`
        });
    }
    return suggestions;
}

/**
 * Saudação mostrada quando o pesquisador invoca `@synesis` sem escrever nada.
 *
 * Antes era uma lista fixa de exemplos genéricos. Agora descreve o projeto real
 * — nome, objetivo, escala do corpus — a partir do vértice `ProjectContext`
 * gravado no grafo, e sugere perguntas ancoradas nos tópicos que o corpus tem.
 *
 * Sem banco selecionado, ou sem contexto no grafo, degrada para a orientação
 * mínima: o que fazer para chegar lá.
 */
/**
 * `cache` é opcional (P3): quando o participant o passa, a saudação e a primeira
 * pergunta deixam de repetir as MESMAS duas consultas com segundos de intervalo
 * — `readProjectContext` e `describeProjectSchema` rodavam aqui e de novo no
 * handler. Sem ele a função se comporta como antes, que é o que mantém os testes
 * existentes válidos e a função utilizável isoladamente.
 */
async function renderWelcome(stream, tools, database, token, client, cache, cacheScope) {
    // `resolve` sem cache é a chamada direta: um caminho só, em vez de dois
    // ramos que poderiam divergir. `cacheScope` cai para o nome do banco quando
    // não é passado — a função continua utilizável isoladamente, e é o que os
    // testes existentes exercitam.
    const scope = cacheScope || database;
    const resolve = (slot, produce) => (cache ? cache.resolve(scope, slot, produce) : produce());
    if (!database) {
        stream.markdown(
            'Ainda não há um banco selecionado.\n\n' +
                'Escolha um pelo comando **Synesis: Selecionar Banco do Chat**, ou pelo ' +
                'indicador na barra de status. Se o ArcadeDB ainda não estiver conectado, ' +
                'use **Synesis: Conectar ao ArcadeDB (MCP)**.'
        );
        stream.button({ command: 'synesis.chat.selectDatabase', title: 'Selecionar banco' });
        return [];
    }

    const context = await resolve(SLOT.CONTEXT, () =>
        readProjectContext(tools, database, token, { client })
    );

    // Recusa de acesso: dizer a causa real. Tratar como "grafo sem contexto"
    // mandaria re-exportar o projeto, o que não resolve permissão.
    if (context && context.accessFailure) {
        stream.markdown(`Não consegui consultar o banco **${database}**.\n\n${context.accessFailure}`);
        stream.button({ command: 'synesis.chat.selectDatabase', title: 'Selecionar outro banco' });
        return [];
    }

    if (!context) {
        // Grafo sem `ProjectContext`: gerado por synesis-graph anterior a 0.8.0.
        stream.markdown(
            `Conectado ao banco **${database}**.\n\n` +
                'Este grafo não traz o contexto do projeto — ele é gravado pelo ' +
                '`synesis-graph` a partir da versão 0.8.0. Re-exportar o projeto faz o ' +
                'assistente conhecer os campos, escalas e orientações do seu template.\n\n' +
                'A partir da **0.9.0** vêm também a contagem de trechos anotados, a busca ' +
                'full-text por palavra e o escopo das métricas de rede.\n\n' +
                'Enquanto isso, posso responder sobre a estrutura do grafo.'
        );
        return buildSuggestedQuestions(undefined, {}, []);
    }

    // O schema decide qual é a taxonomia deste projeto e quais métricas ele tem.
    // Sem isto a saudação sugeria `Topic` e PageRank a todo projeto — os do
    // face85, não os do template de quem está perguntando.
    const schema = await resolve(SLOT.SCHEMA, () =>
        describeProjectSchema(tools, database, token, undefined, undefined, client)
    );
    const taxonomy = await readTopTaxonomy(tools, database, context.conceptLabel, schema, token, 3, client);

    const lines = [`## ${context.projectName || database}`, ''];
    if (context.description) {
        lines.push(context.description, '');
    }
    const scale = [
        context.sourceCount ? `**${context.sourceCount}** referências` : null,
        context.itemCount ? `**${context.itemCount}** trechos analisados` : null,
        context.conceptCount ? `**${context.conceptCount}** conceitos` : null
    ].filter(Boolean);
    if (scale.length) {
        lines.push(`Este grafo reúne ${scale.join(', ')}.`, '');
    }
    if (taxonomy.values.length) {
        // O rótulo do template nomeia a linha: "Topic" vira "Topic mais
        // presentes", "Dimension" vira "Dimension mais presentes". Chamar tudo
        // de "temas" seria o vocabulário de um projeto imposto aos outros.
        lines.push(
            `${taxonomy.label} mais presentes: ${taxonomy.values.map((t) => `\`${t}\``).join(', ')}.`,
            ''
        );
    }
    const staleness = describeStaleness(context.generatedAt);
    if (staleness) {
        lines.push(`⚠️ ${staleness}`, '');
    }
    lines.push('Pergunte o que quiser sobre o corpus — ou escolha uma sugestão abaixo.');

    stream.markdown(lines.join('\n'));
    return buildSuggestedQuestions(context, taxonomy, (schema && schema.metricNames) || []);
}

function registerChatParticipant(context) {
    // Sugestões da última saudação, devolvidas pelo followupProvider. Guardadas
    // aqui porque o provider é chamado DEPOIS do handler, num callback separado,
    // e não recebe o que o handler descobriu sobre o projeto.
    let lastSuggestions = [];

    // Os traces desta sessão, endereçados por `turnId`.
    //
    // Substitui a variável única `lastAuditTurn`, que era o defeito de
    // identidade: o botão não passava argumento, então o comando lia sempre o
    // ÚLTIMO turno — e um botão visualmente preso a uma resposta antiga podia
    // abrir a auditoria da resposta mais recente, possivelmente de outro banco.
    // Agora o `turnId` viaja em `stream.button({ arguments: [...] })`.
    const traceStore = new TurnTraceStore();

    // Métricas da sessão (Etapa H). Acumuladas em memória, não persistidas: são
    // instrumento de comparação entre modelos numa bateria de perguntas, não
    // telemetria. Fechar a janela zera — e é o comportamento correto, porque a
    // comparação só vale dentro do mesmo corpus e do mesmo conjunto de perguntas.
    const sessionTurns = [];

    // Cache das leituras de prefetch (P1). Schema, `ProjectContext` e as
    // propriedades sondadas não mudam entre perguntas da mesma conversa — só
    // uma reexportação do grafo os altera, e o TTL cobre esse caso. Sem ele,
    // cada pergunta repetia ~280ms de consulta antes da primeira palavra do
    // modelo, e a saudação ainda refazia tudo de novo na pergunta seguinte.
    const prefetchCache = new PrefetchCache();

    const handler = async (request, chatContext, stream, token) => {
        const selectedDatabase = getSelectedDatabase(context);

        // Prompt vazio: apresenta o projeto em vez de mandar mensagem vazia ao
        // provedor. Precisa das ferramentas para ler o grafo, daí o start aqui.
        if (!request.prompt || !request.prompt.trim()) {
            // A saudação não é resposta auditável. Os traces anteriores
            // permanecem no store — cada um é endereçado pelo seu botão, e
            // apagá-los aqui quebraria a auditoria de respostas ainda na tela.
            const greeting = await resolveGraphTools(context);
            lastSuggestions = await renderWelcome(
                stream,
                greeting.tools,
                selectedDatabase,
                token,
                greeting.client,
                prefetchCache,
                // O MESMO escopo que o handler usa. Chavear a saudação só pelo
                // banco faria o cache nunca acertar entre ela e a primeira
                // pergunta — que é exatamente o par que P3 existe para não
                // repetir.
                `${(greeting.profile && greeting.profile.id) || 'mcp'}|${selectedDatabase || ''}`
            );
            return;
        }

        lastSuggestions = [];

        // O transporte vem do perfil ativo; o MCP é fallback para quem ainda
        // não migrou. `client` indefinido significa "pelo MCP", e é o que
        // `invokeAnyTool` usa para decidir o caminho de cada chamada.
        const { tools, client, profile } = await resolveGraphTools(context);

        // O cache é escopado por CONEXÃO + banco, não só por banco. Dois perfis
        // podem apontar para bancos de mesmo nome em servidores diferentes — um
        // local e um remoto, o caso normal de quem valida antes de publicar — e
        // servir o schema de um deles sob o outro produziria a pior falha
        // possível aqui: uma resposta plausível sobre o grafo errado.
        const cacheScope = `${(profile && profile.id) || 'mcp'}|${selectedDatabase || ''}`;

        // Sem ferramentas o modelo não tem como consultar o banco — e, se
        // perguntado assim mesmo, ele INVENTA a resposta em vez de admitir que
        // não sabe (observado ao vivo: listou bancos inexistentes com ar de
        // certeza). Parar aqui é a diferença entre um erro visível e um dado
        // falso apresentado como verdadeiro.
        if (tools.length === 0) {
            // Com perfil ativo isto quase não acontece: as ferramentas passam a
            // vir do próprio perfil, não de um servidor MCP que pode não ter
            // subido. Sobra o caso de perfil ausente ou incompleto — e aí
            // `describeNextStep` nomeia a lacuna concreta em vez de repetir
            // "configure a conexão" a quem acabou de configurá-la.
            const next = describeNextStep(await readConnectionStatus(context, false));
            stream.markdown(
                '**Não consultei o banco.** Nenhuma conexão com o grafo está disponível, ' +
                    'então qualquer resposta minha sobre os dados seria inventada.\n\n' +
                    (next ? next.message : '')
            );
            if (next) {
                stream.button({ command: next.command, title: next.title });
            }
            return;
        }

        const messages = [
            ...buildHistoryMessages(chatContext && chatContext.history),
            vscode.LanguageModelChatMessage.User(request.prompt)
        ];

        // O registro do turno começa aqui, antes da primeira consulta: o schema
        // e o `ProjectContext` são chamadas reais ao banco e precisam aparecer
        // no custo. Ficavam fora de qualquer contabilidade.
        const trace = createTurnTrace({
            turnId: traceStore.nextId(),
            question: request.prompt,
            database: selectedDatabase,
            model: request.model
        });

        // O banco escolhido entra no prompt a cada turno, não na ativação: o
        // pesquisador pode trocar de banco no meio da conversa.
        let systemPrompt = buildSystemPromptWithDatabase(SYSTEM_PROMPT, selectedDatabase);

        // Contexto do projeto, gravado no grafo pelo synesis-graph >= 0.8.0.
        //
        // Lido ANTES do schema porque o escopo das métricas — declarado aqui —
        // muda o que o resumo de schema deve dizer sobre um ranking. A leitura
        // é barata sem `template_doc`; a decisão de carregá-lo vem depois,
        // quando os nomes do schema já são conhecidos.
        const contextRecord = await prefetchCache.resolve(cacheScope, SLOT.CONTEXT, () =>
            readProjectContext(tools, selectedDatabase, token, { trace, client })
        );
        const metricsScope =
            contextRecord && contextRecord.metricsBackend && contextRecord.metricsScope
                ? { backend: contextRecord.metricsBackend, scope: contextRecord.metricsScope }
                : undefined;

        // Schema real do projeto: é o que adapta o assistente ao template
        // deste banco em vez de presumir o vocabulário de outro.
        const schema = await prefetchCache.resolve(cacheScope, SLOT.SCHEMA, () =>
            describeProjectSchema(tools, selectedDatabase, token, trace, metricsScope, client)
        );
        if (schema && schema.text) {
            systemPrompt = `${systemPrompt}\n\n${schema.text}`;
        }

        // O que o dado tem e o schema não declara (B1/B2). Vem DEPOIS do resumo
        // de schema de propósito: é uma correção do que aquele resumo omite, e
        // lê-se na ordem em que corrige. Banco com schema completo não gera
        // seção nenhuma e não custa nada além da sondagem.
        const observed = await prefetchCache.resolve(cacheScope, SLOT.OBSERVED, () =>
            probeUndeclaredProperties(tools, selectedDatabase, schema, token, trace, client)
        );

        // O `template_doc` entra por sinal ESTRUTURAL, não por palavra-chave em
        // português: primeiro turno da conversa, ou pergunta que não nomeia nada
        // que o schema conheça. Ver `questionNeedsTemplateSemantics` — a versão
        // lexical nunca disparava num corpus em inglês.
        //
        // A segunda leitura acontece só quando ele é preciso: é a única parte
        // cara (~6,5k tokens contra ~150 do resto).
        const isFirstTurn = !(chatContext && chatContext.history && chatContext.history.length > 0);
        const needsTemplate = questionNeedsTemplateSemantics(request.prompt, {
            isFirstTurn,
            knownNames: (schema && schema.names) || []
        });
        // A leitura `full` fica num slot próprio (R2): ela é superconjunto da
        // leve, mas custa os ~28,7k chars do `template_doc`, e cacheá-las juntas
        // faria toda pergunta seguinte carregar o documento inteiro mesmo quando
        // `needsTemplate` é falso. Slots separados mantêm cada custo no turno
        // que de fato pediu por ele.
        const contextForPrompt = needsTemplate
            ? await prefetchCache.resolve(cacheScope, SLOT.CONTEXT_FULL, () =>
                  readProjectContext(tools, selectedDatabase, token, { full: true, trace, client })
              )
            : contextRecord;

        // A seção da sondagem é montada AQUI, e não junto do schema, porque
        // depende de saber se o `template_doc` entrou (R1): quando ele entra, os
        // nomes que ele já cita saem da sondagem e fica só o que ele não diz —
        // o tipo, e a advertência de texto numérico. A POSIÇÃO no prompt não
        // muda: continua entre o schema e a semântica do template, que é a ordem
        // em que cada camada corrige a anterior.
        const observedText = observed
            ? renderObservedProperties(
                  dedupeAgainstTemplate(observed.byLabel, contextForPrompt && contextForPrompt.templateDoc)
              )
            : '';
        if (observedText) {
            systemPrompt = `${systemPrompt}\n\n${observedText}`;
        }

        const projectContext = renderProjectContext(contextForPrompt);
        if (projectContext) {
            systemPrompt = `${systemPrompt}\n\n${projectContext}`;
        }

        try {
            // O prompt de sistema vai por `modelOptions.system`, não como uma
            // mensagem `user` extra: empilhar dois `user` seguidos é aceito
            // pela Anthropic mas rejeitado ou degradado por provedores que
            // exigem alternância estrita de papéis.
            const outcome = await runToolCallingLoop(
                request.model,
                messages,
                tools,
                stream,
                token,
                systemPrompt,
                trace,
                client
            );

            // Métricas do turno: aritmética sobre o que já aconteceu, sem
            // chamada extra e sem juiz LLM.
            if (outcome) {
                sessionTurns.push({
                    question: request.prompt,
                    // Modelo e banco POR TURNO (Etapa 7): o pesquisador pode
                    // trocar os dois no meio da sessão, e agregar sem registrar
                    // faria a troca parecer diferença entre modelos.
                    model: (trace.model && (trace.model.name || trace.model.id)) || undefined,
                    database: trace.database,
                    ...measureTurn({ ...outcome, trace })
                });
            }

            // O registro do turno fica disponível para o botão, endereçado pelo
            // seu ID. Guardado mesmo quando não há evidência: as consultas
            // executadas explicam a resposta em qualquer classificação.
            traceStore.save(trace);

            // O rótulo diz o que o botão ENTREGA, e o que ele entrega é o
            // registro determinístico do turno — não uma segunda opinião. O
            // nome "trilha de auditoria" prometia mais do que o segundo ciclo
            // generativo era capaz de cumprir.
            //
            // A classificação decide se o botão aparece e com que promessa:
            // `evidence` tem trecho a mostrar; `aggregate` tem consultas e
            // unidades, mas nenhum trecho; template, vazio e erro não têm
            // trilha de corpus e o botão viraria ruído.
            if (outcome && outcome.kind === TurnKind.EVIDENCE) {
                stream.button({
                    command: AUDIT_COMMAND,
                    title: 'Ver evidências e consultas do turno',
                    arguments: [trace.turnId]
                });
            } else if (outcome && outcome.kind === TurnKind.AGGREGATE) {
                stream.button({
                    command: AUDIT_COMMAND,
                    title: 'Ver consultas e unidades do turno',
                    arguments: [trace.turnId]
                });
            }

            // Métricas no mesmo padrão da auditoria: um botão, não um rodapé.
            // Ficavam só na paleta e por isso eram invisíveis — um recurso que
            // ninguém sabe existir é um recurso que ninguém usa.
            //
            // A partir do segundo turno: com uma pergunta só, "média de rodadas"
            // é a própria rodada, e comparar exige mais de um ponto.
            //
            // **Atrás de uma configuração (Etapa 7).** Enquanto não houver uma
            // bateria por corpus, estes números são diagnóstico exploratório: a
            // precisão literal não é fidelidade, as armadilhas são genéricas, e
            // a sessão pode misturar modelos. Um número exploratório oferecido
            // por botão vira selo de qualidade — e o relatório passa a ser lido
            // como se dissesse qual modelo é mais confiável.
            if (sessionTurns.length > 1 && metricsButtonEnabled()) {
                stream.button({
                    command: METRICS_COMMAND,
                    title: `Métricas da sessão (${sessionTurns.length} perguntas)`
                });
            }
        } catch (error) {
            stream.markdown(`\n\n**Erro:** ${error.message || error}`);
        }
    };

    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
    participant.iconPath = new vscode.ThemeIcon('graph');

    // O comando do botão. Registrado aqui, e não em `extension.js`, porque
    // precisa do `traceStore` — que é estado deste participant.
    //
    // **Não chama LLM e não consulta o banco.** Renderiza o trace capturado
    // durante o turno: as consultas executadas, o modelo, o banco e as
    // evidências que voltaram. Antes, o botão reentrava no chat como uma nova
    // pergunta e pedia ao modelo que reconstruísse a trilha — uma reavaliação
    // generativa que podia contradizer a resposta sem estar certa. A
    // reavaliação continua existindo, no comando separado abaixo.
    //
    // Abre em documento Markdown pelo mesmo padrão de `showMetrics`: é material
    // para conferir ao lado do `.syn`, não para rolar para fora do histórico.
    context.subscriptions.push(
        vscode.commands.registerCommand(AUDIT_COMMAND, async (turnId) => {
            const trace = turnId ? traceStore.get(turnId) : undefined;
            if (!trace) {
                vscode.window.showInformationMessage(
                    'Synesis: o registro deste turno não está mais disponível. ' +
                        'A trilha cobre as respostas recentes desta sessão.'
                );
                return;
            }

            const report = [
                renderTurnReport(trace),
                '',
                renderAuditTrail(groupByOrigin(extractOriginRecords(traceToolTexts(trace))))
            ].join('\n');

            const document = await vscode.workspace.openTextDocument({
                content: report,
                language: 'markdown'
            });
            await vscode.window.showTextDocument(document, { preview: false });
        })
    );

    // Reavaliação: a segunda análise que o botão antigo fazia sem dizer que era
    // uma segunda análise.
    //
    // Continua valendo — um olhar novo sobre a evidência encontra coisa que a
    // primeira passagem não viu. O que muda é o enquadramento: é uma NOVA
    // execução, pode discordar, e não substitui o registro do turno. E fixa o
    // banco do trace em vez de usar o selecionado agora: trocar de banco entre
    // a resposta e a reavaliação faria auditar outro corpus.
    context.subscriptions.push(
        vscode.commands.registerCommand(REASSESS_COMMAND, async (turnId) => {
            const trace = turnId ? traceStore.get(turnId) : undefined;
            if (!trace) {
                vscode.window.showInformationMessage(
                    'Synesis: o registro deste turno não está mais disponível para reavaliação.'
                );
                return;
            }
            if (trace.database && trace.database !== getSelectedDatabase(context)) {
                const choice = await vscode.window.showWarningMessage(
                    `Este turno consultou o banco "${trace.database}", diferente do selecionado agora. ` +
                        'A reavaliação usa o banco atual — o resultado pode não ser comparável.',
                    'Reavaliar mesmo assim',
                    'Cancelar'
                );
                if (choice !== 'Reavaliar mesmo assim') {
                    return;
                }
            }
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: `@synesis ${buildAuditPrompt(trace.question, trace.finalAnswer, traceQueries(trace))}`
            });
        })
    );

    // Relatório das métricas da sessão (Etapa H).
    //
    // Abre num documento Markdown em vez de no chat: é material para comparar
    // com OUTRA sessão, de outro modelo, e um texto no chat se perde no
    // histórico. O pesquisador salva os dois e confronta.
    context.subscriptions.push(
        vscode.commands.registerCommand(METRICS_COMMAND, async () => {
            if (sessionTurns.length === 0) {
                vscode.window.showInformationMessage(
                    'Synesis: nenhuma pergunta medida ainda nesta sessão. Pergunte algo ao @synesis primeiro.'
                );
                return;
            }

            // Os turnos-armadilha são identificados pelo texto da pergunta: são
            // fixos, então casar por igualdade é suficiente e não exige que o
            // pesquisador marque nada.
            const traps = sessionTurns.filter((t) => TRAP_QUESTIONS.includes(t.question));
            const regular = sessionTurns.filter((t) => !TRAP_QUESTIONS.includes(t.question));

            const report = renderReport(
                `sessão (${sessionTurns.length} perguntas)`,
                summarize(regular.length ? regular : sessionTurns),
                traps.length ? summarize(traps) : undefined,
                {
                    models: sessionTurns.map((t) => t.model),
                    databases: sessionTurns.map((t) => t.database)
                }
            );

            const document = await vscode.workspace.openTextDocument({
                content: report,
                language: 'markdown'
            });
            await vscode.window.showTextDocument(document, { preview: false });
        })
    );

    // As perguntas sugeridas da saudação viram itens clicáveis. É o mecanismo
    // certo para isto: `stream.button()` executa um COMANDO, não insere texto
    // no chat, então não serve para sugerir uma pergunta.
    participant.followupProvider = {
        provideFollowups: () => lastSuggestions
    };
    context.subscriptions.push(participant);
    return participant;
}

module.exports = {
    registerChatParticipant,
    PARTICIPANT_ID,
    // Exportados para teste unitário.
    selectArcadeDbTools,
    matchesArcadeDbTool,
    describeProjectSchema,
    probeUndeclaredProperties,
    validLabel,
    readProjectContext,
    renderProjectContext,
    renderSemanticCapability,
    describeGraphMetrics,
    questionNeedsTemplateSemantics,
    describeStaleness,
    renderWelcome,
    buildSuggestedQuestions,
    readTopTaxonomy,
    findTaxonomyLabel,
    taxonomyEdgePattern,
    availableMetrics,
    schemaNames,
    describeAccessFailure,
    readMaxToolRounds,
    buildHistoryMessages,
    AUDIT_COMMAND,
    REASSESS_COMMAND,
    METRICS_COMMAND,
    ARCADEDB_TOOL_NAMES,
    SYSTEM_PROMPT,
    CITATION_RULES,
    COUNTING_RULES
};
