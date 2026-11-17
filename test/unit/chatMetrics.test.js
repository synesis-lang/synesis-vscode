/**
 * Métricas sem juiz LLM.
 *
 * Servem a uma pergunta concreta: *este modelo é confiável para o meu corpus?*
 * A objeção usual às métricas de RAG é que exigiriam um gabarito que ninguém
 * tem — estas não exigem: são aritmética sobre o que o turno já produziu.
 *
 * O que elas NÃO medem, e os testes preservam: se a resposta é útil. Uma
 * resposta que só repete citações literais pontua alto e ajuda pouco.
 */

const assert = require('assert');
const {
    looksLikeAbstention,
    measureTurn,
    summarize,
    renderReport,
    TRAP_QUESTIONS
} = require('../../src/chat/chatMetrics');

const PAYLOAD = JSON.stringify({
    records: [{ citation: 'o trabalho uberizado constitui-se como parte associada às configurações' }]
});

describe('Métricas — abstenção', () => {
    it('reconhece a recusa no formato ensinado pelo prompt', () => {
        assert.ok(
            looksLikeAbstention(
                'O corpus não tem trechos anotados que sustentem uma afirmação sobre este tema.'
            )
        );
    });

    it('reconhece variações de recusa', () => {
        assert.ok(looksLikeAbstention('Não encontrei trechos sobre isso.'));
        assert.ok(looksLikeAbstention('Esse assunto está fora do escopo deste corpus.'));
    });

    it('não confunde resposta afirmativa com recusa', () => {
        assert.ok(!looksLikeAbstention('O corpus traz quatro trechos sobre uberismo.'));
    });

    it('reconhece a recusa em inglês', () => {
        // O `social_acceptance` é um corpus em inglês. Uma lista só em português
        // contava 0 recusas ali — número errado com aparência de medição, que é
        // pior que métrica ausente.
        assert.ok(looksLikeAbstention('The corpus has no annotated excerpts on this topic.'));
        assert.ok(looksLikeAbstention('I could not find any excerpts about that.'));
        assert.ok(looksLikeAbstention('This topic is outside the scope of this corpus.'));
    });

    it('reconhece a recusa mesmo sem acento', () => {
        // O marcador é heurística de FORMA, então afrouxar acento é seguro —
        // ao contrário do citationGuard, onde acento distingue afirmações.
        // Deixar de contar uma recusa por causa de "nao" seria perder o dado.
        assert.ok(looksLikeAbstention('O corpus nao tem trechos sobre isso.'));
    });

    it('tolera entrada vazia', () => {
        assert.ok(!looksLikeAbstention(''));
        assert.ok(!looksLikeAbstention(undefined));
    });
});

describe('Métricas — abstenção por sinal estrutural', () => {
    const VAZIO = JSON.stringify({ records: [] });

    it('detecta abstenção sem depender do idioma', () => {
        // O ponto da Etapa K: se todas as consultas voltaram vazias e a resposta
        // não citou nada, o modelo não tinha o que afirmar — em QUALQUER idioma,
        // sem reconhecer como ele redigiu a recusa. É medir fato, não prosa.
        const m = measureTurn({
            answerText: 'Ich konnte dazu nichts im Korpus finden.',
            toolTexts: [VAZIO, VAZIO],
            rounds: 2
        });

        assert.strictEqual(m.abstained, true);
    });

    it('não conta abstenção quando a consulta trouxe dados', () => {
        // Resposta com evidência não é recusa, mesmo que contenha uma frase que
        // pareça negação ("o corpus não trata de X, mas trata de Y").
        const m = measureTurn({
            answerText: 'O corpus não trata de X, mas "trata de outro assunto relevante aqui".',
            toolTexts: [PAYLOAD],
            rounds: 1
        });

        assert.strictEqual(m.abstained, false);
    });

    it('não confunde erro de acesso com consulta vazia', () => {
        // Recusa do servidor chega como texto cru. Tratá-la como ausência de
        // dados seria mentir sobre o corpus.
        const m = measureTurn({
            answerText: 'Houve um erro ao consultar.',
            toolTexts: ['User is not authorized to access database'],
            rounds: 1
        });

        assert.strictEqual(m.abstained, false);
    });

    it('a frase ainda cobre a recusa sem consulta', () => {
        // O modelo reconhece de saída que a pergunta está fora do corpus e não
        // consulta. Não há payload a inspecionar — o sinal estrutural não decide.
        const m = measureTurn({
            answerText: 'The corpus has no annotated excerpts about that subject.',
            toolTexts: [],
            rounds: 1
        });

        assert.strictEqual(m.abstained, true);
    });
});

