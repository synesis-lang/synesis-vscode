/**
 * graphClients.js - Consulta ao grafo, um cliente por backend.
 *
 * O chat falava com o banco por um caminho só: ferramentas MCP publicadas em
 * `vscode.lm.tools`, reconhecidas por um filtro que procurava a string
 * `'arcade'` no nome do servidor. Isso amarrava o chat a **uma** combinação —
 * ArcadeDB, sobre TCP, com um `mcp.json` declarado à mão — e excluía o Neo4j
 * por construção: não há como um servidor chamado `neo4j` casar com um filtro
 * que exige `arcade` no nome.
 *
 * Aqui o transporte vira uma escolha explícita do perfil ativo. Cada cliente
 * expõe as MESMAS quatro operações, de modo que o loop de tool-calling não
 * saiba com quem está falando:
 *
 *   listDatabases()          -> string[]
 *   getSchema(database)      -> { types: [...] }
 *   query(database, lang, q) -> { records: [...] }
 *   serverStatus()           -> objeto livre
 *
 * **Somente leitura, por construção.** As operações de escrita não existem
 * nesta superfície — não é uma verificação que se possa esquecer de fazer. O
 * conteúdo do corpus é texto não confiável (uma injeção indireta pode instruir
 * o modelo a escrever), e a defesa é a ferramenta não estar lá.
 */

const vscode = require('vscode');
const {
    BACKEND_ARCADEDB,
    BACKEND_ARCADEDB_EMBEDDED,
    BACKEND_NEO4J
} = require('./connectionProfiles');

/** Timeout de uma consulta. Generoso: agregações num corpus grande demoram. */
const QUERY_TIMEOUT_MS = 60000;
const META_TIMEOUT_MS = 10000;

/**
 * Erro de consulta com a causa já classificada.
 *
 * O texto importa: `describeAccessFailure`, no participant, decide entre
 * "re-exporte o projeto" e "troque a credencial" lendo a mensagem. Classificar
 * aqui, onde a resposta HTTP ainda está à mão, é mais confiável que adivinhar
 * pelo texto do servidor depois.
 */
class GraphQueryError extends Error {
    constructor(message, { kind } = {}) {
        super(message);
        this.name = 'GraphQueryError';
        this.kind = kind;
    }
}

/**
 * Cliente HTTP do ArcadeDB.
 *
 * Fala a API HTTP/JSON, que funciona numa instalação padrão. O MCP que o
 * próprio ArcadeDB serve continua existindo e continua útil para OUTROS
 * clientes (Claude Desktop, Copilot); o chat da extensão simplesmente não
 * precisa mais dele como intermediário — e assim não depende de o pesquisador
 * ter declarado um `mcp.json`, nem de o servidor MCP ter subido nesta janela.
 */
class ArcadeDbHttpClient {
    constructor(profile) {
        this.base = String(profile.uri || '').replace(/\/+$/, '');
        this.user = profile.user;
        this.password = profile.password;
        this.label = `ArcadeDB ${this.base}`;
    }

    get authHeader() {
        const token = Buffer.from(`${this.user}:${this.password || ''}`).toString('base64');
        return `Basic ${token}`;
    }

    async request(path, { method = 'GET', body, timeout = META_TIMEOUT_MS } = {}) {
        let response;
        try {
            response = await fetch(`${this.base}${path}`, {
                method,
                headers: {
                    Authorization: this.authHeader,
                    Accept: 'application/json',
                    ...(body ? { 'Content-Type': 'application/json' } : {})
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(timeout)
            });
        } catch (error) {
            const reason =
                error && error.name === 'TimeoutError'
                    ? `não respondeu em ${Math.round(timeout / 1000)}s`
                    : 'não pôde ser alcançado';
            throw new GraphQueryError(`O servidor ${this.base} ${reason}.`, { kind: 'unreachable' });
        }

        if (response.status === 401 || response.status === 403) {
            // Mesma distinção que `describeAccessFailure` já fazia pelo texto:
            // sem permissão, re-exportar o projeto não resolve nada.
            throw new GraphQueryError(
                `not authorized: o usuário "${this.user}" não tem acesso a este recurso.`,
                { kind: 'forbidden' }
            );
        }
        if (response.status === 404) {
            throw new GraphQueryError('does not exist: recurso não encontrado no servidor.', {
                kind: 'missing'
            });
        }
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new GraphQueryError(`HTTP ${response.status}${text ? ` — ${text.slice(0, 300)}` : ''}`, {
                kind: 'error'
            });
        }
        return response.json();
    }

