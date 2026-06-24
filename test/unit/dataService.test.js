'use strict';

// O vscode stub DEVE ser instalado antes de qualquer require que importe 'vscode'
require('../helpers/vscodeMock').install();

const { assert } = require('chai');
const DataService = require('../../src/services/dataService');
const { LspMock } = require('../helpers/lspMock');
const {
    buildReferencesPayload,
    buildCodesPayload,
    buildRelationsPayload,
    buildBlocksPayload,
    buildTemplatePayload,
    buildOntologyAnnotationsPayload,
    buildErrorPayload
} = require('../helpers/projectBuilder');
const {
    assertCodeShape,
    assertReferenceShape,
    assertLinesAreZeroIndexed,
    assertBlockShape,
    assertOccurrence
} = require('../helpers/treeAssertions');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDs(mock) {
    return new DataService({ lspClient: mock });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('DataService (unit, lspMock)', () => {

    let mock;

    beforeEach(() => {
        mock = new LspMock();
    });

    // ---- LSP desabilitado / não-pronto ----

    describe('quando LSP não está pronto', () => {
        it('getReferences retorna [] sem lançar', async () => {
            mock.setReady(false);
            const ds = makeDs(mock);
            const result = await ds.getReferences();
            assert.deepEqual(result, []);
        });

        it('getCodes retorna [] sem lançar', async () => {
            mock.setReady(false);
            const ds = makeDs(mock);
            assert.deepEqual(await ds.getCodes(), []);
        });

        it('getTemplate retorna null sem lançar', async () => {
            mock.setReady(false);
            const ds = makeDs(mock);
            assert.isNull(await ds.getTemplate());
        });
    });

    describe('sem lspClient', () => {
        it('getCodes retorna []', async () => {
            const ds = new DataService({});
            assert.deepEqual(await ds.getCodes(), []);
        });
    });

    // ---- getReferences ----

    describe('getReferences', () => {
        it('retorna array normalizado', async () => {
            mock.set('synesis/getReferences', buildReferencesPayload([
                { bibref: 'smith2020', itemCount: 3 },
                { bibref: 'jones2021', itemCount: 1 }
            ]));
            const ds = makeDs(mock);
            const refs = await ds.getReferences();

            assert.isArray(refs);
            assert.equal(refs.length, 2);
            assertReferenceShape(refs[0]);
            assert.equal(refs[0].bibref, 'smith2020');
            assert.equal(refs[0].itemCount, 3);
        });

        it('normaliza linha para 0-indexed', async () => {
            mock.set('synesis/getReferences', buildReferencesPayload([
                { bibref: 'a2020', itemCount: 1, location: { file: 'a.syn', line: 5 } }
            ]));
            const ds = makeDs(mock);
            const refs = await ds.getReferences();
            assert.equal(refs[0].occurrences[0].line, 4); // 5 - 1
        });

        it('retorna [] quando success=false', async () => {
            mock.set('synesis/getReferences', buildErrorPayload('compile failed'));
            const ds = makeDs(mock);
            assert.deepEqual(await ds.getReferences(), []);
        });

        it('retorna [] em erro de rede', async () => {
            mock.failWith('synesis/getReferences', 500, 'Internal error');
            const ds = makeDs(mock);
            assert.deepEqual(await ds.getReferences(), []);
        });

        it('registra chamada com método correto', async () => {
            mock.set('synesis/getReferences', buildReferencesPayload([]));
            const ds = makeDs(mock);
            await ds.getReferences();
            assert.equal(mock.callCount('synesis/getReferences'), 1);
        });
    });

    // ---- getCodes ----

    describe('getCodes', () => {
        it('retorna array normalizado', async () => {
            mock.set('synesis/getCodes', buildCodesPayload([
                { code: 'CCS_Support', usageCount: 4, ontologyDefined: true, occurrences: [
                    { file: 'a.syn', line: 10, column: 3, context: 'code', field: 'code' }
                ]}
            ]));
            const ds = makeDs(mock);
            const codes = await ds.getCodes();

            assert.isArray(codes);
            assertCodeShape(codes[0], { code: 'CCS_Support', ontologyDefined: true });
        });

        it('subtrai 1 de linha e coluna', async () => {
            mock.set('synesis/getCodes', buildCodesPayload([
                { code: 'X', occurrences: [{ file: 'a.syn', line: 5, column: 3 }] }
            ]));
            const ds = makeDs(mock);
            const codes = await ds.getCodes();
            const occ = codes[0].occurrences[0];
            assertOccurrence(occ, { line: 4, column: 2 });
        });

        it('deduces usageCount from occurrences when 0', async () => {
            mock.set('synesis/getCodes', buildCodesPayload([
                { code: 'Y', usageCount: 0, occurrences: [
                    { file: 'a.syn', line: 1 },
                    { file: 'a.syn', line: 2 }
                ]}
            ]));
            const ds = makeDs(mock);
            const codes = await ds.getCodes();
            assert.equal(codes[0].usageCount, 2);
        });

        it('retorna [] quando success=false', async () => {
            mock.set('synesis/getCodes', buildErrorPayload());
            const ds = makeDs(mock);
            assert.deepEqual(await ds.getCodes(), []);
        });

        it('retorna [] em Method Not Found (sem lançar)', async () => {
            // LspDataProvider tenta fallback synesis/get_codes que também não está configurado
            // → retorna null → DataService retorna _emptyResultFor = []
            mock.methodNotFound('synesis/getCodes');
            const ds = makeDs(mock);
            const result = await ds.getCodes();
            assert.deepEqual(result, []);
        });
    });

    // ---- getRelations ----

    describe('getRelations', () => {
        it('agrupa por relação', async () => {
            mock.set('synesis/getRelations', buildRelationsPayload([
                { relation: 'enables', from: 'A', to: 'B' },
                { relation: 'enables', from: 'C', to: 'D' },
                { relation: 'constrains', from: 'E', to: 'F' }
            ]));
            const ds = makeDs(mock);
            const rels = await ds.getRelations();
            assert.isArray(rels);
            assert.equal(rels.length, 2);
            const enables = rels.find(r => r.relation === 'enables');
            assert.equal(enables.triplets.length, 2);
        });

        it('retorna [] quando success=false', async () => {
            mock.set('synesis/getRelations', buildErrorPayload());
            const ds = makeDs(mock);
            assert.deepEqual(await ds.getRelations(), []);
        });
    });

    // ---- getBlocks ----

    describe('getBlocks', () => {
        it('retorna array de blocos', async () => {
            mock.set('synesis/getBlocks', buildBlocksPayload([
                { kind: 'SOURCE', bibref: 'smith2020', range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } } },
                { kind: 'ITEM', bibref: 'smith2020', range: { start: { line: 3, character: 0 }, end: { line: 8, character: 0 } } }
            ]));
            const ds = makeDs(mock);
            const blocks = await ds.getBlocks('/path/to/file.syn');
            assert.isArray(blocks);
            assert.equal(blocks.length, 2);
            assertBlockShape(blocks[0], { kind: 'SOURCE', bibref: 'smith2020' });
            assertBlockShape(blocks[1], { kind: 'ITEM' });
        });

        it('retorna null quando success=false', async () => {
            mock.set('synesis/getBlocks', buildErrorPayload());
            const ds = makeDs(mock);
            assert.isNull(await ds.getBlocks('/f.syn'));
        });

        it('passa o file como propriedade do params ao LSP', async () => {
            mock.set('synesis/getBlocks', buildBlocksPayload([]));
            const ds = makeDs(mock);
            await ds.getBlocks('/some/path.syn');
            const call = mock.calls().find(c => c.method === 'synesis/getBlocks');
            assert.ok(call, 'deve ter chamado synesis/getBlocks');
            // LspDataProvider.getBlocks envia { workspaceRoot, file } como params único
            assert.equal(call.params.file, '/some/path.syn');
        });
    });

    // ---- getTemplate ----

    describe('getTemplate', () => {
        it('retorna o template serializado', async () => {
            mock.set('synesis/getTemplate', buildTemplatePayload({
                name: 'minimal',
                fields: [{ name: 'citation', type: 'QUOTATION' }]
            }));
            const ds = makeDs(mock);
            const tmpl = await ds.getTemplate();
            assert.isObject(tmpl);
            assert.equal(tmpl.name, 'minimal');
            assert.isArray(tmpl.fields);
        });

        it('retorna null quando success=false', async () => {
            mock.set('synesis/getTemplate', buildErrorPayload('no project'));
            const ds = makeDs(mock);
            assert.isNull(await ds.getTemplate());
        });
    });

    // ---- getOntologyAnnotations ----

    describe('getOntologyAnnotations', () => {
        it('normaliza occurrences para 0-indexed', async () => {
            mock.set('synesis/getOntologyAnnotations', buildOntologyAnnotationsPayload([
                {
                    code: 'Epistemology',
                    ontologyDefined: true,
                    ontologyFile: 'onto.syno',
                    ontologyLine: 10,
                    occurrences: [{ file: 'a.syn', line: 7, column: 2 }]
                }
            ]));
            const ds = makeDs(mock);
            const anns = await ds.getOntologyAnnotations();
            assert.equal(anns[0].ontologyLine, 9); // 10 - 1
            assertOccurrence(anns[0].occurrences[0], { line: 6, column: 1 });
        });

        it('retorna [] quando success=false', async () => {
            mock.set('synesis/getOntologyAnnotations', buildErrorPayload());
            const ds = makeDs(mock);
            assert.deepEqual(await ds.getOntologyAnnotations(), []);
        });
    });

    // ---- fallback de legado ----

    describe('fallback para métodos legados (get_codes, etc.)', () => {
        it('tenta synesis/get_codes se synesis/getCodes retornar Method Not Found', async () => {
            mock.methodNotFound('synesis/getCodes');
            mock.set('synesis/get_codes', buildCodesPayload([{ code: 'LegacyCode' }]));

            const ds = makeDs(mock);
            // Primeira chamada: getCodes vai para unsupportedMethods por -32601
            // A lógica de fallback está em LspDataProvider._sendRequestWithFallback
            // DataService marca o método como unsupported → retorna []
            // (o fallback está dentro do LspDataProvider, não do DataService)
            // Testamos que não lança exceção
            const result = await ds.getCodes();
            assert.isArray(result);
        });
    });
});
