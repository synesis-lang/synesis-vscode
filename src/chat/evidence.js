/**
 * evidence.js — a identidade de uma evidência do corpus.
 *
 * **O defeito que este módulo corrige.** Havia duas leituras do mesmo payload:
 * `citationGuard` concatenava todos os textos das ferramentas num único
 * `haystack` e procurava substrings; `auditTrail` parseava registro a registro e
 * preservava `item_id`, `bibtex`, ano, citação, arquivo e linha. Uma perdia a
 * estrutura, a outra a mantinha.
 *
 * A consequência foi reproduzida: uma citação com um segmento da fonte A e outro
 * da fonte B, unidos por `(...)`, era **aprovada** — porque cada segmento era
 * procurado independentemente no texto combinado de todas as ferramentas. Um
 * recorte que atravessa duas fontes não é recorte, é montagem.
 *
 * Aqui o payload é lido **uma vez**, e cada registro permanece um registro. A
 * verificação passa a perguntar "este trecho existe **neste** campo `citation`?"
 * em vez de "existe em algum lugar do que voltou?".
 *
 * O que continua fora de alcance, e precisa continuar dito: comparação de string
 * não prova que a síntese é implicada pelo trecho. Isto é **literalidade
 * verificada**, não fidelidade.
 */

/** Normalização compartilhada — ver `citationGuard.normalizeForComparison`. */
const { normalizeForComparison } = require('./textNormalize');

/** `i.citation` → variável `i`, campo `citation`. Expressões ficam de fora. */
const PREFIXED_KEY = /^([A-Za-z_]\w*)\.(\w+)$/;

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Um grupo de campos carrega trecho ou identidade de item?
 *
 * Uma linha de contagem (`{count: 20}`) não é evidência de nada — tratá-la como
 * tal foi o que fez o botão de auditoria aparecer em turnos sem trecho algum.
 */
function isEvidence(fields) {
    return Boolean(fields.citation || fields.Citation || fields.item_id || fields.itemId || fields.source_file || fields.sourceFile);
}

function toRecord(fields, source) {
    return {
        itemId: fields.item_id || fields.itemId || '',
        citation: String(fields.citation || fields.Citation || ''),
        bibtex: fields.bibtex || source.bibtex || '',
        title: fields.title || source.title || '',
        year: fields.year || source.year || '',
        sourceFile: String(fields.source_file || fields.sourceFile || ''),
        sourceLine: fields.source_line ?? fields.sourceLine ?? null
    };
}

/**
 * Os registros de evidência de UMA linha de resultado.
 *
 * **Por que não basta ler `row.citation`.** Cypher sem alias nomeia a coluna com
 * a variável: `RETURN i.citation` devolve a chave `i.citation`, no ArcadeDB e no
 * Neo4j. O próprio prompt ensinava essa forma, e a leitura pela chave exata
 * perdia a evidência inteira — com ela, a verificação de citações, que não
 * confere nada quando não há registro (correto para resposta sobre o template).
 * Uma citação inventada passava sem aviso.
 *
 * **Agrupar pelo prefixo, não só removê-lo.** Uma linha de co-ocorrência
 * (`RETURN i.citation, j.citation, s.bibtex`) traz dois trechos; colapsar para
 * uma chave `citation` perderia um, e a citação perdida viraria falso "não
 * confere". Cada variável com trecho vira um registro; campos de fonte
 * (`bibtex`, `title`, `year`) de qualquer variável valem para todos.
 * `RETURN i, s` (vértice inteiro) segue a mesma regra, com a coluna como grupo.
 *
 * **As chaves exatas têm precedência total:** prefixos e vértices só são lidos
 * quando elas não trazem evidência — linha que já era lida continua saindo
 * idêntica.
 */
function evidenceGroups(row) {
    if (!isPlainObject(row)) {
        return [];
    }

    const plain = {};
    const groups = new Map();
    const addTo = (name, field, value) => {
        const group = groups.get(name) || {};
        if (!(field in group)) {
            group[field] = value;
        }
        groups.set(name, group);
    };

    for (const [key, value] of Object.entries(row)) {
        const prefixed = PREFIXED_KEY.exec(key);
        if (prefixed) {
            addTo(prefixed[1], prefixed[2], value);
        } else if (isPlainObject(value)) {
            for (const [field, inner] of Object.entries(value)) {
                addTo(key, field, inner);
            }
        } else {
            plain[key] = value;
        }
    }

    if (isEvidence(plain)) {
        return [toRecord(plain, {})];
    }

    // Fonte da linha: o que as chaves exatas trazem vence, depois a ordem das colunas.
    const source = { bibtex: plain.bibtex, title: plain.title, year: plain.year };
    for (const group of groups.values()) {
        for (const field of ['bibtex', 'title', 'year']) {
            if (!source[field] && group[field]) {
                source[field] = group[field];
            }
        }
    }

    return [...groups.values()].filter(isEvidence).map((group) => toRecord(group, source));
}