    async listDatabases() {
        const payload = await this.request('/api/v1/databases');
        const list = Array.isArray(payload) ? payload : payload && payload.result;
        return Array.isArray(list) ? list.filter((name) => typeof name === 'string') : [];
    }

    /**
     * O schema, no formato `{ types: [{ name, properties }] }`.
     *
     * O consumidor (`describeProjectSchema`) espera exatamente esse shape, que
     * é o que o MCP do ArcadeDB devolvia. Traduzir aqui mantém intacto tudo que
     * lê schema — inclusive o prompt de sistema, que descreve os rótulos ao
     * modelo.
     */
    async getSchema(database) {
        const payload = await this.request(`/api/v1/query/${encodeURIComponent(database)}`, {
            method: 'POST',
            body: { language: 'sql', command: 'SELECT FROM schema:types' }
        });
        const rows = (payload && payload.result) || [];
        return {
            types: rows.map((row) => ({
                name: row.name,
                type: row.type,
                properties: Array.isArray(row.properties)
                    ? row.properties.map((p) => (typeof p === 'string' ? { name: p } : p))
                    : []
            }))
        };
    }

    async query(database, language, statement) {
        const payload = await this.request(`/api/v1/query/${encodeURIComponent(database)}`, {
            method: 'POST',
            body: { language: language || 'cypher', command: statement },
            timeout: QUERY_TIMEOUT_MS
        });
        return { records: (payload && payload.result) || [] };
    }

    async serverStatus() {
        return this.request('/api/v1/server');
    }
}

/**
 * Cliente Neo4j sobre Bolt.
 *
 * O driver é carregado sob demanda e por nome resolvido em tempo de execução:
 * `neo4j-driver` é uma dependência opcional, e um `require` estático no topo
 * faria a extensão INTEIRA falhar ao carregar em quem não usa Neo4j. O custo
 * disso é a mensagem de ausência precisar ser boa, o que ela é.
 */
class Neo4jBoltClient {
    constructor(profile) {
        this.uri = profile.uri;
        this.user = profile.user;
        this.password = profile.password;
        this.defaultDatabase = profile.database || 'neo4j';
        this.label = `Neo4j ${this.uri}`;
        this.driver = undefined;
    }

    /** O driver, ou um erro que diz como instalá-lo. */
    loadDriver() {
        if (this.driver) {
            return this.driver;
        }
        let neo4j;
        try {
            neo4j = require('neo4j-driver');
        } catch {
            throw new GraphQueryError(
                'O suporte a Neo4j precisa do pacote `neo4j-driver`, que não está disponível nesta ' +
                    'instalação da extensão. Reinstale a extensão a partir de um `.vsix` que o inclua.',
                { kind: 'missing-driver' }
            );
        }
        this.driver = neo4j.driver(this.uri, neo4j.auth.basic(this.user, this.password || ''), {
            // O padrão do driver espera indefinidamente; num AuraDB inacessível
            // isso trava o turno sem dizer nada.
            connectionAcquisitionTimeout: 15000,
            connectionTimeout: 15000
        });
        this.neo4j = neo4j;
        return this.driver;
    }

    async run(database, statement, { timeout = QUERY_TIMEOUT_MS } = {}) {
        const driver = this.loadDriver();
        const session = driver.session({ database: database || this.defaultDatabase });
        try {
            const result = await session.run(statement, {}, { timeout });
            return result.records.map((record) => normalizeNeo4jRecord(record, this.neo4j));
        } catch (error) {
            throw translateNeo4jError(error, this.uri, this.user);
        } finally {
            await session.close().catch(() => undefined);
        }
    }

    async listDatabases() {
        // `SHOW DATABASES` corre no banco de sistema; num AuraDB de instância
        // única ele pode não estar disponível, e nesse caso o banco configurado
        // é a resposta honesta.
        try {
            const rows = await this.run('system', 'SHOW DATABASES YIELD name RETURN name', {
                timeout: META_TIMEOUT_MS
            });
            return rows.map((row) => row.name).filter(Boolean);
        } catch {
            return this.defaultDatabase ? [this.defaultDatabase] : [];
        }
    }

