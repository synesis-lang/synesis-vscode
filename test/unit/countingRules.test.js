/**
 * Contagem vem do banco, não da cabeça do modelo.
 *
 * Observado ao vivo (2026-08-24): perguntado pelos conceitos do tópico
 * "Finanças", o modelo navegou artigo por artigo e contou enquanto lia. Errou —
 * disse 8 artigos (são 9), `souza2022c: 6` (são 3), `correa2012: 8` (são 6).
 *
 * As citações estavam **todas corretas**; o juiz não acusou nada. O defeito é
 * específico: quantidade afirmada sem consulta que a produza.
 *
 * Por que importa além da precisão: a auditoria confere a resposta anterior. Se
 * contradiz números a cada turno, o pesquisador deixa de confiar nas duas — na
 * primeira porque erra, na auditoria porque discorda.
 */

const assert = require('assert');
const { setPromptLanguage, withPromptLanguage } = require('../../src/chat/promptLanguage');
const { SYSTEM_PROMPT, COUNTING_RULES } = require('../../src/chat/chatParticipant');
const { buildAuditPrompt } = require('../../src/chat/auditTrail');

describe('Contagem — nunca de cabeça', () => {
    it('exige que toda quantidade venha de count() no banco', () => {
        assert.match(COUNTING_RULES, /must come from a `count\(\)`/i);
    });

    it('proíbe afirmar número não consultado', () => {
        // A regra que ataca a causa direta: ele contou o que leu, em vez de
        // perguntar quanto era.
        assert.match(COUNTING_RULES, /did not run a query that produced the number/i);
    });

    it('explica o custo do erro, não só a regra', () => {
        // Sem o porquê a regra vira ritual. O custo real é a credibilidade das
        // partes corretas da resposta.
        assert.match(COUNTING_RULES, /discredits\s+the correct parts/i);
    });
});

describe('Contagem — agregar em vez de iterar', () => {
    it('manda agregar antes de repetir a consulta', () => {
        // Corrige custo E precisão: foi iterando que ele perdeu a conta.
        assert.match(COUNTING_RULES, /Aggregate instead of iterating/i);
    });

    it('dá a consulta agregada concreta', () => {
        // Verificada contra o face85: devolve os 9 artigos com as contagens
        // numa chamada, contra as ~15 que o modelo gastou.
        assert.ok(COUNTING_RULES.includes('count(DISTINCT c.name)'));
    });

    it('avisa que iterar gasta o orçamento de consultas', () => {
        assert.match(COUNTING_RULES, /wastes your query\s+budget/i);
    });

    it('explica quando usar count(DISTINCT)', () => {
        // Um bloco ITEM com N chains gera N vértices Item para o mesmo trecho;
        // `count()` simples infla. É o mesmo fato que motivou o agrupamento da
        // trilha de auditoria.
        assert.match(COUNTING_RULES, /several `Item` vertices for the same excerpt/i);
        assert.match(COUNTING_RULES, /inflates the number/i);
    });
});

describe('Contagem — auto-verificação antes de responder', () => {
    it('manda reler os próprios números antes de fechar', () => {
        assert.match(COUNTING_RULES, /Before finishing, re-read your own numbers/i);
    });

    it('exige confirmar a origem de cada quantidade', () => {
        assert.match(COUNTING_RULES, /came from a query result you actually received/i);
    });

    it('manda largar a afirmação em vez de estimar', () => {
        // A saída honesta quando o número não tem origem: não inventar um
        // plausível.
        assert.match(COUNTING_RULES, /drop the claim — do not estimate/i);
    });
});

describe('Contagem — integração', () => {
    // Este bloco confere o texto do prompt em português (projeto pt).
    before(() => setPromptLanguage('pt'));
    after(() => setPromptLanguage('en'));
    it('as regras entram no SYSTEM_PROMPT', () => {
        assert.ok(SYSTEM_PROMPT.includes(COUNTING_RULES));
    });

    it('não substituem as regras de citação', () => {
        // Regressão: são problemas distintos — citação forjada vs. contagem
        // errada. O turno que falhou tinha citações corretas.
        assert.match(SYSTEM_PROMPT, /Quote first, analyse second/i);
    });

    it('a auditoria também é instruída a agregar', () => {
        // A auditoria percorre TODAS as afirmações do turno anterior; verificar
        // uma a uma esgotou o teto de rodadas ao vivo.
        const prompt = buildAuditPrompt('pergunta', 'resposta');

        assert.match(prompt, /uma consulta agregada/i);
        assert.match(prompt, /esgota o orçamento/i);
    });
});

