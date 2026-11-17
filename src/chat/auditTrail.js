/**
 * auditTrail.js — a trilha de auditoria sob demanda.
 *
 * A resposta mostra o trecho e a referência; **o arquivo e a linha ficam aqui**,
 * atrás de um clique. A alternativa considerada era um rodapé de proveniência em
 * toda resposta, descartada por uma razão que vale repetir: o que sempre aparece
 * deixa de ser lido, e um aviso ignorado dá aparência de rigor sem entregá-lo.
 *
 * Sob demanda também é honesto quanto ao custo — auditar é a exceção, e quem não
 * audita não paga os tokens.
 */

// Parser único de evidência (Etapa 3). `extractOriginRecords` e
// `groupByOrigin` moravam aqui e duplicavam, em outro formato, a leitura que o
// guarda fazia por `haystack`. Duas interpretações do mesmo payload é como uma
// citação passava a conferir num caminho e não no outro.
const { parseEvidenceRecords, groupEvidence } = require('./evidence');
const { pick } = require('./promptLanguage');

/**
 * Os registros que têm ORIGEM — arquivo e linha do `.syn`.
 *
 * É um subconjunto do que o parser devolve, e a diferença importa: uma evidência
 * sem `source_file` (grafo anterior à Etapa A) ainda vale para conferir
 * literalidade, mas não tem para onde ancorar. Emitir um link que não abre nada
 * é pior do que não oferecer link: promete verificação e entrega erro.
 */
function extractOriginRecords(toolTexts) {
    return parseEvidenceRecords(toolTexts).filter((record) => record.sourceFile);
}

/** Compatibilidade: o nome antigo, agora servido pelo agrupador único. */
const groupByOrigin = groupEvidence;

/**
 * Renderiza a trilha em Markdown.
 *
 * Cada origem vira uma entrada com o trecho literal, a referência e — quando o
 * grafo a tem — o arquivo e a linha da anotação. A contagem de relações só
 * aparece quando é maior que 1: dizer "1 relação" seria ruído.
 */
function renderAuditTrail(groups) {
    if (!groups || groups.length === 0) {
        return (
            'There are no corpus excerpts to audit in this answer.\n\n' +
            'This happens when the answer came from the project **template** or from the ' +
            '**graph structure** (counts, labels) — which do not rest on annotated ' +
            'excerpts. The trail covers claims supported by corpus evidence.'
        );
    }

    const lines = ['## Audit trail', ''];

    groups.forEach((group, index) => {
        const reference = [group.bibtex, group.year && `(${group.year})`]
            .filter(Boolean)
            .join(' ');
        lines.push(`### ${index + 1}. ${reference || 'origin'}`);
        if (group.title) {
            lines.push(`*${group.title}*`);
        }
        lines.push('');
        if (group.citation) {
            lines.push(`> ${group.citation}`);
            lines.push('');
        }

        const provenance = [];
        if (group.file) {
            provenance.push(
                group.line !== null
                    ? `\`${group.file}\`, line ${group.line}`
                    : `\`${group.file}\``
            );
        }
        if (group.count > 1) {
            provenance.push(`${group.count} relations in this excerpt`);
        }
        if (provenance.length) {
            lines.push(provenance.join(' · '));
            lines.push('');
        }
    });

    lines.push('---');
    lines.push(
        'Each entry is an excerpt **annotated by the researcher**, not an automatic ' +
            'retrieval. Check it in the `.syn` file shown.'
    );

    return lines.join('\n');
}

/**
 * A trilha determinística do turno, em Markdown.
 *
 * **Não chama LLM e não consulta o banco.** Renderiza o `turnTrace` capturado
 * durante a resposta — a pergunta, o modelo, o banco, as consultas executadas na
 * ordem, e as evidências que voltaram. É a diferença entre reproduzir o que
 * ocorreu e pedir a um novo ciclo do modelo que reconstrua o que teria ocorrido.
 *
 * Abre num documento Markdown, e não no chat, pelo mesmo motivo do relatório de
 * métricas: é material para conferir ao lado do `.syn`, não para rolar para fora
 * do histórico.
 */
