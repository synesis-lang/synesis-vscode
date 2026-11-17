/**
 * As métricas de rede que o grafo já traz.
 *
 * O `synesis-graph` roda PageRank, betweenness e Louvain no sync. Observado ao
 * vivo: perguntado pelos conceitos "mais centrais", o modelo contou arestas à
 * mão e devolveu um ranking de GRAU — porque as propriedades estavam gravadas
 * mas não declaradas no schema, e portanto invisíveis ao `get_schema`.
 *
 * No face85 os dois primeiros por grau não estão no top-5 por PageRank. Não é
 * diferença cosmética: grau conta vizinhos, PageRank pesa a importância deles.
 */

const assert = require('assert');
const { setPromptLanguage, withPromptLanguage } = require('../../src/chat/promptLanguage');
const { describeGraphMetrics } = require('../../src/chat/chatParticipant');

const COM_METRICAS = [
    {
        name: 'Chain',
        properties: [
            { name: 'name' },
            { name: 'pagerank' },
            { name: 'betweenness' },
            { name: 'community' },
            { name: 'degree' }
        ]
    }
];

describe('Métricas de rede — detecção', () => {
    // Este bloco confere o texto do prompt em português (projeto pt).
    before(() => setPromptLanguage('pt'));
    after(() => setPromptLanguage('en'));
    it('não instrui quando o grafo não tem métricas', () => {
        // Grafo gerado por versão anterior, ou backend que não as calcula.
        // Mandar usar `pagerank` onde ele não existe gastaria rodadas com erro.
        assert.strictEqual(
            describeGraphMetrics([{ name: 'Chain', properties: [{ name: 'name' }] }]),
            undefined
        );
        assert.strictEqual(describeGraphMetrics([]), undefined);
        assert.strictEqual(describeGraphMetrics(undefined), undefined);
    });

    it('instrui quando o schema real anuncia as métricas', () => {
        const text = describeGraphMetrics(COM_METRICAS);

        assert.ok(text);
        assert.match(text, /já calculadas/i);
    });

    it('detecta do schema, não presume', () => {
        // Só as que o schema traz entram na explicação: prometer `betweenness`
        // num grafo que só tem `pagerank` levaria a consulta a falhar.
        const soPagerank = [{ name: 'Chain', properties: [{ name: 'pagerank' }] }];
        const text = describeGraphMetrics(soPagerank);

        assert.ok(text.includes('pagerank'));
        assert.ok(!text.includes('`betweenness`'));
    });
});

describe('Métricas de rede — o que é ensinado', () => {
    // Este bloco confere o texto do prompt em português (projeto pt).
    before(() => setPromptLanguage('pt'));
    after(() => setPromptLanguage('en'));
    const text = withPromptLanguage('pt', () => describeGraphMetrics(COM_METRICAS));

    it('trata "mais central" como escolha de método, não como fato', () => {
        // CORREÇÃO (Etapa 2): o texto dizia que PageRank é "a resposta certa
        // para mais central". Centralidade é uma operacionalização — grau,
        // PageRank e betweenness respondem perguntas diferentes, e escolher
        // por conta do pesquisador é decidir o método dele.
        assert.match(text, /não tem resposta única/i);
        assert.ok(!/resposta certa/i.test(text));
    });

    it('declara o escopo sobre o qual as métricas foram calculadas', () => {
        // No ArcadeDB, `algo.*` roda sobre o grafo INTEIRO — conceitos, trechos,
        // referências e taxonomias — enquanto o GDS do Neo4j projeta só o
        // subgrafo de conceitos. Sem isto, o pesquisador lê o escore como se
        // fosse centralidade na rede de conceitos.
        assert.match(text, /grafo inteiro/i);
    });

    it('proíbe contar arestas à mão', () => {
        // O comportamento observado: 210 conceitos, arestas contadas uma a uma,
        // resultado diferente do que o banco já tinha pronto.
        assert.match(text, /não conte arestas à mão/i);
    });

    it('dá a consulta pronta com o rótulo real do projeto', () => {
        // O rótulo varia por template; fixar `Chain` erraria em projeto CODE.
        const comCode = [{ name: 'Code', properties: [{ name: 'pagerank' }] }];

        assert.match(describeGraphMetrics(comCode), /MATCH \(c:Code\)/);
        assert.match(text, /ORDER BY c\.pagerank DESC/);
    });

    it('exige declarar qual métrica foi usada', () => {
        // Grau e PageRank respondem perguntas diferentes; apresentar um como o
        // outro é o defeito que esta etapa corrige.
        assert.match(text, /diga qual métrica usou/i);
    });

    it('só oferece como sentido as métricas que este grafo tem', () => {
        // Mesma disciplina da detecção: prometer `betweenness` num grafo que só
        // calculou `pagerank` entrega uma consulta que falha.
        const soPagerank = describeGraphMetrics([
            { name: 'Chain', properties: [{ name: 'pagerank' }] }
        ]);
        assert.ok(!/betweenness/.test(soPagerank));
        assert.match(soPagerank, /pagerank/);
    });

    it('distingue o que cada métrica mede', () => {
        assert.match(text, /betweenness.{0,60}ponte/is);
        // O ID de comunidade é rótulo interno de UMA execução do Louvain, não
        // categoria estável entre sincronizações — dizer isso evita que o
        // pesquisador compare números de dois snapshots.
        assert.match(text, /community.{0,120}rótulo interno/is);
    });

    it('avisa para não recalcular', () => {
        assert.match(text, /não recalcule/i);
    });
});

/**
 * Escopo declarado pelo grafo (Etapa 7).
 *
 * `metrics_arcadedb.py` documenta que `algo.*` roda sobre o grafo INTEIRO —
 * conceitos, Items, Sources e taxonomias — enquanto o GDS do Neo4j projeta só o
 * subgrafo de conceitos. A ressalva existia no código do grafo e não chegava ao
 * chat, então o pesquisador lia um ranking sem saber o que ele inclui.
 */
describe('Métricas de rede — escopo declarado', () => {
    // Este bloco confere o texto do prompt em português (projeto pt).
    before(() => setPromptLanguage('pt'));
    after(() => setPromptLanguage('en'));
    const COM_PAGERANK = [{ name: 'Chain', properties: [{ name: 'pagerank' }] }];

    it('usa o escopo que o ProjectContext declara', () => {
        const text = describeGraphMetrics(COM_PAGERANK, {
            backend: 'neo4j',
            scope: 'concept_subgraph'
        });

        assert.match(text, /backend `neo4j`/);
        assert.match(text, /escopo `concept_subgraph`/);
    });

    it('mantém o aviso do grafo inteiro quando não há declaração', () => {
        // Grafo gerado antes da declaração não deixa de ter a propriedade; no
        // ArcadeDB, que é o único backend com métricas hoje, o escopo É o grafo
        // inteiro.
        assert.match(describeGraphMetrics(COM_PAGERANK), /grafo inteiro/i);
    });

    it('manda declarar o escopo ao apresentar um ranking', () => {
        const text = describeGraphMetrics(COM_PAGERANK, {
            backend: 'arcadedb',
            scope: 'whole_graph'
        });
        assert.match(text, /ao apresentar um ranking/i);
    });
});