describe('Métricas — perguntas-armadilha bilíngues', () => {
    it('traz armadilhas nos dois idiomas', () => {
        // A armadilha precisa ser feita na língua do corpus, senão mede a
        // capacidade de traduzir em vez da de reconhecer ausência.
        const pt = TRAP_QUESTIONS.filter((q) => /corpus diz|trechos tratam|conceitos o corpus/.test(q));
        const en = TRAP_QUESTIONS.filter((q) => /does the corpus|excerpts deal|concepts does/.test(q));

        assert.ok(pt.length >= 3, 'faltam armadilhas em português');
        assert.ok(en.length >= 3, 'faltam armadilhas em inglês');
    });
});

describe('Métricas — turno', () => {
    it('conta rodadas e chamadas de ferramenta', () => {
        const m = measureTurn({ answerText: 'resposta', toolTexts: [PAYLOAD, PAYLOAD], rounds: 3 });

        assert.strictEqual(m.rounds, 3);
        assert.strictEqual(m.toolCalls, 2);
    });

    it('conta citações e quantas conferem', () => {
        const answer =
            '> "o trabalho uberizado constitui-se como parte associada às configurações"\n\n' +
            'E também: "uma citação inventada que não está no payload nenhum".';
        const m = measureTurn({ answerText: answer, toolTexts: [PAYLOAD], rounds: 2 });

        assert.strictEqual(m.quotes, 2);
        assert.strictEqual(m.verifiedQuotes, 1);
    });

    it('marca o turno que recusou', () => {
        const m = measureTurn({
            answerText: 'O corpus não tem trechos sobre isso.',
            toolTexts: [PAYLOAD],
            rounds: 1
        });

        assert.strictEqual(m.abstained, true);
    });

    it('tolera turno sem dados', () => {
        const m = measureTurn({});

        assert.strictEqual(m.rounds, 0);
        assert.strictEqual(m.quotes, 0);
    });
});

describe('Métricas — agregação', () => {
    it('calcula a média de rodadas', () => {
        const s = summarize([
            { rounds: 2, quotes: 0, verifiedQuotes: 0, abstained: false },
            { rounds: 4, quotes: 0, verifiedQuotes: 0, abstained: false }
        ]);

        assert.strictEqual(s.avgRounds, 3);
    });

    it('calcula a precisão literal das citações detectadas', () => {
        // RENOMEADA (Etapa 7): era `citationCoverage`. O número divide citações
        // conferidas por citações EXTRAÍDAS — é precisão do que foi detectado,
        // não cobertura das afirmações. Uma afirmação sem citação alguma é
        // invisível a ela, que é justamente o caso que "cobertura" sugeria medir.
        const s = summarize([
            { rounds: 1, quotes: 3, verifiedQuotes: 3, abstained: false },
            { rounds: 1, quotes: 1, verifiedQuotes: 0, abstained: false }
        ]);

        assert.strictEqual(s.totalQuotes, 4);
        assert.strictEqual(s.literalQuotePrecision, 0.75);
    });

    it('sem citação, a precisão é NULA — não 1', () => {
        // O raciocínio antigo estava meio certo: 0 seria errado, porque uma
        // resposta sem citações não tem precisão RUIM. Mas 1 é igualmente
        // errado, e pior: sai do relatório indistinguível de precisão perfeita,
        // e um modelo que nunca cita pontuaria como um que cita e acerta.
        //
        // O caso correto é "não aplicável".
        const s = summarize([{ rounds: 1, quotes: 0, verifiedQuotes: 0, abstained: false }]);

        assert.strictEqual(s.literalQuotePrecision, null);
    });

    it('não promete cobertura de afirmação', () => {
        // Medir isso exige saber quais afirmações existem — protocolo `[E#]` por
        // afirmação e bateria com gabarito. Enquanto não houver, o honesto é
        // devolver `null` em vez de um número que parece medir.
        const s = summarize([{ rounds: 1, quotes: 3, verifiedQuotes: 3, abstained: false }]);

        assert.strictEqual(s.claimCitationCoverage, null);
    });

    it('conta as abstenções', () => {
        const s = summarize([
            { rounds: 1, quotes: 0, verifiedQuotes: 0, abstained: true },
            { rounds: 1, quotes: 0, verifiedQuotes: 0, abstained: false }
        ]);

        assert.strictEqual(s.abstentions, 1);
    });

    it('tolera lista vazia, sem inventar valor', () => {
        const s = summarize([]);

        assert.strictEqual(s.turns, 0);
        assert.strictEqual(s.literalQuotePrecision, null);
    });
});