    /**
     * Schema no mesmo shape do ArcadeDB.
     *
     * `db.schema.nodeTypeProperties()` é o procedimento padrão desde o Neo4j 4;
     * ele devolve uma linha por (rótulo, propriedade), então é preciso agrupar
     * para chegar ao formato `{ name, properties }` que o resto do chat espera.
     */
    async getSchema(database) {
        const rows = await this.run(
            database,
            'CALL db.schema.nodeTypeProperties() ' +
                'YIELD nodeLabels, propertyName ' +
                'RETURN nodeLabels AS labels, collect(propertyName) AS properties',
            { timeout: META_TIMEOUT_MS }
        );

        const byLabel = new Map();
        for (const row of rows) {
            const labels = Array.isArray(row.labels) ? row.labels : [];
            for (const label of labels) {
                const existing = byLabel.get(label) || new Set();
                for (const property of row.properties || []) {
                    if (property) {
                        existing.add(property);
                    }
                }
                byLabel.set(label, existing);
            }
        }

        const types = [...byLabel.entries()].map(([name, properties]) => ({
            name,
            type: 'vertex',
            properties: [...properties].map((property) => ({ name: property }))
        }));

        // As arestas entram como tipos também: o prompt de sistema lista os
        // rótulos do schema para o modelo, e sem elas ele não sabe navegar.
        try {
            const relRows = await this.run(database, 'CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType AS name', {
                timeout: META_TIMEOUT_MS
            });
            for (const row of relRows) {
                if (row.name) {
                    types.push({ name: row.name, type: 'edge', properties: [] });
                }
            }
        } catch {
            // Sem os tipos de aresta o chat ainda funciona, só navega pior.
        }

        return { types };
    }

    async query(database, language, statement) {
        if (language && language !== 'cypher') {
            throw new GraphQueryError(
                `O Neo4j só aceita Cypher; a consulta foi enviada como "${language}".`,
                { kind: 'error' }
            );
        }
        return { records: await this.run(database, statement) };
    }

    async serverStatus() {
        const rows = await this.run(this.defaultDatabase, 'CALL dbms.components() YIELD name, versions, edition RETURN name, versions, edition', {
            timeout: META_TIMEOUT_MS
        });
        return { components: rows };
    }

    dispose() {
        if (this.driver) {
            this.driver.close().catch(() => undefined);
            this.driver = undefined;
        }
    }
}

/**
 * Converte um registro do driver para JSON simples.
 *
 * Os inteiros do Neo4j são objetos `{low, high}` — 64 bits que não cabem num
 * `number`. Passá-los cruas ao modelo produziria `{"low":42,"high":0}` no lugar
 * de `42`, e o modelo relataria a contagem errada com toda a confiança.
 */
function normalizeNeo4jRecord(record, neo4j) {
    const out = {};
    for (const key of record.keys) {
        out[key] = normalizeNeo4jValue(record.get(key), neo4j);
    }
    return out;
}

function normalizeNeo4jValue(value, neo4j) {
    if (value === null || value === undefined) {
        return null;
    }
    if (neo4j && neo4j.isInt && neo4j.isInt(value)) {
        // `toNumber` perde precisão acima de 2^53; para além disso a string é
        // preferível a um número silenciosamente errado.
        return value.inSafeRange() ? value.toNumber() : value.toString();
    }
    if (Array.isArray(value)) {
        return value.map((item) => normalizeNeo4jValue(item, neo4j));
    }
    // Nós e arestas: o que interessa ao chat são as propriedades.
    if (value && typeof value === 'object') {
        if (value.properties) {
            return normalizeNeo4jValue(value.properties, neo4j);
        }
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = normalizeNeo4jValue(item, neo4j);
        }
        return out;
    }
    return value;
}