/**
 * Lê os registros de evidência de um payload de ferramenta.
 *
 * Tolerante de propósito: o payload é JSON de uma ferramenta externa, e um
 * formato inesperado deve custar a evidência, não a resposta.
 */
function parseEvidenceRecords(toolTexts) {
    const records = [];

    for (const text of toolTexts || []) {
        let payload;
        try {
            payload = JSON.parse(text);
        } catch {
            continue;
        }
        const rows = Array.isArray(payload) ? payload : payload && payload.records;
        if (!Array.isArray(rows)) {
            continue;
        }
        for (const row of rows) {
            records.push(...evidenceGroups(row));
        }
    }

    return records;
}

/**
 * Agrupa registros por origem, atribuindo a cada grupo um `evidenceId` curto.
 *
 * **Um bloco `ITEM` com N chains gera N vértices `Item`**, todos com a mesma
 * citação e a mesma origem — cada chain é uma unidade de análise própria.
 * Repetir a mesma citação N vezes é ruído que corrói a confiança que a trilha
 * existe para construir; uma entrada por origem, dizendo quantas relações saíram
 * dali, diz mais em menos espaço.
 *
 * O `evidenceId` (`E1`, `E2`…) é o que a resposta cita e o que liga afirmação a
 * registro. O pesquisador não precisa ver `face85_c0004`: o marcador curto é
 * resolvido aqui de volta para a referência e a âncora corretas.
 */
function groupEvidence(records) {
    const groups = new Map();

    for (const record of records || []) {
        if (!record) {
            continue;
        }
        // Aceita tanto a forma normalizada por `parseEvidenceRecords` quanto a
        // linha crua do MCP. Os dois formatos circulam: o parser é o caminho
        // normal, mas agrupar registros crus é útil em teste e mantém a função
        // utilizável isoladamente — e exigir a normalização antes seria uma
        // pegadinha silenciosa, do tipo que devolve lista vazia sem erro.
        const file = record.sourceFile || record.source_file || '';
        const line = record.sourceLine ?? record.source_line ?? null;
        const citation = record.citation || '';
        const itemId = record.itemId || record.item_id || '';

        // Sem origem gravada (grafo anterior à Etapa A), a citação ainda
        // identifica o trecho — melhor agrupar por ela do que perder a entrada.
        const key = file && line !== null ? `${file}:${line}` : `cit:${citation.slice(0, 80)}`;

        const existing = groups.get(key);
        if (existing) {
            existing.count += 1;
            if (itemId) {
                existing.itemIds.push(itemId);
            }
            continue;
        }

        groups.set(key, {
            evidenceId: `E${groups.size + 1}`,
            file,
            line,
            citation,
            bibtex: record.bibtex || '',
            year: record.year || '',
            title: record.title || '',
            count: 1,
            itemIds: itemId ? [itemId] : []
        });
    }

    return [...groups.values()];
}

/**
 * Uma citação está contida **num único** registro?
 *
 * É aqui que a mudança desta etapa se materializa. Os segmentos separados por
 * reticências precisam existir:
 *
 * - no **mesmo** campo `citation` — não espalhados por fontes diferentes;
 * - **na mesma ordem** em que a resposta os apresenta.
 *
 * A ordem importa porque um recorte legítimo preserva a sequência do original.
 * Dois trechos reais do mesmo parágrafo, apresentados invertidos, mudam o que o
 * autor disse — e passavam pela verificação anterior.
 */
function citationMatchesRecord(quote, recordCitation) {
    const needle = normalizeForComparison(quote);
    const haystack = normalizeForComparison(recordCitation);
    if (!needle || !haystack) {
        return false;
    }

    const segments = needle
        .split(/\s*\(?\.\.\.\)?\s*/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 12);

    const parts = segments.length ? segments : [needle];

    // Varredura da esquerda para a direita: cada segmento precisa aparecer
    // DEPOIS do anterior. `indexOf` a partir do cursor é o que impõe a ordem.
    let cursor = 0;
    for (const part of parts) {
        const at = haystack.indexOf(part, cursor);
        if (at === -1) {
            return false;
        }
        cursor = at + part.length;
    }
    return true;
}

/**
 * Encontra o registro que sustenta uma citação, se houver exatamente um campo
 * `citation` que a contenha.
 *
 * Devolve o registro, ou `undefined` quando nenhum a contém — que é o caso que
 * o aviso reporta.
 */
function findSupportingRecord(quote, records) {
    for (const record of records || []) {
        if (citationMatchesRecord(quote, record.citation)) {
            return record;
        }
    }
    return undefined;
}

module.exports = {
    evidenceGroups,
    parseEvidenceRecords,
    groupEvidence,
    citationMatchesRecord,
    findSupportingRecord
};
