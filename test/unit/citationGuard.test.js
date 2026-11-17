/**
 * O juiz de citações: verificação determinística, sem LLM.
 *
 * É o único ponto do assistente onde verificar não envolve julgamento — o
 * trecho está no payload da ferramenta ou não está. O que ele pega é a citação
 * forjada: o modelo escreve entre aspas algo que soa como o corpus mas não veio
 * dele. Em pesquisa qualitativa é o erro mais caro, porque uma frase inventada
 * atribuída a um autor real passa despercebida e chega ao texto publicado.
 *
 * O risco simétrico é o falso alarme: acusar citação correta corrói a confiança
 * no aviso tanto quanto deixar passar a forjada. Daí metade destes testes ser
 * sobre NÃO acusar.
 */

const assert = require('assert');
const {
    normalizeForComparison,
    extractQuotes,
    verifyCitations,
    describeUnverified
} = require('../../src/chat/citationGuard');

const PAYLOAD = JSON.stringify({
    records: [
        {
            citation:
                'This study analyzes a municipality\'s application to the UNESCO Creative Cities Network (UCCN), using a documentary analysis grounded in Milton Santos\'s concepts.',
            bibtex: 'emmendoerfer2024'
        }
    ]
});

describe('Juiz de citações — normalização', () => {
    it('iguala aspas tipográficas a retas', () => {
        // Modelos reescrevem “ ” ‘ ’ o tempo todo; sem isto, citação correta
        // seria acusada.
        assert.strictEqual(
            normalizeForComparison('o “trecho” é ‘assim’'),
            normalizeForComparison('o "trecho" é \'assim\'')
        );
    });

    it('colapsa quebras de linha e espaços múltiplos', () => {
        // O payload JSON traz \n onde a resposta traz espaço.
        assert.strictEqual(
            normalizeForComparison('uma   frase\ncom\tquebras'),
            'uma frase com quebras'
        );
    });

    it('iguala reticências tipográficas a três pontos', () => {
        assert.strictEqual(normalizeForComparison('a… b'), normalizeForComparison('a... b'));
    });

    it('iguala travessão a hífen', () => {
        assert.strictEqual(normalizeForComparison('a — b'), normalizeForComparison('a - b'));
    });

    it('remove escapes de LaTeX do texto do corpus', () => {
        // Terceiro falso alarme ao vivo (2026-08-24): o `.syn` traz `43,08\%`
        // (escape herdado de fonte LaTeX), o modelo cita `43,08%` — correto — e
        // a comparação falhava por uma barra que não é conteúdo.
        // A barra chega DUPLICADA no payload JSON do MCP, daí o `\\+`.
        assert.strictEqual(
            normalizeForComparison('explicar 43,08\\\\% da variação'),
            normalizeForComparison('explicar 43,08% da variação')
        );
        assert.strictEqual(
            normalizeForComparison('custo de R\\$ 50'),
            normalizeForComparison('custo de R$ 50')
        );
    });

    it('preserva acento e pontuação', () => {
        // Afrouxar demais aprovaria citação adulterada: "não é" e "e" são
        // afirmações opostas.
        assert.notStrictEqual(normalizeForComparison('análise'), normalizeForComparison('analise'));
    });
});