/** Traduz o erro do driver para as mesmas categorias do cliente HTTP. */
function translateNeo4jError(error, uri, user) {
    const code = (error && error.code) || '';
    const message = (error && error.message) || String(error);

    if (/Unauthorized|AuthenticationRate|Neo\.ClientError\.Security/i.test(code + message)) {
        return new GraphQueryError(`not authorized: o Neo4j recusou as credenciais de "${user}".`, {
            kind: 'forbidden'
        });
    }
    if (/DatabaseNotFound|database does not exist/i.test(code + message)) {
        return new GraphQueryError('does not exist: o banco não existe neste servidor.', { kind: 'missing' });
    }
    if (/ServiceUnavailable|SessionExpired|ECONNREFUSED|ETIMEDOUT/i.test(code + message)) {
        return new GraphQueryError(`O servidor ${uri} não pôde ser alcançado.`, { kind: 'unreachable' });
    }
    return new GraphQueryError(message, { kind: 'error' });
}

/**
 * ArcadeDB embutido.
 *
 * Não implementado nesta etapa, e o motivo é honesto: o modo embutido roda a
 * engine DENTRO do processo, e a engine é Java. O `arcadedb-embedded` do
 * ecossistema é um pacote Python; não há equivalente carregável no host Node do
 * VSCode. Servir esse modo exigiria um processo auxiliar — desenho próprio, não
 * um cliente a mais.
 *
 * Existe como classe, e não como ausência, para que a mensagem diga isso em vez
 * de o perfil simplesmente não funcionar sem explicação.
 */
class ArcadeDbEmbeddedClient {
    constructor(profile) {
        this.dbPath = profile.dbPath;
        this.label = `ArcadeDB embutido (${profile.dbPath})`;
    }

    unsupported() {
        throw new GraphQueryError(
            'O chat ainda não consulta o ArcadeDB no modo embutido: a engine embutida é Java e não ' +
                'roda dentro do VSCode. Para conversar com este corpus, suba um servidor ArcadeDB ' +
                'sobre a mesma pasta e cadastre uma conexão do tipo "ArcadeDB (servidor)".',
            { kind: 'unsupported' }
        );
    }

    listDatabases() {
        return this.unsupported();
    }

    getSchema() {
        return this.unsupported();
    }

    query() {
        return this.unsupported();
    }

    serverStatus() {
        return this.unsupported();
    }
}

/** O cliente do perfil, ou `undefined` se o backend for desconhecido. */
function createGraphClient(profile) {
    if (!profile) {
        return undefined;
    }
    switch (profile.backend) {
        case BACKEND_ARCADEDB:
            return new ArcadeDbHttpClient(profile);
        case BACKEND_NEO4J:
            return new Neo4jBoltClient(profile);
        case BACKEND_ARCADEDB_EMBEDDED:
            return new ArcadeDbEmbeddedClient(profile);
        default:
            return undefined;
    }
}

/**
 * As quatro operações apresentadas ao modelo como ferramentas.
 *
 * O shape imita `LanguageModelToolInformation` de propósito: o loop de
 * tool-calling recebe estas e as ferramentas MCP pelo mesmo caminho, então a
 * migração não exige reescrevê-lo.
 *
 * A linguagem de consulta entra na descrição porque ela muda com o backend, e
 * um modelo que mande SQL para o Neo4j gasta uma rodada inteira para descobrir
 * o erro.
 */
function describeTools(backend) {
    const language = backend === BACKEND_NEO4J ? 'Cypher' : 'Cypher ou SQL';
    return [
        {
            name: 'synesis_graph_query',
            description:
                `Executa uma consulta de LEITURA no grafo (${language}) e devolve os registros. ` +
                'Use para toda pergunta sobre o corpus. Não há ferramenta de escrita.',
            inputSchema: {
                type: 'object',
                properties: {
                    database: { type: 'string', description: 'Nome do banco.' },
                    language: {
                        type: 'string',
                        enum: backend === BACKEND_NEO4J ? ['cypher'] : ['cypher', 'sql'],
                        description: 'Linguagem da consulta.'
                    },
                    query: { type: 'string', description: 'A consulta.' }
                },
                required: ['database', 'query']
            }
        },
        {
            name: 'synesis_graph_get_schema',
            description: 'Lista os rótulos de vértice e aresta do banco, com suas propriedades.',
            inputSchema: {
                type: 'object',
                properties: { database: { type: 'string' } },
                required: ['database']
            }
        },
        {
            name: 'synesis_graph_list_databases',
            description: 'Lista os bancos disponíveis no servidor configurado.',
            inputSchema: { type: 'object', properties: {} }
        },
        {
            name: 'synesis_graph_server_status',
            description: 'Estado do servidor de grafo configurado.',
            inputSchema: { type: 'object', properties: {} }
        }
    ];
}

