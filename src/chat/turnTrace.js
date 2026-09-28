/**
 * turnTrace.js — o registro estruturado de um turno do chat.
 *
 * **O defeito que este módulo corrige.** O botão de auditoria não reproduzia o
 * turno: ele abria uma NOVA pergunta e pedia a um novo ciclo do LLM que
 * reconstruísse a trilha. Isso é reavaliação generativa, não trilha — e a
 * segunda execução pode discordar da primeira sem estar certa. Foi o que
 * aconteceu ao vivo: a auditoria contou `count(DISTINCT i.item_id)` (trechos) e
 * comparou com menções, contradizendo uma resposta correta.
 *
 * Uma auditoria que contradiz sem estar certa é pior que não auditar, porque
 * destrói a confiança nas duas respostas.
 *
 * **O dado já passava pela função.** `runToolCallingLoop()` tem, no ponto exato
 * da execução, a rodada, o `callId`, o nome e o input da ferramenta e o conteúdo
 * cru do resultado — e descartava tudo isso num array plano de textos. Capturar
 * o trace é trocar o acumulador, não acrescentar instrumentação: nenhuma chamada
 * a mais, nenhum custo de token.
 *
 * **Memória, não disco.** Os payloads carregam material de pesquisa do
 * pesquisador; gravá-los no projeto seria uma decisão de retenção que ninguém
 * tomou. O `Map` com descarte FIFO basta para os botões da sessão, que é o
 * escopo em que a auditoria é usada.
 */

/**
 * Quantos turnos ficam disponíveis para auditoria.
 *
 * O limite existe porque cada trace guarda os payloads crus do turno — numa
 * sessão longa isso cresce sem teto. Doze cobre com folga a conversa que o
 * pesquisador ainda tem na tela; o que sai por baixo já rolou para fora do
 * alcance prático do botão.
 */
const MAX_TRACES = 12;

/**
 * Classificação do que o turno efetivamente consultou.
 *
 * Substitui o booleano `consultedCorpus`, que era `toolTexts.length > 0` e por
 * isso valia `true` para um payload de schema, uma lista de bancos ou uma
 * consulta vazia — oferecendo trilha de evidência onde não havia evidência
 * nenhuma.
 *
 * A distinção não é cosmética: um botão que promete evidência e abre uma trilha
 * vazia ensina o pesquisador a ignorar o botão.
 */
const TurnKind = {
    /** Há registros com `citation`/`item_id`: existe trecho a auditar. */
    EVIDENCE: 'evidence',
    /** Contagens ou métricas, sem trecho: dá para mostrar consultas e unidades. */
    AGGREGATE: 'aggregate',
    /** A resposta veio do `ProjectContext`/schema, não do corpus. */
    TEMPLATE: 'template',
    /** Consultas válidas que não retornaram linha alguma. */
    EMPTY: 'empty',
    /** Só houve falha de ferramenta. */
    ERROR: 'error',
    /** Nenhuma consulta relevante. */
    NONE: 'none'
};

/** Um turno vazio, pronto para receber as chamadas conforme acontecem. */
function createTurnTrace({ turnId, question, database, model, startedAt }) {
    return {
        turnId,
        question: question || '',
        database: database || undefined,
        // `request.model` expõe `id`, `name`, `vendor`, `family` e `version` na
        // API do VSCode instalada. Guardado achatado porque o objeto do modelo
        // não sobrevive fora do turno.
        model: flattenModel(model),
        startedAt: startedAt || new Date().toISOString(),
        finishedAt: undefined,
        // Quantas vezes `sendRequest()` foi chamado. Não é o mesmo que o número
        // de chamadas de ferramenta: uma rodada pode conter várias.
        modelRequests: 0,
        toolCalls: [],
        finalAnswer: '',
        // Prosa que o modelo escreveu ANTES de chamar uma ferramenta. Não é
        // resposta — é o raciocínio que levou à consulta. Guardada porque
        // explica o percurso no relatório do turno, e mantida FORA de
        // `finalAnswer` para não contaminar o juiz nem as métricas (Etapa 3).
        intermediateText: [],
        // Origens que a contenção recusou — caminho fora de toda raiz aberta,
        // ou arquivo que não está mais lá. Guardadas para o relatório explicar a
        // ausência do link em vez de simplesmente não mostrá-lo (Etapa 5).
        unanchorable: [],
        incomplete: false
    };
}

/**
 * Achata a identidade de um modelo para caber no trace.
 *
 * O objeto `LanguageModelChat` nao sobrevive ao turno — a propria API adverte
 * para nao segura-lo —, entao o que fica guardado sao cinco strings.
 */
function flattenModel(model) {
    if (!model) {
        return undefined;
    }
    return {
        id: model.id,
        name: model.name,
        vendor: model.vendor,
        family: model.family,
        version: model.version
    };
}

/**
 * Reconfirma qual modelo esta respondendo este turno.
 *
 * `createTurnTrace` grava `request.model`, lido no INICIO do turno. Quando o
 * pesquisador troca de modelo no meio da sessao, esse valor pode estar
 * desatualizado, e o relatorio passa a nomear o modelo anterior — numa campanha
 * que compara modelos, o turno e atribuido ao errado.
 *
 * Esta funcao e chamada com o objeto que efetivamente vai a `sendRequest`, no
 * instante da chamada. So sobrescreve quando ha um `id`: um objeto incompleto
 * nao deve apagar o que ja estava registrado.
 */