describe('Juiz de citações — extração', () => {
    it('encontra citação entre aspas', () => {
        const quotes = extractQuotes('Segundo o corpus, "this is a long enough quotation to count here".');
        assert.strictEqual(quotes.length, 1);
    });

    it('ignora termo técnico curto entre aspas', () => {
        // `"chain"`, `"Result"` são uso legítimo de aspas, não citação —
        // verificá-los produziria alarme em cima de texto correto.
        assert.deepStrictEqual(extractQuotes('o campo "chain" e a zona "Result"'), []);
    });

    it('encontra citação em blockquote', () => {
        const answer = '> "male respondents were more likely to support CCS" — ashworth2019';
        assert.strictEqual(extractQuotes(answer).length, 1);
    });

    it('não encontra citação onde não há', () => {
        assert.deepStrictEqual(extractQuotes('Existem 210 conceitos neste grafo.'), []);
    });

    it('não captura a prosa ENTRE duas citações', () => {
        // Regressão de defeito observado ao vivo (2026-08-24): numa resposta de
        // auditoria — várias citações separadas por títulos e listas — o padrão
        // anterior tratava qualquer aspa como abertura E fechamento, capturando
        // o miolo estrutural como se fosse citação. 14 falsos alarmes numa
        // resposta inteiramente sustentada.
        const auditoria = [
            '**EVIDÊNCIA — Literal no corpus:**',
            '',
            '> "O trabalho uberizado constitui-se como parte associada às configurações anteriores." — autor2025',
            '- `source_file`: `face85.syn`, linha 317',
            '',
            '### Afirmação 3',
            '',
            '**EVIDÊNCIA — Literal no corpus:**',
            '',
            '> "A análise delineia o uberismo como forma de organização do trabalho." — autor2025'
        ].join('\n');

        const quotes = extractQuotes(auditoria);

        assert.strictEqual(quotes.length, 2);
        for (const quote of quotes) {
            assert.ok(!quote.includes('EVIDÊNCIA'), `capturou prosa: ${quote}`);
            assert.ok(!quote.includes('source_file'), `capturou metadado: ${quote}`);
        }
    });

    it('não captura texto que atravessa parágrafo', () => {
        const answer = '"início de algo longo o suficiente\n\nfim de outra coisa bem longa"';
        assert.deepStrictEqual(extractQuotes(answer), []);
    });

    it('não trata o título que reenuncia a própria afirmação como citação', () => {
        // Segundo falso alarme ao vivo (2026-08-24): numa auditoria, o modelo
        // usou títulos para repetir as PRÓPRIAS afirmações anteriores. Sete
        // acusações, nenhuma pretendendo ser trecho do corpus.
        const auditoria = [
            '### **Afirmação 1: "O corpus trata uberismo principalmente através de uma única fonte"**',
            '',
            '✅ **SUSTENTADA.**',
            '',
            '### **Afirmação 6 (SÍNTESE): "O corpus enquadra uberismo como modo contemporâneo de trabalho"**'
        ].join('\n');

        assert.deepStrictEqual(extractQuotes(auditoria), []);
    });

    it('ainda extrai a citação real dentro de uma tabela de auditoria', () => {
        // O contraponto do teste acima: a evidência de verdade continua sendo
        // conferida, mesmo no formato tabular que a auditoria usa.
        const linha =
            '| x_n0003 | "A análise delineia o uberismo como uma forma de organização do trabalho." | face85.syn |';

        assert.strictEqual(extractQuotes(linha).length, 1);
    });

    it('não trata fala hipotética como citação', () => {
        // Quarto falso alarme ao vivo (2026-08-24): numa auditoria, o modelo
        // criticou a própria resposta anterior — "A resposta deveria ter dito:
        // '...'" — e a frase entre aspas nunca existiu; é o que ele julga que
        // deveria ter sido dito. Conferi-la contra o banco é erro de categoria.
        const critica =
            'A resposta deveria ter dito: *"PageRank não é trivial em Cypher; ' +
            'vou mostrar grau em vez disso"* — ou ter executado a query antes.';

        assert.deepStrictEqual(extractQuotes(critica), []);
    });

    it('cobre as variações de fala hipotética', () => {
        assert.deepStrictEqual(
            extractQuotes('O modelo poderia dizer: "não consigo calcular isso com as ferramentas"'),
            []
        );
        assert.deepStrictEqual(
            extractQuotes('Bastaria responder: "o corpus não sustenta essa afirmação toda"'),
            []
        );
    });

    it('não confunde citação real com fala hipotética distante', () => {
        // A janela é curta de propósito: um verbo hipotético num parágrafo
        // anterior não pode invalidar a citação seguinte.
        const texto =
            'A resposta deveria ter dito algo mais claro sobre o método empregado.\n\n' +
            '> "A análise delineia o uberismo como forma de organização do trabalho." — autor2025';

        assert.strictEqual(extractQuotes(texto).length, 1);
    });

    it('não confunde aspa de fechamento com abertura', () => {
        // `”` fecha, `“` abre — misturá-las fazia o casamento atravessar a prosa.
        const answer =
            '“a primeira citação com palavras suficientes aqui” e prosa no meio ' +
            '“a segunda citação também com palavras suficientes”';
        assert.strictEqual(extractQuotes(answer).length, 2);
    });
});

