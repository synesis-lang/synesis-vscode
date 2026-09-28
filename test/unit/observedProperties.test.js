/**
 * Propriedades gravadas mas não declaradas.
 *
 * Observado ao vivo no `candidatos_quinto_andar` (ArcadeDB 26.9.1): o vértice
 * `Source` declara 19 propriedades, todas textuais, e `total_score` não está
 * entre elas — apesar de gravado como inteiro nos 3.027 vértices. Perguntado
 * qual candidato pontua mais, o modelo não via com o que ordenar.
 *
 * O segundo caso é pior porque falha DURO: `Item.score` está gravado como
 * texto, e `sum()` sobre ele devolve
 * `sum() requires numeric input, but received a value of type String`.
 */

const assert = require('assert');
const {
    collectObserved,
    describeType,
    renderObservedProperties,
    undeclaredFrom,
    unwrapNode,
    sampleSizeFor,
    SAMPLE_SIZE,
    EMBEDDING_SAMPLE_SIZE,
    classifyIdentity,
    identityCandidates,
    renderIdentityGuidance,
    rankingCandidates,
    renderRankingAmbiguity,
    dedupeAgainstTemplate
} = require('../../src/chat/observedProperties');

// Linha real do banco, reduzida. `total_score` é inteiro de verdade; o schema
// declarado do `Source` traz só os campos de texto.
const SOURCE_ROW = {
    '@rid': '#1:49152',
    '@type': 'Source',
    '@cat': 'v',
    bibtex: 'cand_01b11020',
    title: 'Paulo S.',
    total_score: 38,
    normalized_score: 45,
    coverage: 93
};

const SOURCE_DECLARED = ['bibtex', 'title'];

describe('Tipos observados', () => {
    it('distingue número de texto numérico', () => {
        // A distinção que decide se `sum()` funciona ou estoura.
        assert.strictEqual(describeType(38), 'número inteiro');
        assert.strictEqual(describeType(1.5), 'número decimal');
        assert.strictEqual(describeType('0'), 'texto numérico');
        assert.strictEqual(describeType('Paulo S.'), 'texto');
    });

    it('ignora nulo, para não fixar tipo de campo esparso', () => {
        // `Item.score` é nulo em 166.316 dos 249.735 Items: se o nulo fixasse o
        // tipo, a propriedade sumiria conforme a linha sorteada.
        assert.strictEqual(describeType(null), undefined);
        assert.strictEqual(describeType(undefined), undefined);
    });
});

describe('Coleta por amostragem', () => {
    it('descarta as chaves estruturais do vértice', () => {
        const observed = collectObserved([SOURCE_ROW]);

        assert.ok(!observed.has('@rid'));
        assert.ok(!observed.has('@type'));
        assert.strictEqual(observed.get('total_score'), 'número inteiro');
    });

    it('une chaves de linhas diferentes e mantém o primeiro tipo não nulo', () => {
        // Campo esparso: ausente na primeira linha, presente na segunda. Precisa
        // sobreviver — é exatamente a forma de `Item.score`.
        const observed = collectObserved([
            { item_id: 'a', score: null },
            { item_id: 'b', score: '3' }
        ]);

        assert.strictEqual(observed.get('score'), 'texto numérico');
    });
});