describe('Métricas — perguntas-armadilha', () => {
    it('são plausíveis para a área, não absurdas', () => {
        // Perguntar algo absurdo mediria a capacidade de reconhecer absurdo,
        // não a de reconhecer que o corpus não cobre o tema.
        assert.ok(TRAP_QUESTIONS.length >= 3);
        for (const q of TRAP_QUESTIONS) {
            assert.ok(q.length > 30, `pergunta curta demais: ${q}`);
            assert.ok(q.includes('?'));
        }
    });

    it('a recusa correta é detectada como abstenção', () => {
        const m = measureTurn({
            answerText: 'O corpus não tem trechos anotados sobre política monetária no Japão.',
            toolTexts: [PAYLOAD],
            rounds: 1
        });

        assert.strictEqual(m.abstained, true);
    });
});

describe('Métricas — relatório', () => {
    const summary = summarize([
        { rounds: 3, quotes: 2, verifiedQuotes: 2, abstained: false },
        { rounds: 5, quotes: 1, verifiedQuotes: 1, abstained: false }
    ]);

    it('traz os números com o que cada um significa', () => {
        const text = renderReport('teste', summary);

        assert.match(text, /Model rounds \(mean\)/);
        assert.match(text, /Literal precision/);
        // Separa o que o modelo pediu do que a extensão leu por conta própria:
        // o prefetch custa consulta real e ficava fora de qualquer contabilidade.
        assert.match(text, /Extension queries/);
    });

    it('registra as condições da medição', () => {
        // Sem `{modelo, banco, snapshot}` dois relatórios não são comparáveis, e
        // uma troca de banco no meio da sessão pareceria diferença entre
        // modelos.
        const text = renderReport('teste', summary, undefined, {
            models: ['Claude Opus'],
            databases: ['face85']
        });

        assert.match(text, /Measurement conditions/);
        assert.match(text, /Claude Opus/);
        assert.match(text, /face85/);
    });

    it('avisa quando a sessão misturou modelos ou bancos', () => {
        // Agregar silenciosamente coisas não comparáveis é como um número
        // exploratório vira selo de qualidade.
        const text = renderReport('teste', summary, undefined, {
            models: ['Claude', 'GPT'],
            databases: ['face85']
        });

        assert.match(text, /mixed models/i);
        assert.match(text, /not comparable/i);
    });

    it('declara que não usa juiz LLM', () => {
        // É a propriedade que torna a métrica defensável; deixá-la implícita
        // convidaria a confundi-la com um faithfulness score.
        assert.match(renderReport('teste', summary), /None of these metrics uses an LLM judge/);
    });

    it('avisa para comparar, não ler em absoluto', () => {
        assert.match(renderReport('teste', summary), /Compare, do not read in absolute terms/);
    });

    it('ressalva que não mede utilidade', () => {
        // Sem isto, uma precisão alta seria lida como "boa resposta".
        assert.match(renderReport('teste', summary), /none\s+of this measures whether the answer is/is);
    });

    it('declara que precisão literal não é entailment', () => {
        // A ressalva que faltava: o trecho existir não prova que ele sustenta a
        // afirmação que o acompanha.
        const text = renderReport('teste', summary);

        assert.match(text, /not that it supports the claim/i);
        assert.match(text, /no quotation at all are invisible/i);
    });

    it('avisa que as armadilhas são genéricas', () => {
        // Um corpus que trate legitimamente de política monetária responderia às
        // armadilhas com razão, e a métrica o puniria por isso.
        assert.match(renderReport('teste', summary), /trap questions are generic/i);
    });

    it('inclui a linha de abstenção quando há armadilhas', () => {
        const traps = summarize([
            { rounds: 1, quotes: 0, verifiedQuotes: 0, abstained: true },
            { rounds: 1, quotes: 0, verifiedQuotes: 0, abstained: false }
        ]);
        const text = renderReport('teste', summary, traps);

        assert.match(text, /Abstention \| 1\/2/);
    });

    it('omite a abstenção quando não houve armadilha', () => {
        assert.ok(!/Abstention/.test(renderReport('teste', summary)));
    });
});

