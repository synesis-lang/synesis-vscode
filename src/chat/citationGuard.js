/**
 * citationGuard.js — **verificação de literalidade** das citações.
 *
 * O nome importa e foi corrigido na Etapa 3: isto não é um juiz de fidelidade.
 * Ele responde a uma pergunta estreita e verificável — *este trecho existe,
 * literalmente, num registro que o banco devolveu?* — e nada além dela.
 *
 * É o único ponto do assistente onde a verificação **não envolve julgamento**:
 * o trecho está no registro ou não está. Não é um juiz LLM, com viés e limiar —
 * é comparação de strings, e por isso o resultado é reproduzível e explicável.
 *
 * O que ele pega: a citação forjada — o modelo escreve entre aspas algo que
 * *soa* como o corpus mas não veio dele. Em pesquisa qualitativa esse é o erro
 * mais caro, porque uma frase inventada atribuída a um autor real passa
 * despercebida e chega ao texto publicado.
 *
 * **Verificação por registro, não por `haystack` (Etapa 3).** Antes, todos os
 * payloads do turno eram concatenados num único texto e cada segmento era
 * procurado nele. Isso aprovava uma citação montada com um pedaço da fonte A e
 * outro da fonte B — reproduzido em teste. Agora cada citação precisa caber
 * **num único campo `citation`**, na ordem em que a resposta a apresenta.
 *
 * O que ele NÃO pega, e é honesto dizer: citação correta atribuída à fonte
 * errada na prosa, paráfrase apresentada como síntese, omissão, ou se o trecho
 * de fato sustenta a afirmação que o acompanha. Verificar isso é entailment, e
 * transformar um juiz LLM em selo determinístico seria prometer o que ele não
 * entrega.
 */

// A normalização mora em `textNormalize.js` desde a Etapa 3: guarda, parser de
// evidência e âncoras precisam da MESMA leitura, ou a citação confere num
// caminho e falha no outro.
const { normalizeForComparison } = require('./textNormalize');
const { parseEvidenceRecords, findSupportingRecord } = require('./evidence');

/**
 * Extrai as citações que a resposta apresenta como texto do corpus.
 *
 * Duas formas, ambas ensinadas no prompt (`CITATION_RULES`):
 * - blockquote markdown (`> "trecho" — Autor (ano)`);
 * - trecho entre aspas com mais de algumas palavras.
 *
 * O limiar de tamanho existe para não tratar termo técnico entre aspas
 * (`"chain"`, `"Result"`) como citação — verificar aquilo produziria alarme em
 * cima de uso legítimo de aspas.
 */
const MIN_QUOTE_WORDS = 6;

/**
 * Uma citação nunca atravessa uma linha em branco nem um marcador de lista.
 *
 * Observado ao vivo (2026-08-24), numa resposta de auditoria: o padrão anterior
 * (`/["“]([^"“”]{20,})["”]/g`) tratava qualquer aspa como abertura E fechamento,
 * então o texto ENTRE duas citações — prosa, títulos, marcadores — era capturado
 * como se fosse uma citação. Resultado: 14 falsos alarmes, um deles acusando
 * literalmente `"**EVIDÊNCIA — Literal no corpus:**\n\n>"`.
 *
 * Falso alarme é o defeito mais caro deste módulo: acusar citação correta corrói
 * a confiança no aviso tanto quanto deixar passar uma forjada — e uma resposta
 * inteiramente sustentada terminou com um aviso alarmante.
 *
 * A correção tem duas partes:
 * - **pares direcionais**: `“` só fecha com `”`, `"` só com `"`;
 * - **sem quebra de parágrafo nem marcador**: o conteúdo não pode conter linha
 *   em branco, `>` de blockquote ou `- ` de lista, que é o que a prosa entre
 *   citações sempre tem.
 */
const QUOTE_PATTERNS = [
    // Aspas tipográficas: par direcional, sem ambiguidade de abertura/fechamento.
    /“([^“”]{20,}?)”/g,
    // Aspas retas: o conteúdo não pode conter aspa reta nem quebra de parágrafo.
    /"([^"\n]{20,}?)"/g
];

/**
 * Linhas em que uma aspa NÃO delimita citação do corpus.
 *
 * Segundo falso alarme observado ao vivo (2026-08-24): numa resposta de
 * auditoria, o modelo usou títulos para reenunciar as **próprias afirmações
 * anteriores** — `### **Afirmação 1: "O corpus trata uberismo..."**`. Sete
 * acusações, todas de texto que o modelo escreveu sobre si mesmo, nenhuma
 * pretendendo ser trecho do corpus.
 *
 * A distinção não está no conteúdo entre aspas — está no que vem ANTES. Um
 * título de seção, um rótulo de afirmação ou uma pergunta reproduzida anunciam
 * "isto é a minha fala", enquanto `>` de blockquote e célula de tabela anunciam
 * "isto é evidência".
 *
 * Errar para o lado de não verificar é deliberado: uma citação do corpus que o
 * modelo ponha num título perde a conferência, mas nenhum texto correto é
 * acusado. Como o prompt (`CITATION_RULES`) manda citar em blockquote, o custo
 * é pequeno e o ganho — não gritar sobre resposta correta — é o que mantém o
 * aviso digno de atenção.
 */
