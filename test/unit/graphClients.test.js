'use strict';

/**
 * Testes da camada de consulta ao grafo.
 *
 * O chat falava com o banco por um caminho só — ferramentas MCP reconhecidas
 * por um filtro que exige a string `'arcade'` no nome do servidor. Isso excluía
 * o Neo4j por construção: nenhum servidor chamado `neo4j` casa com esse filtro.
 *
 * O contrato que estes testes protegem é o que permite trocar o transporte sem
 * tocar em `citationGuard`, `sourceAnchor` nem na trilha de auditoria: **todos
 * os clientes devolvem o mesmo shape**, e o payload chega como texto JSON numa
 * parte de texto, exatamente como o MCP o entregava.
 */

require('../helpers/vscodeMock').install();

const assert = require('assert');
const {
    ArcadeDbHttpClient,
    ArcadeDbEmbeddedClient,
    createGraphClient,
    describeTools,
    isGraphTool,
    invokeGraphTool,
    normalizeNeo4jValue,
    translateNeo4jError,
    GraphQueryError
} = require('../../src/chat/graphClients');
const {
    BACKEND_ARCADEDB,
    BACKEND_ARCADEDB_EMBEDDED,
    BACKEND_NEO4J
} = require('../../src/chat/connectionProfiles');

/** Substitui `fetch` global, devolvendo o restaurador. */
function withFetch(handler) {
    const original = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
        calls.push({ url, options });
        return handler(url, options);
    };
    return { calls, restore: () => { global.fetch = original; } };
}

function jsonResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body)
    };
}

const PROFILE = {
    backend: BACKEND_ARCADEDB,
    uri: 'http://host:2480',
    user: 'leitor',
    password: 's3nh4'
};

describe('Seleção do cliente pelo backend', () => {
    it('cada backend tem o seu transporte', () => {
        assert.ok(createGraphClient({ backend: BACKEND_ARCADEDB, uri: 'http://h:2480' }));
        assert.ok(createGraphClient({ backend: BACKEND_NEO4J, uri: 'bolt://h:7687' }));
        assert.ok(createGraphClient({ backend: BACKEND_ARCADEDB_EMBEDDED, dbPath: 'D:/x' }));
    });

    it('backend desconhecido não produz cliente algum', () => {
        assert.strictEqual(createGraphClient({ backend: 'inventado' }), undefined);
        assert.strictEqual(createGraphClient(undefined), undefined);
    });
});

describe('Superfície de ferramentas apresentada ao modelo', () => {
    it('é somente leitura — não há ferramenta de escrita', () => {
        // Não é uma verificação que se possa esquecer de fazer: o conteúdo do
        // corpus é texto não confiável, e uma injeção indireta que convença o
        // modelo a escrever não deve encontrar a ferramenta disponível.
        const names = describeTools(BACKEND_ARCADEDB).map((t) => t.name);
        assert.ok(!names.some((n) => /insert|update|delete|create|drop|write/i.test(n)));
    });

    it('diz ao Neo4j que só há Cypher', () => {
        // Um modelo que mande SQL ao Neo4j gasta uma rodada inteira para
        // descobrir o erro; a linguagem entra na descrição por isso.
        const query = describeTools(BACKEND_NEO4J).find((t) => t.name.endsWith('_query'));
        assert.deepStrictEqual(query.inputSchema.properties.language.enum, ['cypher']);
    });

    it('o ArcadeDB aceita as duas linguagens', () => {
        const query = describeTools(BACKEND_ARCADEDB).find((t) => t.name.endsWith('_query'));
        assert.deepStrictEqual(query.inputSchema.properties.language.enum, ['cypher', 'sql']);
    });

    it('reconhece as próprias ferramentas sem capturar as de terceiros', () => {
        assert.ok(isGraphTool('synesis_graph_query'));
        // `gitnexus_query` está ativo neste próprio repositório: capturá-lo
        // faria o chat consultar o grafo de código no lugar do corpus.
        assert.ok(!isGraphTool('gitnexus_query'));
        assert.ok(!isGraphTool('mcp_arcadedb_query'));
    });
});

describe('ArcadeDB sobre HTTP', () => {
    it('autentica com Basic e consulta o endpoint do banco', async () => {
        const fake = withFetch(async () => jsonResponse({ result: [{ name: 'Concept' }] }));
        try {
            const client = new ArcadeDbHttpClient(PROFILE);
            const out = await client.query('face85', 'cypher', 'MATCH (n) RETURN n');

            assert.deepStrictEqual(out, { records: [{ name: 'Concept' }] });
            const call = fake.calls[0];
            assert.ok(call.url.includes('/api/v1/query/face85'));
            const decoded = Buffer.from(
                call.options.headers.Authorization.slice(6),
                'base64'
            ).toString('utf8');
            assert.strictEqual(decoded, 'leitor:s3nh4');
        } finally {
            fake.restore();
        }
    });

    it('traduz o schema para o shape que o resto do chat espera', async () => {
        // `describeProjectSchema` e o prompt de sistema leem `{types:[{name,
        // properties}]}`, que era o formato do MCP. Traduzir aqui é o que
        // manteve os dois intactos ao trocar de transporte.
        const fake = withFetch(async () =>
            jsonResponse({ result: [{ name: 'Concept', type: 'vertex', properties: ['name', 'topic'] }] })
        );
        try {
            const schema = await new ArcadeDbHttpClient(PROFILE).getSchema('face85');
            assert.strictEqual(schema.types[0].name, 'Concept');
            assert.deepStrictEqual(schema.types[0].properties, [{ name: 'name' }, { name: 'topic' }]);
        } finally {
            fake.restore();
        }
    });

    it('distingue credencial recusada de servidor fora do ar', async () => {
        // A distinção decide a orientação dada ao pesquisador: sem permissão,
        // re-exportar o projeto não resolve nada.
        let fake = withFetch(async () => jsonResponse({}, 403));
        try {
            await assert.rejects(
                () => new ArcadeDbHttpClient(PROFILE).listDatabases(),
                (error) => error.kind === 'forbidden' && /not authorized/i.test(error.message)
            );
        } finally {
            fake.restore();
        }

        fake = withFetch(async () => {
            throw Object.assign(new Error('fail'), { name: 'TypeError' });
        });
        try {
            await assert.rejects(
                () => new ArcadeDbHttpClient(PROFILE).listDatabases(),
                (error) => error.kind === 'unreachable'
            );
        } finally {
            fake.restore();
        }
    });

    it('tolera barra final na URI sem gerar caminho duplo', async () => {
        const fake = withFetch(async () => jsonResponse({ result: [] }));
        try {
            await new ArcadeDbHttpClient({ ...PROFILE, uri: 'http://host:2480/' }).listDatabases();
            assert.ok(!fake.calls[0].url.includes('//api'));
        } finally {
            fake.restore();
        }
    });
});

