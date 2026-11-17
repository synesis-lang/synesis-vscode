/**
 * lexicalCapability.test.js — busca por palavra declarada pelo grafo (Etapa 6).
 *
 * O prompt mandava o modelo cortar o termo antes do primeiro caractere com
 * diacrítico, porque `CONTAINS 'psicologicos'` não encontra `psicológicos`. O
 * `synesis-graph` já resolvia isso com índice full-text e analyzer por idioma; o
 * chat não usava porque não sabia que os índices existiam — `get_schema` mostra
 * propriedades, não índices.
 */

const assert = require('assert');
const { setPromptLanguage, withPromptLanguage } = require('../../src/chat/promptLanguage');
const {
    renderLexicalCapability,
    indexName,
    foldsAccents
} = require('../../src/chat/lexicalCapability');

const COM_INDICE = {
    conceptLabel: 'Chain',
    fulltextConceptFields: 'search_name,ontology_description',
    fulltextItemFields: 'citation,description',
    fulltextSourceFields: 'title,abstract',
    fulltextAnalyzer: 'org.apache.lucene.analysis.br.BrazilianAnalyzer'
};

describe('Busca lexical — condicional', () => {
    // Este bloco confere o texto do prompt em português (projeto pt).
    before(() => setPromptLanguage('pt'));
    after(() => setPromptLanguage('en'));
    it('não instrui quando o grafo não declara índice', () => {
        // Grafo antigo, ou backend Neo4j — cuja sintaxe é
        // `db.index.fulltext.queryNodes`, não `SEARCH_INDEX`. Ensinar a forma
        // errada gastaria uma rodada com erro.
        assert.strictEqual(renderLexicalCapability({}), undefined);
        assert.strictEqual(renderLexicalCapability(undefined), undefined);
        assert.strictEqual(renderLexicalCapability({ conceptLabel: 'Chain' }), undefined);
    });

    it('instrui quando o ProjectContext declara os campos', () => {
        const text = renderLexicalCapability(COM_INDICE);
        assert.ok(text);
        assert.match(text, /SEARCH_INDEX/);
    });
});

describe('Busca lexical — o índice é endereçado pelo nome exato', () => {
    // Este bloco confere o texto do prompt em português (projeto pt).
    before(() => setPromptLanguage('pt'));
    after(() => setPromptLanguage('en'));
    it('monta o identificador composto que SEARCH_INDEX espera', () => {
        // Um índice composto é nomeado pela lista inteira de campos. Sem isso o
        // modelo tentaria `SEARCH_INDEX('Chain', ...)` e a consulta falharia.
        assert.strictEqual(
            indexName('Chain', 'search_name,ontology_description'),
            'Chain[search_name, ontology_description]'
        );
        assert.strictEqual(indexName('Item', ''), '');
    });

    it('mostra os três índices com o rótulo real do projeto', () => {
        const text = renderLexicalCapability({ ...COM_INDICE, conceptLabel: 'Code' });

        assert.match(text, /`Code\[search_name, ontology_description\]`/);
        assert.match(text, /`Item\[citation, description\]`/);
        assert.match(text, /`Source\[title, abstract\]`/);
    });

    it('dá a consulta pronta, em SQL', () => {
        const text = renderLexicalCapability(COM_INDICE);
        assert.match(text, /language: "sql"/);
        assert.match(text, /SEARCH_INDEX\('Chain\[search_name, ontology_description\]', 'termo'\)/);
    });

    it('usa o índice de Item quando não há índice de conceito', () => {
        const text = renderLexicalCapability({
            conceptLabel: 'Chain',
            fulltextItemFields: 'citation',
            fulltextAnalyzer: 'brazilian'
        });
        assert.match(text, /FROM Item WHERE SEARCH_INDEX\('Item\[citation\]'/);
    });
});

describe('Busca lexical — honestidade sobre o analyzer', () => {
    // Este bloco confere o texto do prompt em português (projeto pt).
    before(() => setPromptLanguage('pt'));
    after(() => setPromptLanguage('en'));
    it('anuncia dobra de acento quando o analyzer a faz', () => {
        const text = renderLexicalCapability(COM_INDICE);
        assert.match(text, /dobra acento e aplica stemming/i);
        assert.match(text, /não corte o termo à mão/i);
    });

    it('diz que StandardAnalyzer NÃO dobra acento', () => {
        // O padrão não faz stemming nem accent folding. Apresentar a busca como
        // insensível a acento aqui seria errado, e o modelo não tem outra forma
        // de descobrir — a diferença só aparece no resultado, quando já é tarde.
        const text = renderLexicalCapability({
            ...COM_INDICE,
            fulltextAnalyzer: 'org.apache.lucene.analysis.standard.StandardAnalyzer'
        });

        assert.match(text, /\*\*não\*\* dobra acento/i);
        assert.match(text, /prefixo sem\s+diacrítico/is);
    });

    it('classifica o analyzer pelo nome da classe', () => {
        assert.ok(foldsAccents('org.apache.lucene.analysis.br.BrazilianAnalyzer'));
        assert.ok(foldsAccents('english'));
        assert.ok(!foldsAccents('org.apache.lucene.analysis.standard.StandardAnalyzer'));
        assert.ok(!foldsAccents(''));
    });

    it('mantém CONTAINS como complementar, não como substituído', () => {
        // São coisas diferentes: `CONTAINS` casa parte de um nome exato,
        // `SEARCH_INDEX` busca palavra sobre texto.
        assert.match(renderLexicalCapability(COM_INDICE), /complementares/i);
    });
});