describe('Juiz de citações — verificação', () => {
    it('aprova a citação que está no payload', () => {
        const answer =
            '> "This study analyzes a municipality\'s application to the UNESCO Creative Cities Network (UCCN)" — emmendoerfer2024';
        const result = verifyCitations(answer, [PAYLOAD]);

        assert.strictEqual(result.unverified.length, 0);
        assert.strictEqual(result.verified.length, 1);
    });

    it('aprova mesmo com aspas tipográficas na resposta', () => {
        // O caso real: o modelo devolve “ ” onde o banco tem " ".
        const answer = '> “using a documentary analysis grounded in Milton Santos”';
        assert.strictEqual(verifyCitations(answer, [PAYLOAD]).unverified.length, 0);
    });

    it('aprova recorte com reticências', () => {
        // "início (...) fim" é recorte legítimo: cada parte existe, mas não
        // contíguas. Exigir contiguidade acusaria citação honesta.
        const answer = '> "This study analyzes a municipality\'s application (...) grounded in Milton Santos\'s concepts."';
        assert.strictEqual(verifyCitations(answer, [PAYLOAD]).unverified.length, 0);
    });

    it('ACUSA citação forjada', () => {
        // O que o juiz existe para pegar: plausível, bem formatada, inventada.
        const answer =
            '> "The study concludes that creative cities always increase local tourism revenue" — emmendoerfer2024';
        const result = verifyCitations(answer, [PAYLOAD]);

        assert.strictEqual(result.unverified.length, 1);
        assert.match(result.unverified[0], /always increase local tourism/);
    });

    it('ACUSA citação adulterada por negação', () => {
        // Uma palavra invertida muda a afirmação; a comparação preserva
        // pontuação e acento justamente para pegar isto.
        const answer = '> "This study does not analyze a municipality\'s application to the UNESCO Creative Cities Network"';
        assert.strictEqual(verifyCitations(answer, [PAYLOAD]).unverified.length, 1);
    });

    it('separa verificadas de não verificadas na mesma resposta', () => {
        const answer =
            '> "using a documentary analysis grounded in Milton Santos"\n\n' +
            'E também: "the municipality withdrew its application after the review".';
        const result = verifyCitations(answer, [PAYLOAD]);

        assert.strictEqual(result.verified.length, 1);
        assert.strictEqual(result.unverified.length, 1);
    });

    it('não verifica nada quando nenhuma ferramenta foi chamada', () => {
        // Pergunta sobre o template não tem payload contra o que conferir;
        // acusar tudo ali seria alarme falso garantido.
        const answer = '> "algum texto entre aspas que parece uma citação longa"';
        const result = verifyCitations(answer, []);

        assert.strictEqual(result.checked, 0);
        assert.strictEqual(result.unverified.length, 0);
    });

    it('não acusa resposta sem citação nenhuma', () => {
        const result = verifyCitations('Existem 210 conceitos neste grafo.', [PAYLOAD]);
        assert.strictEqual(result.unverified.length, 0);
    });

    it('tolera entrada vazia ou ausente', () => {
        assert.strictEqual(verifyCitations('', [PAYLOAD]).checked, 0);
        assert.strictEqual(verifyCitations(undefined, undefined).checked, 0);
    });
});