/** `true` para os nomes que este módulo atende. */
function isGraphTool(name) {
    return typeof name === 'string' && name.startsWith('synesis_graph_');
}

/**
 * Executa uma das ferramentas acima e devolve no formato do
 * `LanguageModelToolResult` — uma parte de texto com JSON dentro.
 *
 * O formato importa: `citationGuard`, `sourceAnchor` e a trilha de auditoria
 * leem o payload cru como texto JSON, exatamente como o MCP o entregava.
 * Devolver objeto estruturado aqui quebraria os três em silêncio.
 */
/**
 * O argumento obrigatório chegou preenchido?
 *
 * **Por que isto existe.** Um argumento ausente descia até o servidor como
 * `undefined`, e `JSON.stringify` **descarta a chave** — o ArcadeDB recebia um
 * corpo sem `command` e respondia `HTTP 400 — "command missing"`. Observado ao
 * vivo com o `liquid/lfm-2.5-2.6b:free`: o modelo chamou a ferramenta sem
 * preencher `query`, errou duas vezes seguidas e não tinha como se corrigir,
 * porque o erro falava de um campo (`command`) que não existe no contrato que
 * ele conhece (`query`).
 *
 * A mensagem devolvida nomeia o parâmetro que o MODELO declara, não o do
 * protocolo HTTP: é a diferença entre um erro que ele pode corrigir na rodada
 * seguinte e um que só produz mais uma tentativa idêntica.
 *
 * Vale para qualquer modelo — um forte também erra o preenchimento de vez em
 * quando —, mas é com os pequenos que a diferença aparece, e são justamente
 * eles que uma campanha de "qual o menor modelo que dá conta" vai exercitar.
 */
function requireArg(args, field, toolName) {
    const value = args[field];
    if (typeof value === 'string' && value.trim()) {
        return value;
    }
    // Vazio e ausente pedem frases diferentes: dizer "recebi apenas database,
    // query" quando `query` é exatamente o campo em branco confundiria em vez de
    // orientar. Os OUTROS parâmetros é que situam o modelo sobre o que ele
    // mandou.
    const presente = Object.prototype.hasOwnProperty.call(args, field);
    const outros = Object.keys(args).filter(
        (k) => k !== field && args[k] !== undefined && args[k] !== null && String(args[k]).trim()
    );
    throw new GraphQueryError(
        `A chamada de \`${toolName}\` veio ${presente ? 'com' : 'sem'} o parâmetro obrigatório ` +
            `\`${field}\`${presente ? ', mas vazio' : ''}. ` +
            (outros.length
                ? `Os demais parâmetros vieram: ${outros.map((k) => `\`${k}\``).join(', ')}. `
                : 'Nenhum outro parâmetro foi informado. ') +
            `Repita a chamada preenchendo \`${field}\` com um valor de texto não vazio.`,
        { kind: 'bad_arguments' }
    );
}

async function invokeGraphTool(client, name, input) {
    const args = input || {};
    let payload;

    switch (name) {
        case 'synesis_graph_query':
            // Validado ANTES da rede: sem isto o argumento vazio viraria um 400
            // do servidor falando de `command`, um campo que o modelo não
            // conhece — e por isso não consegue corrigir.
            payload = await client.query(
                requireArg(args, 'database', name),
                args.language,
                requireArg(args, 'query', name)
            );
            break;
        case 'synesis_graph_get_schema':
            payload = await client.getSchema(requireArg(args, 'database', name));
            break;
        case 'synesis_graph_list_databases':
            payload = { databases: await client.listDatabases() };
            break;
        case 'synesis_graph_server_status':
            payload = await client.serverStatus();
            break;
        default:
            throw new GraphQueryError(`Ferramenta desconhecida: ${name}`, { kind: 'error' });
    }

    return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify(payload))
    ]);
}

module.exports = {
    GraphQueryError,
    ArcadeDbHttpClient,
    Neo4jBoltClient,
    ArcadeDbEmbeddedClient,
    createGraphClient,
    describeTools,
    isGraphTool,
    invokeGraphTool,
    normalizeNeo4jRecord,
    normalizeNeo4jValue,
    translateNeo4jError
};
