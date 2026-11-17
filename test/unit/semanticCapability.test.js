/**
 * O chat só oferece busca semântica quando o grafo declara tê-la.
 *
 * A capacidade vem do vértice `ProjectContext` (gravado pelo `synesis-graph`
 * quando o sync roda com `--vector-embeddings`), não da introspecção do schema:
 * um índice vetorial sobrevive a um re-sync sem vetores, então inferi-lo
 * anunciaria uma capacidade que o dado não tem.
 *
 * A instrução é condicional pela mesma razão que a de banco selecionado é:
 * mandar usar `vectorNeighbors` onde não há índice faz o modelo gastar rodadas
 * com erro — o defeito das "duas ordens contraditórias" que o prompt já teve.
 */

const assert = require('assert');
const { setPromptLanguage, withPromptLanguage } = require('../../src/chat/promptLanguage');
const {
    renderSemanticCapability,
    renderProjectContext
} = require('../../src/chat/chatParticipant');

describe('Busca semântica — quando a instrução entra no prompt', () => {
    // Este bloco confere o texto do prompt em português (projeto pt).
    before(() => setPromptLanguage('pt'));
    after(() => setPromptLanguage('en'));
    it('não entra em grafo sem vetores', () => {
        // Neo4j hoje, e qualquer grafo exportado sem --vector-embeddings.
        assert.strictEqual(renderSemanticCapability({ conceptLabel: 'Chain' }), undefined);
        assert.strictEqual(renderSemanticCapability({ embeddingFields: '' }), undefined);
        assert.strictEqual(renderSemanticCapability(undefined), undefined);
    });

    it('entra quando o grafo declara os campos embedados', () => {
        const text = renderSemanticCapability({
            conceptLabel: 'Chain',
            embeddingFields: 'ontology_description'
        });

        assert.ok(text);
        assert.match(text, /Busca semântica disponível/);
    });

    it('nomeia os campos de onde os vetores vieram', () => {
        // Muda o que a proximidade SIGNIFICA: por ontology_description é
        // semelhança conceitual, por topic é coocorrência temática.
        const text = renderSemanticCapability({
            conceptLabel: 'Chain',
            embeddingFields: 'ontology_description,topic'
        });

        assert.ok(text.includes('`ontology_description`'));
        assert.ok(text.includes('`topic`'));
    });

    it('usa o rótulo de conceito real do projeto', () => {
        // O rótulo varia por template; um índice fixo em `Chain` erraria em
        // todo projeto que usa CODE.
        const text = renderSemanticCapability({
            conceptLabel: 'Code',
            embeddingFields: 'ontology_description'
        });

        assert.ok(text.includes("'Code[embedding]'"));
        assert.ok(!text.includes('Chain[embedding]'));
    });
});

describe('Busca semântica — a consulta ensinada', () => {
    // Este bloco confere o texto do prompt em português (projeto pt).
    before(() => setPromptLanguage('pt'));
    after(() => setPromptLanguage('en'));
    const text = withPromptLanguage('pt', () => renderSemanticCapability({
        conceptLabel: 'Chain',
        embeddingFields: 'ontology_description'
    }));

    it('usa a forma LET, verificada contra o ArcadeDB real', () => {
        // O subselect inline falha com "Unsupported query vector type:
        // ResultInternal" (ArcadeDB 26.7.3). Ensinar a forma errada custaria
        // exatamente as rodadas de erro que esta etapa existe para evitar.
        assert.match(text, /LET \$v = \(SELECT embedding FROM Chain WHERE name/);
        assert.match(text, /expand\(vectorNeighbors\(/);
    });

    it('diz que é SQL, não Cypher', () => {
        // Todo o resto do prompt manda usar Cypher; sem esta ressalva o modelo
        // manda a consulta na linguagem errada.
        assert.match(text, /language: "sql"/);
    });

    it('explica a direção da distância', () => {
        assert.match(text, /menor = mais próximo/);
    });

    it('proíbe pedir a propriedade embedding', () => {
        // Centenas de floats na resposta são lixo para o pesquisador e
        // desperdício de contexto.
        assert.match(text, /\*\*Nunca\*\* peça a propriedade `embedding`/);
    });

    it('manda tentar a busca exata antes', () => {
        // Proximidade é o fallback, não o padrão: quando o nome exato existe,
        // a correspondência literal é a resposta melhor.
        assert.match(text, /CONTAINS/);
        assert.match(text, /Não substitui a busca exata/i);
    });
});

describe('Busca semântica — exato vs. aproximado', () => {
    // Este bloco confere o texto do prompt em português (projeto pt).
    before(() => setPromptLanguage('pt'));
    after(() => setPromptLanguage('en'));
    const text = withPromptLanguage('pt', () => renderSemanticCapability({
        conceptLabel: 'Chain',
        embeddingFields: 'ontology_description'
    }));

    it('exige marcar que o resultado é por proximidade', () => {
        // A quarta distinção de origem: sem ela uma vizinhança vetorial passa
        // por menção do corpus, e o pesquisador não sabe que foi inferida.
        assert.match(text, /por proximidade.{0,20}não por menção/s);
    });

    it('contrapõe menção (afirmação) a proximidade (inferência)', () => {
        assert.match(text, /afirmação sobre o corpus/i);
        assert.match(text, /inferência do modelo de/i);
    });

    it('chama o resultado aproximado de sugestão de leitura', () => {
        // Não é enfeite: em pesquisa qualitativa, dois conceitos próximos no
        // espaço vetorial não são equivalentes, e o pesquisador decide.
        assert.match(text, /sugestão de leitura/i);
    });

    it('não descarta o achado aproximado — apenas exige rótulo', () => {
        // O risco oposto ao da alucinação: um chat tímido demais esconderia
        // exatamente a recuperação que esta etapa destrava.
        assert.match(text, /continua sendo um achado útil/i);
    });
});

describe('Busca semântica — integração no contexto do projeto', () => {
    // Este bloco confere o texto do prompt em português (projeto pt).
    before(() => setPromptLanguage('pt'));
    after(() => setPromptLanguage('en'));
    it('a instrução acompanha o contexto quando há capacidade', () => {
        const rendered = renderProjectContext({
            description: 'Projeto X',
            conceptLabel: 'Chain',
            embeddingFields: 'ontology_description'
        });

        assert.match(rendered, /Busca semântica disponível/);
    });

    it('o contexto sem capacidade não menciona busca vetorial', () => {
        const rendered = renderProjectContext({
            description: 'Projeto X',
            conceptLabel: 'Chain'
        });

        assert.ok(!/vectorNeighbors/.test(rendered));
    });

    it('recusa de acesso não vira instrução de busca', () => {
        // `accessFailure` é diagnóstico para o pesquisador; não deve virar
        // prompt, com ou sem capacidade semântica.
        assert.strictEqual(
            renderProjectContext({ accessFailure: 'sem permissão', embeddingFields: 'x' }),
            undefined
        );
    });
});