/**
 * Unidades tipadas e regra de divergência (Etapa 4).
 *
 * O defeito real: uma auditoria contou trechos, comparou com menções, e declarou
 * errada uma resposta correta — estando ela própria errada (11 contra 20). Uma
 * auditoria que contradiz sem estar certa é pior que não auditar, porque derruba
 * a confiança nas duas respostas.
 */
describe('Contagem — a unidade faz parte do número', () => {
    it('proíbe número sem unidade', () => {
        assert.match(SYSTEM_PROMPT, /Always name the unit/i);
        assert.match(SYSTEM_PROMPT, /Never write a bare number/i);
    });

    it('nomeia as cinco unidades com a expressão que as mede', () => {
        // Sem a expressão, "conte trechos" é uma instrução que o modelo cumpre
        // como quiser — e foi assim que trechos viraram itens.
        assert.match(SYSTEM_PROMPT, /sources.{0,60}count\(DISTINCT s\.bibtex\)/is);
        assert.match(SYSTEM_PROMPT, /annotated excerpts.{0,80}annotation_id/is);
        assert.match(SYSTEM_PROMPT, /analytical items.{0,80}item_id/is);
        assert.match(SYSTEM_PROMPT, /mentions.{0,80}MENTIONS/is);
        assert.match(SYSTEM_PROMPT, /concepts.{0,60}count\(DISTINCT c\.name\)/is);
    });

    it('diz que um trecho com quatro chains é quatro itens', () => {
        // O exemplo concreto vale mais que a regra: é a forma exata que produziu
        // o erro observado.
        assert.match(SYSTEM_PROMPT, /four chains is four items/i);
    });

    it('manda admitir a ausência em vez de substituir a unidade', () => {
        // Grafo anterior ao `annotation_id`: dizer "não dá para contar trechos"
        // é honesto; devolver a contagem de itens no lugar é o defeito.
        assert.match(SYSTEM_PROMPT, /no `annotation_id`.{0,120}rather than substituting/is);
    });
});

describe('Contagem — regra de divergência', () => {
    it('trata discordância como hipótese, não veredito', () => {
        assert.match(SYSTEM_PROMPT, /hypothesis, not a verdict/i);
    });

    it('manda comparar a unidade ANTES de acusar', () => {
        assert.match(SYSTEM_PROMPT, /whether\s+the two numbers use the SAME unit/is);
    });

    it('proíbe acusar com base em consulta reescrita', () => {
        // O mecanismo exato do erro: a auditoria escreveu outra consulta, mediu
        // outra coisa, e chamou a diferença de erro.
        assert.match(SYSTEM_PROMPT, /Never\s+announce that an earlier answer was wrong/is);
        assert.match(SYSTEM_PROMPT, /re-run\s+the original query/is);
    });
});

describe('Reavaliação — carrega as consultas originais', () => {
    // Este bloco confere o texto do prompt em português (projeto pt).
    before(() => setPromptLanguage('pt'));
    after(() => setPromptLanguage('en'));
    const { buildAuditPrompt, traceQueries } = require('../../src/chat/auditTrail');

    const TRACE = {
        toolCalls: [
            { prefetch: true, toolName: 'get_schema', input: { database: 'face85' }, status: 'ok' },
            {
                toolName: 'query',
                input: { query: 'MATCH (i:Item) RETURN count(i)', language: 'cypher' },
                status: 'ok'
            },
            { toolName: 'query', input: { query: 'MATCH (c) RETURN c' }, status: 'error' }
        ]
    };

    it('extrai só as consultas do modelo, sem prefetch nem falha', () => {
        assert.deepStrictEqual(traceQueries(TRACE), ['MATCH (i:Item) RETURN count(i)']);
        assert.deepStrictEqual(traceQueries(undefined), []);
    });

    it('põe as consultas no prompt da reavaliação', () => {
        // Sem elas, "refaça a mesma consulta" é uma instrução impossível de
        // cumprir — o modelo nunca viu a consulta original.
        const prompt = buildAuditPrompt('pergunta', 'resposta', traceQueries(TRACE));
        assert.match(prompt, /MATCH \(i:Item\) RETURN count\(i\)/);
        assert.match(prompt, /mesma unidade/i);
    });

    it('traz a regra de divergência com os três passos', () => {
        const prompt = buildAuditPrompt('pergunta', 'resposta', []);
        assert.match(prompt, /Regra de divergência/i);
        assert.match(prompt, /unidades forem diferentes.{0,60}não há divergência/is);
        assert.match(prompt, /hipótese até a unidade ser igualada/i);
    });

    it('omite a seção de consultas quando não há nenhuma', () => {
        const prompt = buildAuditPrompt('pergunta', 'resposta', []);
        assert.ok(!/Consultas que a resposta anterior executou/.test(prompt));
    });
});