describe('Diferença contra o declarado', () => {
    it('devolve só o que o schema não anuncia', () => {
        const undeclared = undeclaredFrom(collectObserved([SOURCE_ROW]), SOURCE_DECLARED);
        const names = undeclared.map((e) => e.name);

        assert.deepStrictEqual(names, ['coverage', 'normalized_score', 'total_score']);
        assert.ok(!names.includes('title'), 'o já declarado não deve repetir no prompt');
    });

    it('não devolve nada quando o schema está completo', () => {
        // Banco em dia: nenhuma seção, nenhum custo de contexto.
        const observed = collectObserved([{ title: 'x', bibtex: 'y' }]);
        assert.deepStrictEqual(undeclaredFrom(observed, ['title', 'bibtex']), []);
    });

    it('omite o vetor de embedding', () => {
        // Centenas de floats não ajudam o modelo a consultar; a capacidade
        // semântica é anunciada por `renderSemanticCapability`.
        const observed = collectObserved([{ embedding: [0.1, 0.2], name: 'x' }]);
        const names = undeclaredFrom(observed, []).map((e) => e.name);

        assert.ok(!names.includes('embedding'));
        assert.ok(names.includes('name'));
    });

    it('ordena por nome, para o prompt não variar entre execuções', () => {
        const observed = collectObserved([{ zeta: 1, alpha: 2 }]);
        assert.deepStrictEqual(
            undeclaredFrom(observed, []).map((e) => e.name),
            ['alpha', 'zeta']
        );
    });
});

describe('Tamanho da amostra', () => {
    it('encolhe para uma linha quando o vértice tem embedding', () => {
        // Medido no `Chain` deste corpus: 384 floats por linha, 5,5 KB dos
        // 5,6 KB de uma linha — trafegados e descartados, porque só os nomes
        // das chaves interessam.
        const comEmbedding = { name: 'Chain', properties: [{ name: 'name' }, { name: 'embedding' }] };
        assert.strictEqual(sampleSizeFor(comEmbedding), EMBEDDING_SAMPLE_SIZE);
    });

    it('mantém a amostra cheia sem embedding', () => {
        // `Item.score` está ausente em dois terços das linhas: uma amostra só
        // poderia não vê-lo.
        const semEmbedding = { name: 'Item', properties: [{ name: 'item_id' }] };
        assert.strictEqual(sampleSizeFor(semEmbedding), SAMPLE_SIZE);
    });

    it('não quebra com vértice sem propriedades declaradas', () => {
        assert.strictEqual(sampleSizeFor({ name: 'X' }), SAMPLE_SIZE);
        assert.strictEqual(sampleSizeFor(undefined), SAMPLE_SIZE);
    });
});

describe('Extração do nó da linha de resultado', () => {
    it('aceita o nó na raiz da linha', () => {
        assert.strictEqual(unwrapNode(SOURCE_ROW).total_score, 38);
    });

    it('aceita o nó aninhado sob o alias', () => {
        // `RETURN n` pode chegar embrulhado conforme o transporte; depender de
        // uma única forma amarraria a sondagem a um servidor específico.
        assert.strictEqual(unwrapNode({ n: SOURCE_ROW }).total_score, 38);
    });

    it('não quebra com linha vazia', () => {
        assert.strictEqual(unwrapNode(null), undefined);
        assert.strictEqual(unwrapNode('texto'), undefined);
    });
});

describe('Seção de prompt', () => {
    it('não gera seção quando não há nada a acrescentar', () => {
        assert.strictEqual(renderObservedProperties([]), '');
        assert.strictEqual(renderObservedProperties([{ label: 'Source', undeclared: [] }]), '');
    });

    it('anuncia a propriedade não declarada com seu tipo', () => {
        const text = renderObservedProperties([
            { label: 'Source', undeclared: [{ name: 'total_score', type: 'número inteiro' }] }
        ]);

        assert.match(text, /total_score/);
        assert.match(text, /número inteiro/);
        assert.match(text, /consultáveis normalmente/i);
    });

    it('avisa que a amostra não prova cobertura total', () => {
        // Cinco linhas não autorizam afirmar que todo vértice tem o campo.
        const text = renderObservedProperties([
            { label: 'Item', undeclared: [{ name: 'score_band', type: 'texto' }] }
        ]);

        assert.match(text, /amostra/i);
    });

    it('adverte sobre número gravado como texto', () => {
        // O caso que falha duro: `sum()` recusa texto, `ORDER BY` ordena "9"
        // depois de "38".
        const text = renderObservedProperties([
            { label: 'Item', undeclared: [{ name: 'score', type: 'texto numérico' }] }
        ]);

        assert.match(text, /Item\.score/);
        assert.match(text, /sum\(\)/);
        assert.match(text, /toInteger/);
    });

    it('não adverte quando nenhum campo é texto numérico', () => {
        const text = renderObservedProperties([
            { label: 'Source', undeclared: [{ name: 'total_score', type: 'número inteiro' }] }
        ]);

        assert.ok(!/sum\(\)/.test(text), 'aviso de texto numérico não deve aparecer sem causa');
    });
});