describe('Juiz de citações — aviso ao pesquisador', () => {
    it('não avisa quando está tudo conferido', () => {
        assert.strictEqual(describeUnverified([]), undefined);
        assert.strictEqual(describeUnverified(undefined), undefined);
    });

    it('nomeia a citação que não conferiu', () => {
        // Dizer QUAL é o que torna o aviso acionável; "algo não confere"
        // deixaria a resposta inteira sob suspeita.
        const text = describeUnverified(['uma citação inventada qualquer']);
        assert.ok(text.includes('uma citação inventada qualquer'));
    });

    it('afirma o fato verificável, sem acusar o modelo de mentir', () => {
        // Pode ser recorte ou tradução; o que se afirma é que aquele texto não
        // está no que o banco devolveu.
        const text = describeUnverified(['x'.repeat(40)]);
        assert.match(text, /(was|were) not found/);
        assert.match(text, /database returned/);
    });

    it('não promete que o resto da resposta está íntegro', () => {
        // CORREÇÃO (Etapa 3): o aviso afirmava que "as demais afirmações da
        // resposta não são afetadas". Isso não é inferível — a citação que não
        // confere pode sustentar exatamente a conclusão principal, e o resto da
        // resposta nunca foi verificado.
        const text = describeUnverified(['x'.repeat(40)]);
        assert.ok(!/are not affected/.test(text));
    });

    it('declara o que a verificação cobre, e o que não cobre', () => {
        // O nome honesto é "literalidade": existe no registro, sim; sustenta a
        // afirmação, não se sabe.
        const text = describeUnverified(['x'.repeat(40)]);
        assert.match(text, /literalness/i);
        assert.match(text, /does not\s+say whether the quotation supports the claim/i);
    });

    it('trunca citação longa no aviso', () => {
        const text = describeUnverified(['y'.repeat(300)]);
        assert.ok(text.length < 600);
        assert.ok(text.includes('…'));
    });

    it('usa plural quando há mais de uma', () => {
        const text = describeUnverified(['a'.repeat(30), 'b'.repeat(30)]);
        assert.match(text, /Unchecked quotations/);
    });
});

/**
 * Verificação por registro, não por `haystack` (Etapa 3).
 *
 * A versão anterior concatenava TODOS os payloads do turno num único texto e
 * procurava cada segmento nele. Uma citação com um pedaço da fonte A e outro da
 * fonte B era aprovada — porque cada pedaço, isoladamente, existia em algum
 * lugar do que voltou.
 */
describe('Juiz — a citação precisa caber num único registro', () => {
    const PAYLOAD = JSON.stringify({
        records: [
            {
                citation: 'a aceitação social depende da confiança institucional',
                item_id: 'c1',
                bibtex: 'avelar2016'
            },
            {
                citation: 'o custo percebido supera o benefício declarado',
                item_id: 'c2',
                bibtex: 'ribeiro2020'
            }
        ]
    });

    it('acusa citação montada com trechos de duas fontes', () => {
        const resposta =
            '> "a aceitação social depende da confiança institucional (...) o custo percebido supera o benefício declarado" — avelar2016';
        const { unverified } = verifyCitations(resposta, [PAYLOAD]);

        assert.strictEqual(unverified.length, 1);
    });

    it('aprova citação que existe inteira num registro', () => {
        const resposta = '> "a aceitação social depende da confiança institucional" — avelar2016 (2016)';
        const { verified, unverified } = verifyCitations(resposta, [PAYLOAD]);

        assert.strictEqual(unverified.length, 0);
        assert.strictEqual(verified.length, 1);
    });

    it('devolve o registro que sustenta cada citação conferida', () => {
        // É o vínculo que liga a citação à sua âncora: sem ele, as âncoras
        // saíam de tudo que o turno consultou.
        const resposta = '> "o custo percebido supera o benefício declarado" — ribeiro2020 (2020)';
        const { supported } = verifyCitations(resposta, [PAYLOAD]);

        const [record] = [...supported.values()];
        assert.strictEqual(record.bibtex, 'ribeiro2020');
    });

    it('não acusa quando o turno não trouxe evidência alguma', () => {
        // Pergunta sobre o template: não há contra o que conferir, e acusar
        // tudo ali seria alarme falso garantido.
        const schema = JSON.stringify({ records: [{ count: 20 }] });
        const { checked } = verifyCitations('> "qualquer coisa entre aspas aqui" — x', [schema]);

        assert.strictEqual(checked, 0);
    });
});
