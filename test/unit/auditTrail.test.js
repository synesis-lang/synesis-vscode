/**
 * Trilha de auditoria sob demanda.
 *
 * A resposta mostra o trecho e a referência; o arquivo e a linha ficam atrás de
 * um clique. O rodapé fixo em toda resposta foi descartado por uma razão que os
 * testes preservam: o que sempre aparece deixa de ser lido.
 *
 * O agrupamento por origem é o requisito que veio da verificação da Etapa A
 * contra dado real — um bloco ITEM com N chains gera N vértices Item, todos com
 * a mesma citação.
 */

const assert = require('assert');
const { setPromptLanguage, withPromptLanguage } = require('../../src/chat/promptLanguage');
const {
    groupByOrigin,
    renderAuditTrail,
    renderTurnReport,
    buildAuditPrompt
} = require('../../src/chat/auditTrail');

const ASHWORTH = {
    item_id: 'ashworth2019_item0001_n0001',
    citation: 'male respondents were more likely to support CCS',
    source_file: 'social_acceptance.syn',
    source_line: 8,
    bibtex: 'ashworth2019',
    year: '2019'
};

describe('Trilha — agrupamento por origem', () => {
    it('colapsa os N Item do mesmo bloco em uma entrada', () => {
        // O caso real: uma consulta devolveu o trecho de ashworth2019 quatro
        // vezes — mesma linha 8, item_id diferente (_n0001.._n0004).
        const records = [1, 2, 3, 4].map((n) => ({
            ...ASHWORTH,
            item_id: `ashworth2019_item0001_n000${n}`
        }));
        const groups = groupByOrigin(records);

        assert.strictEqual(groups.length, 1);
        assert.strictEqual(groups[0].count, 4);
    });

    it('preserva todos os item_id da origem agrupada', () => {
        // O agrupamento é de APRESENTAÇÃO: a âncora individual continua
        // disponível para quem precisar dela.
        const records = [1, 2].map((n) => ({ ...ASHWORTH, item_id: `id_${n}` }));
        assert.deepStrictEqual(groupByOrigin(records)[0].itemIds, ['id_1', 'id_2']);
    });

    it('mantém separadas origens de linhas diferentes', () => {
        const groups = groupByOrigin([ASHWORTH, { ...ASHWORTH, source_line: 29 }]);
        assert.strictEqual(groups.length, 2);
    });

    it('mantém separadas origens de arquivos diferentes na mesma linha', () => {
        const groups = groupByOrigin([ASHWORTH, { ...ASHWORTH, source_file: 'outro.syn' }]);
        assert.strictEqual(groups.length, 2);
    });

    it('agrupa por citação quando o grafo não tem a origem', () => {
        // Grafo anterior à Etapa A: sem source_file, a citação ainda identifica
        // o trecho. Perder a entrada seria pior que agrupar de forma imperfeita.
        const semOrigem = { citation: 'um trecho qualquer', bibtex: 'x2020' };
        const groups = groupByOrigin([semOrigem, { ...semOrigem }]);

        assert.strictEqual(groups.length, 1);
        assert.strictEqual(groups[0].count, 2);
    });

    it('tolera entrada vazia ou com nulos', () => {
        assert.deepStrictEqual(groupByOrigin([]), []);
        assert.deepStrictEqual(groupByOrigin(undefined), []);
        assert.deepStrictEqual(groupByOrigin([null]), []);
    });
});

describe('Trilha — renderização', () => {
    it('mostra o trecho literal e a referência', () => {
        const text = renderAuditTrail(groupByOrigin([ASHWORTH]));

        assert.ok(text.includes('male respondents were more likely to support CCS'));
        assert.ok(text.includes('ashworth2019'));
        assert.ok(text.includes('2019'));
    });

    it('mostra arquivo e linha da anotação', () => {
        // É o que a resposta principal NÃO mostra — o motivo de a trilha existir.
        const text = renderAuditTrail(groupByOrigin([ASHWORTH]));

        assert.ok(text.includes('social_acceptance.syn'));
        assert.ok(text.includes('line 8'));
    });

    it('informa quantas relações saíram do mesmo trecho', () => {
        const records = [1, 2, 3].map((n) => ({ ...ASHWORTH, item_id: `id_${n}` }));
        assert.match(renderAuditTrail(groupByOrigin(records)), /3 relations/);
    });

    it('não diz "1 relação" quando há apenas uma', () => {
        // Ruído: a entrada única já é a informação.
        assert.ok(!/1 relation/.test(renderAuditTrail(groupByOrigin([ASHWORTH]))));
    });

    it('explica a ausência em vez de mostrar trilha vazia', () => {
        // Resposta vinda do template ou da estrutura do grafo não tem trecho a
        // auditar; dizer isso é melhor que uma seção em branco.
        const text = renderAuditTrail([]);

        assert.match(text, /template/i);
        assert.match(text, /graph structure/i);
    });

    it('lembra que o trecho foi anotado pelo pesquisador', () => {
        // A diferença para um RAG genérico: a origem é dado, não recuperação
        // por similaridade.
        assert.match(renderAuditTrail(groupByOrigin([ASHWORTH])), /annotated by the researcher/i);
    });
});