describe('Chave de agrupamento (A2)', () => {
    // Medido no corpus real: 3.027 Sources, 3.027 bibtex distintos, 2.997
    // títulos. "Lucas Vieira" são três pessoas — agrupar por título somava os
    // trechos das três e produzia um score que não existe.
    const CONTAGENS = { bibtex: 3027, candidate_key: 3027, title: 2997 };

    it('separa o que identifica do que funde', () => {
        const id = classifyIdentity(3027, CONTAGENS);

        assert.deepStrictEqual(id.unique, ['bibtex', 'candidate_key']);
        assert.strictEqual(id.ambiguous.length, 1);
        assert.strictEqual(id.ambiguous[0].name, 'title');
        assert.strictEqual(id.ambiguous[0].collisions, 30);
    });

    it('avisa nomeando a chave única e o campo que repete', () => {
        const text = renderIdentityGuidance('Source', classifyIdentity(3027, CONTAGENS));

        assert.match(text, /bibtex/);
        assert.match(text, /title/);
        assert.match(text, /sem erro visível/i);
    });

    it('cala quando todo campo identifica', () => {
        // Corpus sem homônimo: o aviso seria ruído.
        const text = renderIdentityGuidance('Source', classifyIdentity(10, { bibtex: 10 }));
        assert.strictEqual(text, '');
    });

    it('cala quando não há chave única a recomendar', () => {
        // Avisar sem oferecer alternativa deixaria o modelo sem saída.
        const text = renderIdentityGuidance('X', classifyIdentity(10, { a: 5, b: 7 }));
        assert.strictEqual(text, '');
    });

    it('só considera campos textuais como identificador', () => {
        const observed = new Map([
            ['title', 'texto'],
            ['total_score', 'número inteiro']
        ]);
        const cands = identityCandidates(observed, []);

        assert.ok(cands.includes('title'));
        assert.ok(!cands.includes('total_score'), 'agrupar por número não é identificar');
    });
});

describe('Ambiguidade de ranking (A1)', () => {
    const CAMPOS = [
        { name: 'total_score', type: 'número inteiro' },
        { name: 'normalized_score', type: 'número inteiro' },
        { name: 'item_count', type: 'número inteiro' },
        { name: 'title', type: 'texto' }
    ];

    it('ignora contagens e campos de serviço', () => {
        const c = rankingCandidates(CAMPOS);

        assert.deepStrictEqual(c, ['normalized_score', 'total_score']);
        assert.ok(!c.includes('item_count'), 'volume não é pontuação');
        assert.ok(!c.includes('title'), 'texto não ordena ranking');
    });

    it('avisa sem eleger um critério', () => {
        // Medido: os dois campos dão ordens diferentes. Escolher por conta do
        // pesquisador é decidir o método dele — a mesma lição de METRIC_HINTS.
        const text = renderRankingAmbiguity('Source', CAMPOS);

        assert.match(text, /total_score/);
        assert.match(text, /normalized_score/);
        assert.match(text, /não escolha por conta própria/i);
    });

    it('cala com um só candidato', () => {
        const um = [{ name: 'total_score', type: 'número inteiro' }];
        assert.strictEqual(renderRankingAmbiguity('Source', um), '');
    });
});