const NON_CITATION_LINE = /^\s*(#{1,6}\s|\*{0,2}(afirma|síntese|sintese|pergunta|resposta|conclus|resumo|status|observa)\w*\b)/i;

/**
 * Verbos que introduzem fala HIPOTÉTICA, não citação do corpus.
 *
 * Quarto falso alarme ao vivo (2026-08-24): numa auditoria, o modelo criticou a
 * própria resposta anterior escrevendo *"A resposta **deveria ter dito**:
 * \"PageRank não é trivial em Cypher...\""*. A frase entre aspas nunca existiu —
 * é o que o modelo julga que deveria ter sido dito.
 *
 * Diferente dos três anteriores: ali a aspa delimitava texto real (prosa,
 * título, escape); aqui delimita uma frase **inventada de propósito**, e
 * corretamente marcada como hipótese pelo verbo que a antecede. Conferi-la
 * contra o banco é uma categoria de erro, não um problema de casamento.
 *
 * A janela é curta (~40 caracteres antes da aspa) para não capturar um verbo
 * distante que nada tem a ver com a citação seguinte.
 */
const HYPOTHETICAL_SPEECH =
    /\b(deveria|poderia|devia|podia|bastaria|caberia)\s+(ter\s+)?(dito|dizer|escrito|escrever|respondido|responder|afirmado|afirmar)\b[^"“]{0,20}$/i;

function extractQuotes(answer) {
    const text = String(answer || '');
    const found = new Set();

    for (const pattern of QUOTE_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const quote = match[1].trim();
            // Marcadores de estrutura denunciam prosa capturada por engano.
            if (/(\n\s*\n|^\s*[->*]\s|\*\*)/.test(quote)) {
                continue;
            }
            if (quote.split(/\s+/).length < MIN_QUOTE_WORDS) {
                continue;
            }

            // A linha em que a citação começa decide se ela é evidência ou a
            // própria fala do modelo.
            const lineStart = text.lastIndexOf('\n', match.index) + 1;
            const linePrefix = text.slice(lineStart, match.index);
            if (NON_CITATION_LINE.test(linePrefix)) {
                continue;
            }

            // Fala hipotética ("deveria ter dito: ...") não é citação do corpus.
            if (HYPOTHETICAL_SPEECH.test(text.slice(Math.max(0, match.index - 40), match.index))) {
                continue;
            }

            found.add(quote);
        }
    }

    return [...found];
}

/**
 * Confere as citações de uma resposta contra os registros que o banco devolveu.
 *
 * Devolve `{ checked, verified, unverified, supported }`. `unverified` traz as
 * citações que NÃO couberam em nenhum registro; `supported` mapeia cada citação
 * conferida ao registro que a sustenta — é o que liga a citação à sua âncora.
 *
 * **Não verifica quando não há registro de evidência.** Uma resposta que não
 * consultou o corpus (pergunta sobre o template, por exemplo) não tem contra o
 * que ser conferida, e acusar tudo ali seria alarme falso garantido.
 */
function verifyCitations(answer, toolTexts) {
    const records = parseEvidenceRecords(toolTexts);
    const quotes = extractQuotes(answer);

    if (records.length === 0 || quotes.length === 0) {
        return { checked: 0, verified: [], unverified: [], supported: new Map() };
    }

    const verified = [];
    const unverified = [];
    const supported = new Map();

    for (const quote of quotes) {
        // Um único registro precisa conter a citação inteira, na ordem. É o que
        // impede a montagem entre fontes que a versão por `haystack` aprovava.
        const record = findSupportingRecord(quote, records);
        if (record) {
            verified.push(quote);
            supported.set(quote, record);
        } else {
            unverified.push(quote);
        }
    }

    return { checked: quotes.length, verified, unverified, supported };
}

/**
 * Aviso a anexar à resposta quando alguma citação não confere.
 *
 * **Anexado, não interceptado.** `runToolCallingLoop` emite cada
 * `LanguageModelTextPart` assim que chega (`stream.markdown` dentro do
 * `for await`), então quando a verificação pode rodar o texto já está na tela.
 * Acumular a rodada final para interceptar custaria o streaming — a resposta
 * apareceria de uma vez. A marcação tardia preserva a fluidez e ainda dá ao
 * pesquisador o que ele precisa: saber QUAL citação não confere.
 *
 * O texto evita acusar o modelo de mentir: pode ser recorte, tradução ou
 * normalização que a comparação não cobre. O que se afirma é o fato
 * verificável — aquele texto não está no que o banco devolveu.
 */
function describeUnverified(unverified) {
    if (!unverified || unverified.length === 0) {
        return undefined;
    }

    const list = unverified
        .map((quote) => {
            const short = quote.length > 120 ? `${quote.slice(0, 120)}…` : quote;
            return `- "${short}"`;
        })
        .join('\n');

    const plural = unverified.length > 1;
    return (
        `\n\n---\n\n⚠️ **${plural ? 'Unchecked quotations' : 'Unchecked quotation'}.** ` +
        `${plural ? 'The excerpts below were not found' : 'The excerpt below was not found'} ` +
        'in any record the database returned in this conversation:\n\n' +
        `${list}\n\n` +
        'It may be a cut or a reformatting — but treat it as **unverified** until you check it ' +
        'in the `.syn` file.\n\n' +
        // A frase "as demais afirmações não são afetadas" saiu na Etapa 3: não
        // era inferível. A citação que não confere pode sustentar exatamente a
        // conclusão principal da resposta — e dizer o contrário dava ao
        // pesquisador uma garantia que a verificação não produz.
        'This check verifies **literalness**: whether the excerpt exists in the record. It does not ' +
        'say whether the quotation supports the claim next to it, nor whether the other claims ' +
        'are grounded.'
    );
}

module.exports = {
    // Reexportado de `textNormalize.js` para não quebrar quem já importava
    // daqui — a definição mudou de casa, o contrato não.
    normalizeForComparison,
    extractQuotes,
    verifyCitations,
    describeUnverified,
    MIN_QUOTE_WORDS
};