function renderTurnReport(trace) {
    if (!trace) {
        return 'There is no record of this turn. The trail covers the answers of this session.';
    }

    const lines = ['# Turn trail', ''];

    lines.push(`**Question.** ${trace.question || '(empty)'}`, '');

    // O cabeçalho é o que torna o registro reproduzível: sem banco, modelo e
    // horário, dois relatórios não são comparáveis.
    const header = [];
    if (trace.database) {
        header.push(`- Database: \`${trace.database}\``);
    }
    if (trace.model) {
        // O ID entra junto do nome: é ele que identifica o modelo sem
        // ambiguidade numa campanha que compara vários. O nome de exibição vem
        // do catálogo e pode repetir entre provedores.
        //
        // A `version` saiu: os providers do Synesis declaram `'1.0.0'` fixo, em
        // código, para todo modelo. Publicá-la como "versão" no relatório dava
        // ares de dado a uma constante nossa — pior que não informar nada.
        const nome = trace.model.name || trace.model.id;
        const id = trace.model.id && trace.model.id !== nome ? ` \`${trace.model.id}\`` : '';
        const vendor = trace.model.vendor ? ` (${trace.model.vendor})` : '';
        header.push(`- Model: ${nome}${id}${vendor}`);
    }
    if (trace.startedAt) {
        header.push(`- Started: ${trace.startedAt}`);
    }
    header.push(`- Model rounds: ${trace.modelRequests}`);
    // Prefetch e consulta do modelo contam separado (R4). Somados, uma melhoria
    // que ENCURTA o laço — menos rodadas do modelo — aparece como custo maior se
    // ela acrescentou uma leitura da extensão. Era o caso de B1/B2: a sondagem
    // somava 7 chamadas ao mesmo número que deveria mostrar o laço encolhendo.
    // Sem separar, nenhuma das melhorias seguintes é verificável.
    const prefetchCalls = trace.toolCalls.filter((call) => call.prefetch).length;
    const modelCalls = trace.toolCalls.length - prefetchCalls;
    header.push(`- Model queries: ${modelCalls}`);
    // Zero prefetch não significa que o turno respondeu sem schema: significa
    // que ele veio do cache de sessão, sem ida ao banco. Dizer isso evita ler o
    // número como se o contexto tivesse faltado — a trilha registra o que
    // efetivamente consultou o servidor, e é assim que ela deve ser lida.
    header.push(
        `- Extension reads (prefetch): ${prefetchCalls}` +
            (prefetchCalls === 0 ? ' — schema and context came from the session cache' : '')
    );
    if (header.length) {
        lines.push(...header, '');
    }

    if (trace.incomplete) {
        lines.push(
            '⚠️ **Incomplete turn.** The round limit was reached before a ' +
                'conclusion: the answer text is intermediate reasoning.',
            ''
        );
    }

    // As consultas, na ordem. É a "atividade" que o registro anterior não
    // preservava — sem ela, não há como refazer o caminho.
    lines.push('## Queries run', '');
    if (trace.toolCalls.length === 0) {
        lines.push('No query was run in this turn.', '');
    } else {
        trace.toolCalls.forEach((call, index) => {
            const origin = call.prefetch ? 'extension' : `model, round ${call.round ?? '?'}`;
            lines.push(`### ${index + 1}. \`${call.toolName}\` — ${origin}`);
            if (call.status === 'error') {
                lines.push('', `**Failed:** ${call.error || 'undescribed error'}`, '');
                return;
            }
            const query = call.input && (call.input.query || call.input.command);
            if (query) {
                const language = (call.input && call.input.language) || 'text';
                lines.push('', '```' + language, String(query).trim(), '```');
            } else if (call.input) {
                lines.push('', '```json', JSON.stringify(call.input), '```');
            }

            // Quantas linhas voltaram: é o que distingue "consultei e não achei"
            // de "não consultei".
            const counts = (call.texts || [])
                .map((text) => {
                    try {
                        const payload = JSON.parse(text);
                        const rows = Array.isArray(payload) ? payload : payload && payload.records;
                        return Array.isArray(rows) ? rows.length : null;
                    } catch {
                        return null;
                    }
                })
                .filter((n) => n !== null);
            if (counts.length) {
                const total = counts.reduce((sum, n) => sum + n, 0);
                lines.push('', total === 0 ? '_No results._' : `_${total} row(s) returned._`);
            }
            lines.push('');
        });
    }

    // Origens que a contenção recusou. Explicar é melhor do que só não mostrar
    // o link: um caminho fora da raiz costuma significar workspace errado ou
    // grafo de outra máquina, e nenhum dos dois se descobre pelo silêncio.
    const unanchorable = trace.unanchorable || [];
    if (unanchorable.length) {
        lines.push('## Origins without a link', '');
        lines.push(
            '_These excerpts have an origin stored in the graph, but the path is not inside ' +
                'any open workspace folder. Open the project folder, or re-export the ' +
                'graph from it._',
            ''
        );
        for (const origin of unanchorable) {
            const where = origin.line !== null && origin.line !== undefined
                ? `\`${origin.file}\`, line ${origin.line}`
                : `\`${origin.file}\``;
            lines.push(`- ${origin.bibtex ? `${origin.bibtex} — ` : ''}${where}`);
        }
        lines.push('');
    }

    // O raciocínio que levou a cada consulta. Fica no relatório — explica o
    // percurso — mas nunca entrou na resposta nem no que foi verificado
    // (Etapa 3): é prosa exploratória, não conclusão.
    const reasoning = (trace.intermediateText || []).filter((entry) => entry.text && entry.text.trim());
    if (reasoning.length) {
        lines.push('## Reasoning between queries', '');
        lines.push(
            '_Text the model wrote before each query. It is not part of the ' +
                'answer and was not verified._',
            ''
        );
        for (const entry of reasoning) {
            lines.push(`**Round ${entry.round}.** ${entry.text.trim()}`, '');
        }
    }

    return lines.join('\n');
}

