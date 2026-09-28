/**
 * Argumento obrigatório ausente numa chamada de ferramenta.
 *
 * **O caso real.** Com `liquid/lfm-2.5-2.6b:free` (2,6B, via OpenRouter) o
 * modelo chamou `synesis_graph_query` sem preencher `query`. O valor descia até
 * o cliente HTTP como `undefined`, `JSON.stringify` descartava a chave, e o
 * ArcadeDB respondia:
 *
 *     HTTP 400 — {"exception":"java.lang.IllegalArgumentException",
 *                 "detail":"command missing"}
 *
 * O modelo não tinha como se corrigir: o erro falava de `command`, que é o campo
 * do protocolo HTTP, enquanto o contrato que ele conhece declara `query`. Errou
 * duas vezes seguidas, idênticas.
 *
 * A validação troca isso por uma frase que nomeia o parâmetro do contrato do
 * modelo — e falha ANTES da rede, em vez de gastar uma ida ao servidor.
 */

require('../helpers/vscodeMock').install();

const assert = require('assert');
const { invokeGraphTool } = require('../../src/chat/graphClients');

/** Cliente que acusa se a validação deixar passar. */
function clientEspiao() {
    const chamadas = [];
    return {
        chamadas,
        query: async (...args) => {
            chamadas.push(['query', args]);
            return { records: [] };
        },
        getSchema: async (...args) => {
            chamadas.push(['getSchema', args]);
            return { types: [] };
        }
    };
}

describe('Chamada de ferramenta sem argumento obrigatório', () => {
    it('não vai à rede quando `query` falta — o caso do modelo pequeno', async () => {
        const client = clientEspiao();

        await assert.rejects(
            () =>
                invokeGraphTool(client, 'synesis_graph_query', {
                    database: 'candidatos_quinto_andar',
                    language: 'cypher'
                }),
            /query/
        );
        assert.strictEqual(client.chamadas.length, 0, 'a requisição não deve sair');
    });

    it('a mensagem nomeia o parâmetro que o MODELO conhece', async () => {
        // `command` é o campo HTTP; o modelo declara `query`. Falar do campo
        // errado é o que impedia a correção na rodada seguinte.
        const client = clientEspiao();
        const erro = await invokeGraphTool(client, 'synesis_graph_query', { database: 'db' }).catch(
            (e) => e
        );

        assert.match(erro.message, /`query`/);
        assert.ok(!/command/.test(erro.message), 'não deve citar o campo do protocolo HTTP');
        assert.match(erro.message, /Repita a chamada/i, 'precisa dizer o que fazer');
    });

    it('distingue parâmetro ausente de parâmetro vazio', async () => {
        const client = clientEspiao();

        const ausente = await invokeGraphTool(client, 'synesis_graph_query', {
            database: 'db'
        }).catch((e) => e);
        const vazio = await invokeGraphTool(client, 'synesis_graph_query', {
            database: 'db',
            query: '   '
        }).catch((e) => e);

        assert.match(ausente.message, /veio sem o parâmetro/);
        assert.match(vazio.message, /mas vazio/);
    });

    it('lista os DEMAIS parâmetros, não o que está faltando', async () => {
        // Dizer "recebi apenas: database, query" quando `query` é justamente o
        // campo em branco confundiria em vez de orientar.
        const client = clientEspiao();
        const erro = await invokeGraphTool(client, 'synesis_graph_query', {
            database: 'db',
            query: ''
        }).catch((e) => e);

        // Isola a lista de "demais parâmetros": um `.*` solto atravessaria a
        // frase inteira e casaria o `query` da instrução final, que é legítimo.
        const lista = erro.message.match(/Os demais parâmetros vieram: ([^.]*)\./)[1];

        assert.match(lista, /`database`/);
        assert.ok(!lista.includes('`query`'), 'o campo faltante não deve aparecer como informado');
    });

    it('vale também para `get_schema`', async () => {
        const client = clientEspiao();

        await assert.rejects(
            () => invokeGraphTool(client, 'synesis_graph_get_schema', {}),
            /database/
        );
        assert.strictEqual(client.chamadas.length, 0);
    });

    it('marca o erro como `bad_arguments`', async () => {
        // O tipo distingue "o modelo errou a chamada" de "o servidor recusou" —
        // são diagnósticos opostos para quem lê a trilha do turno.
        const client = clientEspiao();
        const erro = await invokeGraphTool(client, 'synesis_graph_query', {}).catch((e) => e);

        assert.strictEqual(erro.kind, 'bad_arguments');
    });
});

describe('Chamada bem formada continua passando', () => {
    it('query completa chega ao cliente com os argumentos certos', async () => {
        const client = clientEspiao();

        await invokeGraphTool(client, 'synesis_graph_query', {
            database: 'candidatos_quinto_andar',
            language: 'cypher',
            query: 'MATCH (s:Source) RETURN count(s)'
        });

        assert.deepStrictEqual(client.chamadas[0], [
            'query',
            ['candidatos_quinto_andar', 'cypher', 'MATCH (s:Source) RETURN count(s)']
        ]);
    });

    it('`language` continua opcional — o cliente aplica o padrão', async () => {
        const client = clientEspiao();

        await invokeGraphTool(client, 'synesis_graph_query', {
            database: 'db',
            query: 'MATCH (n) RETURN n'
        });

        assert.strictEqual(client.chamadas[0][1][1], undefined);
    });
});