function captureModel(trace, model) {
    if (!trace || !model || !model.id) {
        return;
    }
    trace.model = flattenModel(model);
}

/**
 * Registra uma chamada de ferramenta como ela ocorreu.
 *
 * `prefetch` marca as leituras que a extensão faz por conta própria — schema e
 * `ProjectContext` — antes de o modelo entrar. Elas custam consulta real e
 * ficavam fora de qualquer contabilidade; separá-las (em vez de omiti-las)
 * mantém o custo honesto sem confundir com o que o modelo pediu.
 */
function recordToolCall(trace, call) {
    if (!trace) {
        return undefined;
    }
    const entry = {
        round: call.round ?? null,
        callId: call.callId || null,
        toolName: call.toolName || '',
        input: call.input,
        prefetch: Boolean(call.prefetch),
        startedAt: call.startedAt || new Date().toISOString(),
        finishedAt: call.finishedAt,
        status: call.status || 'ok',
        // O payload cru, como chegou. É o que permite reconstruir a trilha sem
        // pedir nada ao modelo — e o que o juiz de literalidade confere.
        texts: call.texts || [],
        error: call.error
    };
    trace.toolCalls.push(entry);
    return entry;
}

/** Todos os textos de payload do turno, na ordem em que chegaram. */
function traceToolTexts(trace, { includePrefetch = false } = {}) {
    if (!trace) {
        return [];
    }
    return trace.toolCalls
        .filter((call) => (includePrefetch ? true : !call.prefetch))
        .flatMap((call) => call.texts || []);
}

/** As linhas de um payload, quando ele é o JSON que o MCP do ArcadeDB devolve. */
function parseRows(text) {
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        return undefined;
    }
    const rows = Array.isArray(payload) ? payload : payload && payload.records;
    return Array.isArray(rows) ? rows : undefined;
}

/** A linha traz trecho anotado — isto é, evidência do corpus? */
function rowHasEvidence(row) {
    if (!row || typeof row !== 'object') {
        return false;
    }
    return Boolean(row.citation || row.item_id || row.itemId);
}

/**
 * Classifica o turno a partir do que as ferramentas devolveram.
 *
 * Deriva do payload parseado, nunca da prosa da resposta: é a mesma disciplina
 * das âncoras — reparsear o texto do modelo seria confiar justamente no que a
 * classificação existe para verificar.
 *
 * As chamadas de prefetch entram só como sinal de `template`: elas são schema e
 * `ProjectContext`, e uma resposta que se apoiou apenas nelas é legítima, mas
 * não tem trecho a auditar.
 */
function classifyTurn(trace) {
    if (!trace || trace.toolCalls.length === 0) {
        return TurnKind.NONE;
    }

    const modelCalls = trace.toolCalls.filter((call) => !call.prefetch);
    if (modelCalls.length === 0) {
        return TurnKind.TEMPLATE;
    }

    let sawRows = false;
    let sawEmpty = false;
    let sawParsed = false;
    let sawError = false;

    for (const call of modelCalls) {
        if (call.status === 'error') {
            sawError = true;
            continue;
        }
        for (const text of call.texts || []) {
            const rows = parseRows(text);
            if (rows === undefined) {
                continue;
            }
            sawParsed = true;
            if (rows.length === 0) {
                sawEmpty = true;
                continue;
            }
            if (rows.some(rowHasEvidence)) {
                return TurnKind.EVIDENCE;
            }
            sawRows = true;
        }
    }

    if (sawRows) {
        // Linhas sem `citation`/`item_id`: contagem, métrica, lista de rótulos.
        return TurnKind.AGGREGATE;
    }
    if (sawEmpty) {
        return TurnKind.EMPTY;
    }
    if (sawError && !sawParsed) {
        return TurnKind.ERROR;
    }
    return TurnKind.NONE;
}

/**
 * Guarda os traces da sessão, com descarte FIFO.
 *
 * A identidade é o ponto: o botão passa a carregar o `turnId` em
 * `stream.button({ arguments: [...] })`, então uma resposta antiga continua
 * abrindo o SEU turno mesmo depois de novas perguntas ou de troca de banco.
 * A variável única anterior fazia o botão de qualquer resposta auditar sempre
 * a mais recente.
 */
class TurnTraceStore {
    constructor(limit = MAX_TRACES) {
        this.limit = limit;
        this.traces = new Map();
        this.counter = 0;
    }

    /** Um ID por turno, monotônico e legível no relatório. */
    nextId() {
        this.counter += 1;
        return `turn-${this.counter}`;
    }

    save(trace) {
        if (!trace || !trace.turnId) {
            return;
        }
        this.traces.set(trace.turnId, trace);
        while (this.traces.size > this.limit) {
            // `Map` preserva a ordem de inserção: o primeiro é o mais antigo.
            const oldest = this.traces.keys().next().value;
            this.traces.delete(oldest);
        }
    }

    get(turnId) {
        return this.traces.get(turnId);
    }

    get size() {
        return this.traces.size;
    }
}

module.exports = {
    captureModel,
    flattenModel,
    MAX_TRACES,
    TurnKind,
    createTurnTrace,
    recordToolCall,
    traceToolTexts,
    classifyTurn,
    parseRows,
    rowHasEvidence,
    TurnTraceStore
};