/**
 * As consultas que o modelo executou num turno, na ordem.
 *
 * Só as do modelo: o prefetch de schema e `ProjectContext` não mede nada do
 * corpus e não serve para repetir uma contagem.
 */
function traceQueries(trace) {
    return ((trace && trace.toolCalls) || [])
        .filter((call) => !call.prefetch && call.status !== 'error')
        .map((call) => call.input && (call.input.query || call.input.command))
        .filter(Boolean);
}

/**
 * Prompt da consulta de auditoria.
 *
 * Vale como pergunta separada porque pode carregar o que seria caro em toda
 * resposta: pedir o trecho literal completo, o arquivo e a linha, e a instrução
 * de não interpretar. É o oposto da resposta principal — ali interessa a
 * síntese, aqui interessa a evidência crua.
 *
 * **É reavaliação, não trilha.** Este prompt abre um novo ciclo do modelo, que
 * pode discordar da resposta anterior sem estar certo. Fica atrás de um comando
 * próprio, separado do botão que mostra o registro determinístico do turno —
 * ver `renderTurnReport()`.
 */
function buildAuditPrompt(question, answer, queries) {
    // Vai ao modelo como pergunta: segue o idioma do projeto (promptLanguage.js).
    // As regras e o porquê de cada uma (agregar em vez de iterar; a regra de
    // divergência, observada ao vivo) são as mesmas nos dois idiomas.
    return (
        pick({
            en:
                'Audit of the previous answer. Do not reinterpret or rewrite the analysis: ' +
                'gather only the EVIDENCE that supports it.\n\n' +
                `Original question: ${question}\n\n` +
                `Answer given:\n${answer}\n\n` +
                'Query the database and return, for each claim about the corpus that the answer ' +
                'made, the excerpts that support it — with `i.citation AS citation`, ' +
                '`i.source_file AS source_file`, `i.source_line AS source_line`, ' +
                '`i.item_id AS item_id`, `s.bibtex AS bibtex`, `s.title AS title` and `s.year AS year`.\n\n' +
                'If any claim of the previous answer has **no** excerpt supporting it, ' +
                'say so explicitly: it is the most important information of this audit.\n\n' +
                'If the answer used semantic search (vector proximity), say from which ' +
                'seed concept the proximity started — without it the researcher cannot ' +
                'retrace the path.\n\n' +
                'Check quantities with **one aggregate query**, not one per item: ' +
                '`RETURN s.bibtex, count(DISTINCT c.name)` checks the whole distribution at ' +
                'once. Checking concept by concept exhausts the query budget before ' +
                'you finish the audit.\n\n' +
                '**Divergence rule — mandatory.** Before saying that a number of the ' +
                'previous answer is wrong:\n' +
                '1. Identify the UNIT of both numbers. Sources, annotated excerpts ' +
                '(`annotation_id`), analytical items (`item_id`), mentions (`MENTIONS` ' +
                'edges) and concepts are DIFFERENT units over the same data.\n' +
                '2. If the units differ, **there is no divergence**: say what ' +
                'each number measures and stop. One `ITEM` block with four chains is 1 excerpt and ' +
                '4 items; both are right.\n' +
                '3. Only if the units are equal, re-run the query **in the same ' +
                'unit**, show the query you used, and then report the difference.\n' +
                'A divergence is a hypothesis until the unit is matched. Never accuse the previous ' +
                'answer on the strength of a query you wrote differently.',
            pt:
                'Auditoria da resposta anterior. Não reinterprete nem reescreva a análise: ' +
                'levante apenas a EVIDÊNCIA que a sustenta.\n\n' +
                `Pergunta original: ${question}\n\n` +
                `Resposta dada:\n${answer}\n\n` +
                'Consulte o banco e devolva, para cada afirmação sobre o corpus que a resposta ' +
                'fez, os trechos que a sustentam — com `i.citation AS citation`, ' +
                '`i.source_file AS source_file`, `i.source_line AS source_line`, ' +
                '`i.item_id AS item_id`, `s.bibtex AS bibtex`, `s.title AS title` e `s.year AS year`.\n\n' +
                'Se alguma afirmação da resposta anterior **não** tiver trecho que a sustente, ' +
                'diga isso explicitamente: é a informação mais importante desta auditoria.\n\n' +
                'Se a resposta usou busca semântica (proximidade vetorial), diga de qual ' +
                'conceito-semente a proximidade partiu — sem isso o pesquisador não consegue ' +
                'refazer o caminho.\n\n' +
                'Confira quantidades com **uma consulta agregada**, não uma por item: ' +
                '`RETURN s.bibtex, count(DISTINCT c.name)` verifica a distribuição toda de ' +
                'uma vez. Verificar conceito a conceito esgota o orçamento de consultas antes ' +
                'de você concluir a auditoria.\n\n' +
                '**Regra de divergência — obrigatória.** Antes de dizer que um número da ' +
                'resposta anterior está errado:\n' +
                '1. Identifique a UNIDADE dos dois números. Fontes, trechos anotados ' +
                '(`annotation_id`), itens analíticos (`item_id`), menções (arestas ' +
                '`MENTIONS`) e conceitos são unidades DIFERENTES sobre os mesmos dados.\n' +
                '2. Se as unidades forem diferentes, **não há divergência**: diga o que ' +
                'cada número mede e pare. Um bloco `ITEM` com quatro chains é 1 trecho e ' +
                '4 itens; os dois estão certos.\n' +
                '3. Só se as unidades forem iguais, refaça a consulta **na mesma ' +
                'unidade**, mostre a consulta que usou, e então relate a diferença.\n' +
                'Divergência é hipótese até a unidade ser igualada. Nunca acuse a resposta ' +
                'anterior com base numa consulta que você escreveu de outro jeito.'
        }) +
        // As consultas originais entram quando existem: sem elas, "refaça na
        // mesma unidade" é uma instrução que o modelo não tem como cumprir.
        queriesSection(queries)
    );
}

/**
 * As consultas do turno original, para a reavaliação poder repetir a medição.
 *
 * Sem isto, a regra de divergência é inaplicável: o modelo não tem como refazer
 * "a mesma consulta" se nunca a viu. Elas saem do `turnTrace` — o registro do
 * que de fato rodou —, não de uma reconstrução.
 */
function queriesSection(queries) {
    const list = (queries || []).filter(Boolean);
    if (list.length === 0) {
        return '';
    }
    const blocks = list.map((query, index) => `${index + 1}. \`${String(query).trim()}\``).join('\n');
    return pick({
        en: '\n\nQueries the previous answer ran — use these to repeat a ' +
            `measurement in the same unit:\n${blocks}`,
        pt: '\n\nConsultas que a resposta anterior executou — use estas para repetir uma ' +
            `medição na mesma unidade:\n${blocks}`
    });
}

module.exports = {
    traceQueries,
    extractOriginRecords,
    groupByOrigin,
    renderAuditTrail,
    renderTurnReport,
    buildAuditPrompt
};
