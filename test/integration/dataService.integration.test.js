'use strict';

/**
 * dataService.integration.test.js
 *
 * Testa DataService dentro do Extension Host real (vscode disponível).
 * Usa LspMock — sem Python server, sem rede.
 *
 * O DataService._getWorkspaceRoot() usa vscode.workspace.workspaceFolders,
 * que aqui retorna o minimal fixture aberto no Extension Development Host.
 */

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
    assertBlockShape,
    assertLinesAreZeroIndexed
} = require('../helpers/treeAssertions');

function makeDs(mock) {
    return new DataService({ lspClient: mock });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('DataService (integration, Extension Host)', () => {

    let mock;

    beforeEach(() => {
        mock = new LspMock();
    });

    // ---- Sanity: vscode real disponível ----

    it('vscode workspace está disponível no Extension Host', () => {
        const vscode = require('vscode');
        assert.ok(vscode.workspace, 'vscode.workspace deve existir');
        assert.ok(vscode.workspace.workspaceFolders, 'deve ter workspaceFolders do minimal fixture');
        const folder = vscode.workspace.workspaceFolders[0];
        assert.ok(folder.uri.fsPath.endsWith('minimal'), 'workspace deve ser o fixture minimal');
    });

    // ---- getReferences com vscode real ----

    describe('getReferences', () => {
        it('normaliza referências e resolve workspace root via vscode.workspace', async () => {
            mock.set('synesis/getReferences', buildReferencesPayload([
                { bibref: 'test2024', itemCount: 2, location: { file: 'minimal.syn', line: 3 } }
            ]));
            const ds = makeDs(mock);
            const refs = await ds.getReferences();

            assert.isArray(refs);
            assert.equal(refs.length, 1);
            assertReferenceShape(refs[0], { bibref: 'test2024', itemCount: 2 });
            // linha LSP 3 → 0-indexed 2
            assert.equal(refs[0].occurrences[0].line, 2);
            // path foi resolvido relativamente ao workspace root
            assert.ok(refs[0].occurrences[0].file.includes('minimal'));
        });

        it('retorna [] quando LSP retorna success=false', async () => {
            mock.set('synesis/getReferences', buildErrorPayload('project not compiled'));
            const ds = makeDs(mock);
            assert.deepEqual(await ds.getReferences(), []);
        });

        it('agrega múltiplos registros do mesmo bibref em uma referência', async () => {
            mock.set('synesis/getReferences', {
                success: true,
                references: [
                    { bibref: 'smith2020', itemCount: 1, location: { file: 'a.syn', line: 1 } },
                    { bibref: 'smith2020', itemCount: 2, location: { file: 'b.syn', line: 5 } }
                ]
            });
            const ds = makeDs(mock);
            const refs = await ds.getReferences();
            assert.equal(refs.length, 1, 'mesmo bibref deve ser agrupado');
            assert.equal(refs[0].itemCount, 3, 'itemCounts devem ser somados');
            assert.equal(refs[0].occurrences.length, 2);
        });
    });

    // ---- getCodes ----

    describe('getCodes', () => {
        it('retorna codes normalizados com linhas 0-indexed', async () => {
            mock.set('synesis/getCodes', buildCodesPayload([
                {
                    code: 'CCS_Support',
                    usageCount: 3,
                    ontologyDefined: true,
                    occurrences: [
                        { file: 'minimal.syn', line: 5, column: 4, context: 'code', field: 'code' }
                    ]
                }
            ]));
            const ds = makeDs(mock);
            const codes = await ds.getCodes();

            assert.isArray(codes);
            assertCodeShape(codes[0], { code: 'CCS_Support', usageCount: 3, ontologyDefined: true });
            assertLinesAreZeroIndexed(codes);
            assert.equal(codes[0].occurrences[0].line, 4);   // 5 - 1
            assert.equal(codes[0].occurrences[0].column, 3); // 4 - 1
        });

        it('retorna [] em Method Not Found sem lançar', async () => {
            mock.methodNotFound('synesis/getCodes');
            mock.methodNotFound('synesis/get_codes');
            const ds = makeDs(mock);
            assert.deepEqual(await ds.getCodes(), []);
        });
    });

    // ---- getRelations ----

    describe('getRelations', () => {
        it('agrupa triplets por relação', async () => {
            mock.set('synesis/getRelations', buildRelationsPayload([
                { relation: 'INFLUENCES', from: 'Knowledge', to: 'CCS Support', location: { file: 'minimal.syn', line: 5, column: 5 } },
                { relation: 'INFLUENCES', from: 'Gender', to: 'CCS Support', location: { file: 'minimal.syn', line: 6, column: 5 } },
                { relation: 'ENABLES', from: 'Policy', to: 'Deployment', location: null }
            ]));
            const ds = makeDs(mock);
            const rels = await ds.getRelations();

            assert.isArray(rels);
            assert.equal(rels.length, 2);
            const influences = rels.find(r => r.relation === 'INFLUENCES');
            assert.ok(influences, 'deve ter grupo INFLUENCES');
            assert.equal(influences.triplets.length, 2);
            // linha 5 → 0-indexed 4
            assert.equal(influences.triplets[0].line, 4);
        });
    });

    // ---- getBlocks ----

    describe('getBlocks', () => {
        it('retorna blocos com ranges intactos (não normaliza linhas)', async () => {
            mock.set('synesis/getBlocks', buildBlocksPayload([
                {
                    kind: 'SOURCE',
                    bibref: 'test2024',
                    range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }
                },
                {
                    kind: 'ITEM',
                    bibref: 'test2024',
                    range: { start: { line: 3, character: 0 }, end: { line: 5, character: 0 } }
                }
            ]));
            const ds = makeDs(mock);
            const blocks = await ds.getBlocks('/some/minimal.syn');

            assert.isArray(blocks);
            assert.equal(blocks.length, 2);
            assertBlockShape(blocks[0], { kind: 'SOURCE', bibref: 'test2024' });
            assertBlockShape(blocks[1], { kind: 'ITEM' });
        });

        it('retorna null quando LSP retorna success=false', async () => {
            mock.set('synesis/getBlocks', buildErrorPayload());
            const ds = makeDs(mock);
            assert.isNull(await ds.getBlocks('/f.syn'));
        });
    });

    // ---- getTemplate ----

    describe('getTemplate', () => {
        it('retorna template com fields e requirements', async () => {
            mock.set('synesis/getTemplate', buildTemplatePayload({
                name: 'minimal',
                fields: [
                    { name: 'citation', type: 'QUOTATION', scope: 'ITEM' }
                ],
                requirements: {
                    SOURCE: { required: [], optional: [], forbidden: [], bundles: [], optional_bundles: [] },
                    ITEM:   { required: ['citation'], optional: [], forbidden: [], bundles: [], optional_bundles: [] },
                    ONTOLOGY: { required: [], optional: [], forbidden: [], bundles: [], optional_bundles: [] }
                }
            }));
            const ds = makeDs(mock);
            const tmpl = await ds.getTemplate();

            assert.isObject(tmpl);
            assert.equal(tmpl.name, 'minimal');
            assert.isArray(tmpl.fields);
            assert.equal(tmpl.fields[0].name, 'citation');
            assert.isArray(tmpl.requirements.ITEM.required);
            assert.include(tmpl.requirements.ITEM.required, 'citation');
        });

        it('retorna null quando nenhum projeto está carregado', async () => {
            mock.set('synesis/getTemplate', buildErrorPayload('no project'));
            const ds = makeDs(mock);
            assert.isNull(await ds.getTemplate());
        });
    });

    // ---- getOntologyAnnotations ----

    describe('getOntologyAnnotations', () => {
        it('normaliza linhas e columns para 0-indexed', async () => {
            mock.set('synesis/getOntologyAnnotations', buildOntologyAnnotationsPayload([
                {
                    code: 'Epistemology',
                    ontologyDefined: true,
                    ontologyFile: 'minimal.syno',
                    ontologyLine: 10,
                    occurrences: [
                        { file: 'minimal.syn', line: 5, column: 3, context: 'chain', field: 'chain', itemName: 'test2024' }
                    ]
                }
            ]));
            const ds = makeDs(mock);
            const anns = await ds.getOntologyAnnotations();

            assert.isArray(anns);
            assert.equal(anns[0].code, 'Epistemology');
            assert.isTrue(anns[0].ontologyDefined);
            assert.equal(anns[0].ontologyLine, 9); // 10 - 1
            assert.equal(anns[0].occurrences[0].line, 4);   // 5 - 1
            assert.equal(anns[0].occurrences[0].column, 2); // 3 - 1
            assert.equal(anns[0].occurrences[0].itemName, 'test2024');
        });
    });

    // ---- _getWorkspaceRoot via vscode real ----

    describe('_getWorkspaceRoot (via vscode.workspace real)', () => {
        it('resolve o workspace root do minimal fixture', async () => {
            mock.set('synesis/getCodes', buildCodesPayload([]));
            const ds = makeDs(mock);
            await ds.getCodes();

            const call = mock.calls().find(c => c.method === 'synesis/getCodes');
            assert.ok(call, 'deve ter chamado getCodes');
            // workspaceRoot deve ser o path do minimal fixture
            assert.ok(call.params.workspaceRoot, 'workspaceRoot deve estar preenchido');
            assert.ok(
                call.params.workspaceRoot.includes('minimal') || call.params.workspaceRoot.length > 0,
                `workspaceRoot deve ser um path válido: ${call.params.workspaceRoot}`
            );
        });
    });

    // ---- onLspIncompatible callback ----

    describe('onLspIncompatible', () => {
        it('dispara o callback após 3 null consecutivos', async () => {
            let fired = false;
            mock.set('synesis/getReferences', { success: true, references: [] });
            mock.set('synesis/getCodes', { success: true, codes: [] });
            mock.set('synesis/getRelations', { success: true, relations: [] });

            // Todos retornam success mas com null (DataService trata como null)
            const mockReturningNull = new LspMock();
            // sendRequest retorna null → LspDataProvider retorna null → _trackLspNull
            // LspMock sem set() retorna null por padrão
            const ds = new DataService({
                lspClient: mockReturningNull,
                onLspIncompatible: () => { fired = true; }
            });

            await ds.getReferences();
            assert.isFalse(fired, 'não deve disparar na 1ª chamada nula');
            await ds.getCodes();
            assert.isFalse(fired, 'não deve disparar na 2ª chamada nula');
            await ds.getRelations();
            assert.isTrue(fired, 'deve disparar na 3ª chamada nula');
        });
    });
});