describe('Neo4j: normalização dos valores do driver', () => {
    const neo4j = {
        isInt: (v) => Boolean(v && v.__int),
        int: (n) => ({ __int: true, value: n })
    };
    const makeInt = (value, safe = true) => ({
        __int: true,
        inSafeRange: () => safe,
        toNumber: () => value,
        toString: () => String(value)
    });

    it('converte inteiros de 64 bits em número', () => {
        // Cruas, elas chegariam ao modelo como `{"low":42,"high":0}` e ele
        // relataria a contagem errada com toda a confiança.
        assert.strictEqual(normalizeNeo4jValue(makeInt(42), neo4j), 42);
    });

    it('acima do alcance seguro devolve string, não número errado', () => {
        assert.strictEqual(normalizeNeo4jValue(makeInt('9007199254740993', false), neo4j), '9007199254740993');
    });

    it('reduz nós às suas propriedades', () => {
        const node = { properties: { name: 'Governança', count: makeInt(7) } };
        assert.deepStrictEqual(normalizeNeo4jValue(node, neo4j), { name: 'Governança', count: 7 });
    });

    it('desce em arrays e objetos aninhados', () => {
        const value = { rows: [{ n: makeInt(1) }, { n: makeInt(2) }] };
        assert.deepStrictEqual(normalizeNeo4jValue(value, neo4j), { rows: [{ n: 1 }, { n: 2 }] });
    });
});

describe('Neo4j: classificação de erros', () => {
    it('credencial recusada vira a mesma categoria do ArcadeDB', () => {
        const error = translateNeo4jError(
            { code: 'Neo.ClientError.Security.Unauthorized', message: 'bad credentials' },
            'bolt://h:7687',
            'neo4j'
        );
        assert.strictEqual(error.kind, 'forbidden');
        // O texto é lido por `describeAccessFailure`, que decide entre
        // "re-exporte" e "troque a credencial".
        assert.ok(/not authorized/i.test(error.message));
    });

    it('servidor inacessível é distinguido de erro de consulta', () => {
        const error = translateNeo4jError({ code: 'ServiceUnavailable', message: '' }, 'bolt://h:7687', 'neo4j');
        assert.strictEqual(error.kind, 'unreachable');
    });

    it('banco inexistente tem categoria própria', () => {
        const error = translateNeo4jError({ code: 'Neo.ClientError.Database.DatabaseNotFound', message: '' }, 'u', 'n');
        assert.strictEqual(error.kind, 'missing');
        assert.ok(/does not exist/i.test(error.message));
    });
});

describe('ArcadeDB embutido', () => {
    it('explica por que não consulta, em vez de falhar sem motivo', async () => {
        // A engine embutida é Java e não roda dentro do VSCode. Dizer isso é o
        // que evita o pesquisador procurar um defeito que não existe.
        const client = new ArcadeDbEmbeddedClient({ dbPath: 'D:/ArcadeDB' });
        await assert.rejects(
            async () => client.query('x', 'cypher', 'MATCH (n) RETURN n'),
            (error) => error instanceof GraphQueryError && error.kind === 'unsupported'
        );
    });
});

describe('Formato do resultado — o contrato com o resto do chat', () => {
    it('devolve JSON como texto, igual ao que o MCP entregava', async () => {
        // `citationGuard`, `sourceAnchor` e a trilha leem o payload cru como
        // texto JSON. Devolver objeto estruturado quebraria os três em silêncio.
        const client = {
            query: async () => ({ records: [{ citation: 'trecho literal' }] })
        };
        const result = await invokeGraphTool(client, 'synesis_graph_query', {
            database: 'face85',
            query: 'MATCH (n) RETURN n'
        });

        const part = result.content[0];
        assert.strictEqual(typeof part.value, 'string');
        assert.deepStrictEqual(JSON.parse(part.value), { records: [{ citation: 'trecho literal' }] });
    });

    it('list_databases devolve o shape que o seletor de banco espera', async () => {
        const client = { listDatabases: async () => ['face85', 'factors'] };
        const result = await invokeGraphTool(client, 'synesis_graph_list_databases', {});
        assert.deepStrictEqual(JSON.parse(result.content[0].value), { databases: ['face85', 'factors'] });
    });

    it('ferramenta desconhecida falha em vez de devolver vazio', async () => {
        await assert.rejects(() => invokeGraphTool({}, 'synesis_graph_inventada', {}));
    });
});
