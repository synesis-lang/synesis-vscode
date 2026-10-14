/**
 * evidencePrefixedKeys.test.js — evidência com chaves prefixadas pela variável.
 *
 * Turno real (2026-09-28, gpt-oss:20b, banco face85): o modelo seguiu o exemplo
 * do prompt — `RETURN i.citation, i.source_file, … s.bibtex` sem alias —, o
 * banco devolveu 5 linhas com chaves `i.citation`, `s.bibtex`…, e a extensão
 * leu só a chave exata `citation`. Resultado: trilha declarou "não há trechos",
 * âncoras sumiram e — o grave — `verifyCitations` NÃO conferiu nada, porque sem
 * registro de evidência ela não verifica por desenho. Uma citação inventada
 * passaria sem aviso.
 */

const assert = require('assert');
const { parseEvidenceRecords, evidenceGroups } = require('../../src/chat/evidence');
const { verifyCitations } = require('../../src/chat/citationGuard');
const { createTurnTrace, recordToolCall, classifyTurn, rowHasEvidence, TurnKind } = require('../../src/chat/turnTrace');

const VERDADEIRA =
    'Este artigo buscou identificar a relação das percepções de justiça distributiva, procedimental e interacional com o comprometimento organizacional dos servidores do Ministério Público Federal';

/** Formato exato do turno observado: colunas com o prefixo da variável. */
const PAYLOAD_PREFIXADO = JSON.stringify({
    records: [
        {
            'i.citation': VERDADEIRA,
            'i.source_file': 'annotations/costaoliveira2022.syn',
            'i.source_line': 12,
            'i.item_id': 'face85_n0412',
            's.bibtex': 'costaoliveira2022',
            's.title': 'Justiça organizacional e comprometimento',
            's.year': 2022
        }
    ]
});

describe('Evidência com chaves prefixadas (RETURN i.citation sem alias)', () => {
    it('lê o registro com todos os campos, inclusive os da fonte', () => {
        const [record] = parseEvidenceRecords([PAYLOAD_PREFIXADO]);
        assert.ok(record, 'na v0.15.1 nenhum registro era lido');
        assert.strictEqual(record.citation, VERDADEIRA);
        assert.strictEqual(record.sourceFile, 'annotations/costaoliveira2022.syn');
        assert.strictEqual(record.sourceLine, 12);
        assert.strictEqual(record.itemId, 'face85_n0412');
        assert.strictEqual(record.bibtex, 'costaoliveira2022');
        assert.strictEqual(record.year, 2022);
    });

    it('o turno é classificado como evidência, não como template', () => {
        const trace = createTurnTrace({ turnId: 't1', question: 'q', database: 'face85' });
        recordToolCall(trace, { toolName: 'synesis_graph_query', texts: [PAYLOAD_PREFIXADO] });
        assert.strictEqual(classifyTurn(trace), TurnKind.EVIDENCE);
    });

    it('a verificação de citações RODA — e acusa a citação inventada', () => {
        const resposta =
            `“${VERDADEIRA}” — costaoliveira2022\n\n` +
            '“O comprometimento organizacional é o principal preditor de desempenho no setor público mineiro.” — costaoliveira2022';
        const { checked, verified, unverified } = verifyCitations(resposta, [PAYLOAD_PREFIXADO]);

        assert.strictEqual(checked, 2, 'na v0.15.1: checked = 0, nada conferido');
        assert.strictEqual(verified.length, 1);
        assert.strictEqual(unverified.length, 1);
        assert.match(unverified[0], /principal preditor/);
    });

    it('dois trechos na mesma linha viram dois registros, cada um com a fonte', () => {
        // Co-ocorrência: `RETURN i.citation, i.source_line, j.citation, j.source_line, s.bibtex`.
        const payload = JSON.stringify({
            records: [{ 'i.citation': 'trecho do primeiro item', 'i.source_line': 3, 'j.citation': 'trecho do segundo item', 'j.source_line': 9, 's.bibtex': 'rocha2019' }]
        });
        const records = parseEvidenceRecords([payload]);
        assert.deepStrictEqual(
            records.map((r) => [r.citation, r.sourceLine, r.bibtex]),
            [
                ['trecho do primeiro item', 3, 'rocha2019'],
                ['trecho do segundo item', 9, 'rocha2019']
            ]
        );
    });

    it('vértice inteiro (RETURN i, s) também é lido', () => {
        const payload = JSON.stringify({
            records: [{ i: { citation: 'trecho do vértice', item_id: 'face85_c0001', source_file: 'a.syn', source_line: 1 }, s: { bibtex: 'falce2017', year: 2017 } }]
        });
        const [record] = parseEvidenceRecords([payload]);
        assert.strictEqual(record.citation, 'trecho do vértice');
        assert.strictEqual(record.bibtex, 'falce2017');
    });

    it('chave exata vence a prefixada', () => {
        const [group] = evidenceGroups({ citation: 'exata', 'i.citation': 'prefixada' });
        assert.strictEqual(group.citation, 'exata');
    });

    it('expressão não é reinterpretada como campo', () => {
        assert.deepStrictEqual(evidenceGroups({ 'toLower(i.citation)': 'texto' }), []);
        assert.strictEqual(rowHasEvidence({ 'toLower(i.citation)': 'texto' }), false);
    });

    it('linha de contagem continua não sendo evidência', () => {
        assert.deepStrictEqual(evidenceGroups({ 'count(i)': 30 }), []);
        assert.deepStrictEqual(evidenceGroups({ total: 30, 's.year': 2019 }), [], 'só campo de fonte não é trecho');
    });

    it('payload com alias sai idêntico ao formato anterior', () => {
        const row = { citation: 'c', item_id: 'id', bibtex: 'b', title: 't', year: '2019', source_file: 'f.syn', source_line: 4 };
        assert.deepStrictEqual(parseEvidenceRecords([JSON.stringify({ records: [row] })]), [
            { itemId: 'id', citation: 'c', bibtex: 'b', title: 't', year: '2019', sourceFile: 'f.syn', sourceLine: 4 }
        ]);
    });
});