/**
 * Classificação de payload (Etapa 7).
 *
 * `allQueriesEmpty` media `rows.length`, o que faz `{"records":[{"count":0}]}` —
 * uma agregação que não encontrou nada — contar como resultado, porque a linha
 * existe. O próprio comentário do código dizia que `count: 0` deve valer como
 * vazio, e o comportamento contradizia.
 */
describe('Métricas — o que conta como consulta sem dado', () => {
    const { allQueriesEmpty, classifyPayload, PayloadKind } = require('../../src/chat/chatMetrics');

    it('agregação zerada é ausência de dado, não resultado', () => {
        // O defeito reproduzido: a linha existe, mas o total é zero.
        assert.strictEqual(
            classifyPayload(JSON.stringify({ records: [{ count: 0 }] })),
            PayloadKind.ZERO_AGGREGATE
        );
        assert.ok(allQueriesEmpty([JSON.stringify({ records: [{ count: 0 }] })]));
    });

    it('agregação com valor NÃO é vazio', () => {
        assert.strictEqual(
            classifyPayload(JSON.stringify({ records: [{ count: 20 }] })),
            PayloadKind.ROWS
        );
        assert.ok(!allQueriesEmpty([JSON.stringify({ records: [{ count: 20 }] })]));
    });

    it('distingue consulta sem linhas de agregação zerada', () => {
        // As duas significam "o corpus não sustenta", mas não são a mesma
        // medida: uma não achou, a outra achou e o total é zero.
        assert.strictEqual(classifyPayload(JSON.stringify({ records: [] })), PayloadKind.NO_ROWS);
    });

    it('payload não-JSON não é ausência de dado', () => {
        // Recusa de acesso chega como texto cru. Não sabemos o que houve —
        // tratar como vazio mentiria sobre o corpus.
        assert.strictEqual(classifyPayload('User is not authorized'), PayloadKind.NOT_JSON);
        assert.ok(!allQueriesEmpty(['User is not authorized']));
    });

    it('linha com campos nulos não é agregação zerada', () => {
        // `null` não é `0`: um registro existe e tem campos vazios.
        assert.strictEqual(
            classifyPayload(JSON.stringify({ records: [{ name: null }] })),
            PayloadKind.ROWS
        );
    });
});

describe('Métricas — contagens vindas do trace', () => {
    it('conta chamadas de ferramenta, não payloads de texto', () => {
        // `toolCalls` era `toolTexts.length`: uma ferramenta que devolve duas
        // partes contava como duas, e uma que falhou contava como zero.
        const trace = {
            modelRequests: 2,
            toolCalls: [
                { prefetch: true, toolName: 'get_schema', status: 'ok', texts: ['{}'] },
                { toolName: 'query', status: 'ok', texts: ['{"records":[]}', '{"records":[]}'] },
                { toolName: 'query', status: 'error', error: 'boom' }
            ]
        };

        const m = measureTurn({ answerText: 'x', toolTexts: [], rounds: 2, trace });

        assert.strictEqual(m.toolCalls, 2, 'duas chamadas do modelo');
        assert.strictEqual(m.prefetchCalls, 1, 'schema lido pela extensão');
        assert.strictEqual(m.failedToolCalls, 1);
        assert.strictEqual(m.modelRequests, 2);
    });

    it('funciona sem trace, para quem ainda chama do jeito antigo', () => {
        const m = measureTurn({ answerText: 'x', toolTexts: ['{}', '{}'], rounds: 1 });
        assert.strictEqual(m.toolCalls, 2);
    });
});