describe('Trilha — prompt de auditoria', () => {
    // Este bloco confere o texto do prompt em português (projeto pt).
    before(() => setPromptLanguage('pt'));
    after(() => setPromptLanguage('en'));
    const prompt = withPromptLanguage('pt', () => buildAuditPrompt('Que trechos falam de X?', 'Resposta anterior citando Y.'));

    it('carrega a pergunta e a resposta do turno', () => {
        assert.ok(prompt.includes('Que trechos falam de X?'));
        assert.ok(prompt.includes('Resposta anterior citando Y.'));
    });

    it('proíbe reinterpretar a análise', () => {
        // A auditoria levanta evidência; refazer a análise produziria uma
        // segunda resposta, não uma verificação da primeira.
        assert.match(prompt, /Não reinterprete/i);
    });

    it('pede as propriedades de proveniência, inclusive arquivo e linha', () => {
        for (const prop of ['i.citation', 'i.source_file', 'i.source_line', 'i.item_id', 's.bibtex']) {
            assert.ok(prompt.includes(prop), `faltou ${prop}`);
        }
    });

    it('exige declarar afirmação sem lastro', () => {
        // A informação mais importante da auditoria é a que falta.
        assert.match(prompt, /não.{0,20}tiver trecho que a sustente/is);
        assert.match(prompt, /mais importante desta auditoria/i);
    });

    it('pede o conceito-semente quando houve busca semântica', () => {
        // Sem a semente, o pesquisador não consegue refazer o caminho da
        // proximidade — a trilha ficaria incompleta justamente onde a
        // inferência entrou.
        assert.match(prompt, /conceito-semente/i);
    });
});

/**
 * O relatório determinístico do turno (Etapa 1).
 *
 * O que estes testes fixam é a promessa central da etapa: **clicar não chama
 * LLM e não consulta o banco**. Tudo o que o relatório mostra sai do trace
 * capturado durante a resposta.
 */
describe('Trilha — relatório determinístico do turno', () => {
    const trace = {
        turnId: 'turn-3',
        question: 'Quais conceitos aparecem em avelar2016?',
        database: 'face85',
        model: { id: 'claude-x', name: 'Claude Opus', vendor: 'anthropic', version: '5' },
        startedAt: '2026-08-25T10:00:00.000Z',
        modelRequests: 2,
        finalAnswer: 'resposta',
        incomplete: false,
        toolCalls: [
            {
                round: null,
                toolName: 'mcp_arcadedb_get_schema',
                input: { database: 'face85' },
                prefetch: true,
                status: 'ok',
                texts: ['{"types":[]}']
            },
            {
                round: 1,
                toolName: 'mcp_arcadedb_query',
                input: {
                    database: 'face85',
                    language: 'cypher',
                    query: 'MATCH (i:Item) RETURN i.citation'
                },
                status: 'ok',
                texts: ['{"records":[{"citation":"x"}]}']
            }
        ]
    };

    it('registra banco, modelo e horário — sem eles não há comparação', () => {
        const text = renderTurnReport(trace);
        assert.match(text, /face85/);
        assert.match(text, /Claude Opus/);
        assert.match(text, /anthropic/);
        assert.match(text, /2026-08-25/);
    });

    it('mostra a query executada, na linguagem em que foi executada', () => {
        const text = renderTurnReport(trace);
        assert.match(text, /MATCH \(i:Item\) RETURN i\.citation/);
        assert.match(text, /```cypher/);
    });

    it('separa o que a extensão consultou do que o modelo pediu', () => {
        // O prefetch custa consulta real e ficava fora de qualquer
        // contabilidade; marcá-lo mantém o custo honesto.
        const text = renderTurnReport(trace);
        assert.match(text, /extension/);
        assert.match(text, /model, round 1/);
    });

    it('conta as linhas retornadas, distinguindo vazio de não consultado', () => {
        const empty = {
            ...trace,
            toolCalls: [
                {
                    round: 1,
                    toolName: 'q',
                    input: { query: 'MATCH (x) RETURN x', language: 'cypher' },
                    status: 'ok',
                    texts: ['{"records":[]}']
                }
            ]
        };
        assert.match(renderTurnReport(empty), /No results/i);
        assert.match(renderTurnReport(trace), /1 row\(s\) returned/);
    });

    it('mostra a falha da ferramenta em vez de escondê-la', () => {
        const failed = {
            ...trace,
            toolCalls: [{ round: 1, toolName: 'q', status: 'error', error: 'not authorized' }]
        };
        assert.match(renderTurnReport(failed), /not authorized/);
    });

    it('avisa quando o teto de rodadas cortou o turno', () => {
        assert.match(renderTurnReport({ ...trace, incomplete: true }), /incomplete/i);
    });

    it('degrada com aviso quando o trace saiu do store', () => {
        assert.match(renderTurnReport(undefined), /no record/i);
    });

    it('não inventa consulta quando não houve nenhuma', () => {
        const text = renderTurnReport({ ...trace, toolCalls: [] });
        assert.match(text, /No query/i);
    });
});

describe('Trilha — raciocínio intermediário separado da resposta', () => {
    it('mostra o texto entre consultas, rotulado como não verificado', () => {
        // Etapa 3: essa prosa era emitida como se fosse resposta e entrava em
        // `answerText`, contaminando o juiz e as métricas. Agora fica só aqui,
        // onde explica o percurso.
        const text = renderTurnReport({
            turnId: 't', question: 'q', modelRequests: 2, toolCalls: [],
            intermediateText: [{ round: 1, text: 'Vou verificar quantos itens existem.' }]
        });

        assert.match(text, /Reasoning between queries/i);
        assert.match(text, /Vou verificar quantos itens existem/);
        assert.match(text, /was not verified/i);
    });

    it('omite a seção quando não houve raciocínio intermediário', () => {
        const text = renderTurnReport({
            turnId: 't', question: 'q', modelRequests: 1, toolCalls: [], intermediateText: []
        });
        assert.ok(!/Reasoning between queries/i.test(text));
    });

    it('tolera trace antigo, sem o campo', () => {
        const text = renderTurnReport({ turnId: 't', question: 'q', modelRequests: 1, toolCalls: [] });
        assert.ok(!/Reasoning between queries/i.test(text));
    });
});
