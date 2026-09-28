/**
 * Cache das leituras de prefetch.
 *
 * Cada pergunta refazia `ProjectContext`, `get_schema` e a sondagem antes da
 * primeira palavra do modelo — ~280ms medidos contra o banco remoto, repetidos
 * integralmente na pergunta seguinte, e a saudação ainda refazia as duas
 * primeiras segundos antes.
 */

const assert = require('assert');
const {
    PrefetchCache,
    SLOT,
    mapWithConcurrency,
    PROBE_CONCURRENCY
} = require('../../src/chat/prefetchCache');

describe('PrefetchCache', () => {
    it('serve o valor guardado sem repetir a leitura', async () => {
        const cache = new PrefetchCache();
        let calls = 0;
        const read = () => {
            calls += 1;
            return Promise.resolve({ schema: 'x' });
        };

        await cache.resolve('db', SLOT.SCHEMA, read);
        const second = await cache.resolve('db', SLOT.SCHEMA, read);

        assert.strictEqual(calls, 1, 'a segunda pergunta não deve reconsultar o banco');
        assert.deepStrictEqual(second, { schema: 'x' });
    });

    it('nunca serve o contexto de OUTRO banco', async () => {
        // O defeito mais caro possível aqui: a resposta pareceria correta.
        const cache = new PrefetchCache();
        await cache.resolve('face85', SLOT.SCHEMA, () => Promise.resolve('A'));
        const outro = await cache.resolve('candidatos', SLOT.SCHEMA, () => Promise.resolve('B'));

        assert.strictEqual(outro, 'B');
    });

    it('nunca serve o contexto de outra CONEXÃO para o mesmo nome de banco', async () => {
        // Dois perfis apontando para bancos homônimos — um local e um remoto, o
        // caso normal de quem valida antes de publicar. Servir o schema de um
        // sob o outro produziria uma resposta plausível sobre o grafo errado.
        const cache = new PrefetchCache();
        await cache.resolve('local|candidatos', SLOT.SCHEMA, () => Promise.resolve('LOCAL'));
        const remoto = await cache.resolve('hostinger|candidatos', SLOT.SCHEMA, () =>
            Promise.resolve('REMOTO')
        );

        assert.strictEqual(remoto, 'REMOTO');
    });

    it('separa os slots — leve e full não se confundem', async () => {
        // Cacheá-los juntos faria toda pergunta seguinte carregar os ~28,7k
        // chars do `template_doc`, mesmo quando o turno não pediu por ele.
        const cache = new PrefetchCache();
        await cache.resolve('db', SLOT.CONTEXT, () => Promise.resolve('leve'));
        const full = await cache.resolve('db', SLOT.CONTEXT_FULL, () => Promise.resolve('completo'));

        assert.strictEqual(full, 'completo');
    });

    it('expira pelo TTL, para uma reexportação aparecer', async () => {
        let clock = 1000;
        const cache = new PrefetchCache({ ttlMs: 100, now: () => clock });
        let calls = 0;
        const read = () => {
            calls += 1;
            return Promise.resolve(calls);
        };

        await cache.resolve('db', SLOT.SCHEMA, read);
        clock += 101;
        await cache.resolve('db', SLOT.SCHEMA, read);

        assert.strictEqual(calls, 2, 'passado o TTL, a leitura precisa acontecer de novo');
    });

    it('não guarda undefined — falha transitória não congela pelo TTL', async () => {
        // Um banco sem `ProjectContext`, ou um servidor que recusou, devolve
        // `undefined`. Congelar isso deixaria o chat sem contexto por 10 min.
        const cache = new PrefetchCache();
        let calls = 0;
        const read = () => {
            calls += 1;
            return Promise.resolve(undefined);
        };

        await cache.resolve('db', SLOT.CONTEXT, read);
        await cache.resolve('db', SLOT.CONTEXT, read);

        assert.strictEqual(calls, 2);
        assert.strictEqual(cache.size, 0);
    });

    it('invalida só o banco pedido', async () => {
        const cache = new PrefetchCache();
        await cache.resolve('a', SLOT.SCHEMA, () => Promise.resolve(1));
        await cache.resolve('b', SLOT.SCHEMA, () => Promise.resolve(2));

        cache.invalidate('a');

        assert.strictEqual(cache.get('a', SLOT.SCHEMA), undefined);
        assert.strictEqual(cache.get('b', SLOT.SCHEMA), 2);
    });
});

describe('mapWithConcurrency', () => {
    it('preserva a ordem da entrada, não a de chegada', async () => {
        // A seção de prompt não pode mudar entre execuções porque o servidor
        // respondeu noutra ordem.
        const delays = [30, 5, 20, 1];
        const out = await mapWithConcurrency(delays, 4, (ms, i) =>
            new Promise((resolve) => setTimeout(() => resolve(i), ms))
        );

        assert.deepStrictEqual(out, [0, 1, 2, 3]);
    });

    it('respeita o teto de concorrência', async () => {
        let inFlight = 0;
        let peak = 0;
        await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight -= 1;
        });

        assert.ok(peak <= 3, `abriu ${peak} conexões simultâneas, esperado no máximo 3`);
    });

    it('lida com lista vazia', async () => {
        assert.deepStrictEqual(await mapWithConcurrency([], PROBE_CONCURRENCY, async () => 1), []);
    });
});