describe('Desduplicação contra o template_doc (R1)', () => {
    const ENTRADA = [
        {
            label: 'Source',
            undeclared: [
                { name: 'total_score', type: 'número inteiro' },
                { name: 'campo_novo', type: 'texto' }
            ]
        }
    ];

    it('remove o nome que o template já cita', () => {
        const doc = 'opcionais `total_score`, `coverage`';
        const out = dedupeAgainstTemplate(ENTRADA, doc);

        const nomes = out[0].undeclared.map((e) => e.name);
        assert.deepStrictEqual(nomes, ['campo_novo']);
    });

    it('MANTÉM o texto numérico mesmo citado pelo template', () => {
        // O template lista nomes, não tipos: ele não diz que `score` é texto,
        // e é isso que faz `sum()` estourar.
        const entrada = [{ label: 'Item', undeclared: [{ name: 'score', type: 'texto numérico' }] }];
        const out = dedupeAgainstTemplate(entrada, 'opcionais `score`, `criterion`');

        assert.strictEqual(out[0].undeclared.length, 1);
    });

    it('sem template_doc não remove nada', () => {
        assert.deepStrictEqual(dedupeAgainstTemplate(ENTRADA, undefined), ENTRADA);
    });
});

describe('Ruído que a verificação ao vivo revelou', () => {
    it('não trata categoria de baixa cardinalidade como chave quase-única', () => {
        // `evaluation_origin`: 2 valores em 249.735 linhas. Ninguém o confunde
        // com identificador — avisar sobre ele afoga o aviso que importa.
        const id = classifyIdentity(249735, { item_id: 249735, evaluation_origin: 2 });

        assert.deepStrictEqual(id.unique, ['item_id']);
        assert.strictEqual(id.ambiguous.length, 0);
    });

    it('mantém o quase-único, que é a armadilha real', () => {
        // `title`: 2.997/3.027 = 99%. Parece identificar e falha na margem —
        // as 30 colisões fundem pessoas diferentes em silêncio.
        const id = classifyIdentity(3027, { bibtex: 3027, title: 2997 });

        assert.strictEqual(id.ambiguous.length, 1);
        assert.strictEqual(id.ambiguous[0].name, 'title');
    });

    it('não propõe prosa como identificador', () => {
        // `abstract` tinha 0 valores distintos e era anunciado como campo que
        // "repete entre vértices distintos".
        const observed = new Map([
            ['abstract', 'texto'],
            ['citation', 'texto'],
            ['bibtex', 'texto']
        ]);

        assert.deepStrictEqual(identityCandidates(observed, []), ['bibtex']);
    });

    it('não toma campo numérico como candidato a chave', () => {
        // `community`, `degree` e `in_degree` foram anunciados como candidatos a
        // identificador de `Chain` porque a função lia os nomes declarados em
        // vez do tipo observado.
        const observed = new Map([
            ['name', 'texto'],
            ['community', 'número inteiro'],
            ['in_degree', 'número inteiro']
        ]);

        assert.deepStrictEqual(identityCandidates(observed, ['community', 'in_degree']), ['name']);
    });

    it('não chama seguidores e headcount de campo de pontuação', () => {
        // O aviso listava dez campos do `Source`, incluindo `followers` e
        // `company_headcount`. Um aviso que lista tudo não orienta nada.
        const entries = [
            { name: 'total_score', type: 'número inteiro' },
            { name: 'normalized_score', type: 'número inteiro' },
            { name: 'followers', type: 'número inteiro' },
            { name: 'connections', type: 'número inteiro' },
            { name: 'company_headcount', type: 'número inteiro' }
        ];

        assert.deepStrictEqual(rankingCandidates(entries), ['normalized_score', 'total_score']);
    });

    it('deixa as métricas de rede para METRIC_HINTS', () => {
        // `pagerank`/`betweenness`/`degree` já têm explicação própria; repetir
        // aqui criaria dois avisos concorrentes sobre a mesma escolha.
        const entries = [
            { name: 'pagerank', type: 'número decimal' },
            { name: 'betweenness', type: 'número decimal' },
            { name: 'degree', type: 'número inteiro' }
        ];

        assert.deepStrictEqual(rankingCandidates(entries), []);
    });
});
