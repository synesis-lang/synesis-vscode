const { pick } = require('./promptLanguage');
/**
 * lexicalCapability.js — busca por palavra, quando o grafo declara ter o índice.
 *
 * **O que isto substitui (Etapa 6).** O prompt mandava o modelo cortar o termo
 * antes do primeiro caractere com diacrítico e buscar só o radical, porque
 * `CONTAINS 'psicologicos'` não encontra `psicológicos`. Era um paliativo
 * frágil: dependia do idioma, da posição do acento, e de o modelo executar
 * corretamente uma transformação textual de cabeça — três formas de falhar em
 * silêncio, e a falha aparecia como "este conceito não existe no corpus".
 *
 * O `synesis-graph` já resolvia isso deterministicamente: cria índices full-text
 * com analyzer por idioma (`brazilian`, `english`, `german`…), e o teste de
 * integração comprova que `SEARCH_INDEX(..., "governanca")` encontra
 * `governança_corporativa`. O chat não usava porque **não sabia que existiam** —
 * o `get_schema` mostra propriedades, não índices.
 *
 * Agora o `ProjectContext` declara os campos e o analyzer, e a instrução vira
 * uma consulta em vez de uma heurística.
 *
 * **Condicional, como todas as capacidades.** Um grafo antigo, ou um backend
 * Neo4j — cuja sintaxe é `db.index.fulltext.queryNodes`, não `SEARCH_INDEX` —
 * não recebe esta seção e continua com `CONTAINS`.
 */

/** Os campos declarados, como `SEARCH_INDEX` espera vê-los. */
function indexName(typeName, fields) {
    const list = String(fields || '')
        .split(',')
        .map((field) => field.trim())
        .filter(Boolean);
    return list.length ? `${typeName}[${list.join(', ')}]` : '';
}

/**
 * Este analyzer dobra acento e aplica stemming?
 *
 * `StandardAnalyzer` — o padrão — não faz nenhum dos dois. Apresentar a busca
 * como insensível a acento nesse caso seria errado, e o modelo não tem outra
 * forma de descobrir: a diferença só aparece no resultado da consulta, quando
 * já é tarde.
 */
function foldsAccents(analyzer) {
    const name = String(analyzer || '');
    return Boolean(name) && !/standard/i.test(name);
}

function renderLexicalCapability(context) {
    const conceptFields = (context && context.fulltextConceptFields) || '';
    const itemFields = (context && context.fulltextItemFields) || '';
    const sourceFields = (context && context.fulltextSourceFields) || '';
    if (!conceptFields && !itemFields && !sourceFields) {
        return undefined;
    }

    const label = (context && context.conceptLabel) || 'Chain';
    const analyzer = (context && context.fulltextAnalyzer) || '';

    const conceptIndex = indexName(label, conceptFields);
    const itemIndex = indexName('Item', itemFields);
    const sourceIndex = indexName('Source', sourceFields);

    const lines = [
        pick({
            en: 'Lexical (full-text) search available in this database:',
            pt: 'Busca lexical (full-text) disponível neste banco:'
        })
    ];
    if (conceptIndex) {
        lines.push(`- ${pick({ en: 'concepts', pt: 'conceitos' })}: \`${conceptIndex}\``);
    }
    if (itemIndex) {
        lines.push(`- ${pick({ en: 'excerpts', pt: 'trechos' })}: \`${itemIndex}\``);
    }
    if (sourceIndex) {
        lines.push(`- ${pick({ en: 'references', pt: 'referências' })}: \`${sourceIndex}\``);
    }
    if (analyzer) {
        lines.push(`- analyzer \`${analyzer}\``);
    }

    // O índice é endereçado pelo NOME EXATO — um índice composto inclui todos os
    // seus campos. Sem isso, o modelo tentaria `SEARCH_INDEX('Chain', ...)` e a
    // consulta falharia.
    const seed = conceptIndex || itemIndex || sourceIndex;
    const seedType = conceptIndex ? label : itemIndex ? 'Item' : 'Source';
    lines.push(
        pick({
            en: '- The query is SQL (`language: "sql"`), and the index is addressed by the exact name ' +
                'above — a composite index covers all of its fields:',
            pt: '- A consulta é SQL (`language: "sql"`), e o índice é endereçado pelo nome exato ' +
                'acima — um índice composto inclui todos os seus campos:'
        })
    );
    lines.push('```sql');
    lines.push(
        `SELECT name FROM ${seedType} WHERE SEARCH_INDEX('${seed}', '${pick({ en: 'term', pt: 'termo' })}') = true`
    );
    lines.push('```');

    if (foldsAccents(analyzer)) {
        lines.push(
            pick({
                en: '- **This analyzer folds accents and applies stemming**: searching `psicologicos` ' +
                    'finds `psicológicos`, and `governanca` finds `governança`. Use ' +
                    '`SEARCH_INDEX` when the term has an accent or may vary in form — ' +
                    'do not cut the term by hand.',
                pt: '- **Este analyzer dobra acento e aplica stemming**: buscar `psicologicos` ' +
                    'encontra `psicológicos`, e `governanca` encontra `governança`. Use ' +
                    '`SEARCH_INDEX` quando o termo tiver acento ou puder variar de forma — ' +
                    'não corte o termo à mão.'
            })
        );
    } else {
        lines.push(
            pick({
                en: '- This analyzer does **not** fold accents nor apply stemming: `psicologicos` does not ' +
                    'find `psicológicos`. For an accented term, use the longest prefix without a ' +
                    'diacritic with `CONTAINS`.',
                pt: '- Este analyzer **não** dobra acento nem aplica stemming: `psicologicos` não ' +
                    'encontra `psicológicos`. Para termo acentuado, use o maior prefixo sem ' +
                    'diacrítico com `CONTAINS`.'
            })
        );
    }

    lines.push(
        pick({
            en: '- `CONTAINS` still serves to match part of an exact name; `SEARCH_INDEX` ' +
                'is word search over text. They complement each other.',
            pt: '- `CONTAINS` continua servindo para casar parte de um nome exato; `SEARCH_INDEX` ' +
                'é busca por palavra sobre texto. São complementares.'
        })
    );

    return lines.join('\n');
}

module.exports = { renderLexicalCapability, indexName, foldsAccents };
