'use strict';

/**
 * treeAssertions.js — Helpers de asserção para estruturas em árvore.
 *
 * Uso:
 *   const { assertTreeShape, assertOccurrence, assertAllCodesHave } = require('../helpers/treeAssertions');
 *
 *   assertTreeShape(node, { name: 'Epistemology', level: 1 });
 *   assertOccurrence(codes[0].occurrences[0], { context: 'code' });
 */

const { assert } = require('chai');

// ---------------------------------------------------------------------------
// Occurrences
// ---------------------------------------------------------------------------

/**
 * Verifica que uma occurrence tem os campos obrigatórios do shape normalizado.
 * @param {Object} occ
 * @param {Object} [expected] - campos adicionais a verificar
 */
function assertOccurrence(occ, expected = {}) {
    assert.isObject(occ, 'occurrence deve ser um objeto');
    assert.property(occ, 'file');
    assert.property(occ, 'line');

    for (const [key, value] of Object.entries(expected)) {
        assert.equal(occ[key], value, `occurrence.${key}`);
    }
}

/**
 * Verifica que todas as occurrences de todos os itens de um array têm
 * linhas 0-indexed (DataService subtrai 1 da linha LSP).
 */
function assertLinesAreZeroIndexed(items) {
    for (const item of items) {
        for (const occ of (item.occurrences || [])) {
            assert.isAtLeast(occ.line, 0, 'linha deve ser >= 0');
        }
    }
}

// ---------------------------------------------------------------------------
// Tree nodes (ontology topics)
// ---------------------------------------------------------------------------

/**
 * Verifica que um nó de árvore de ontologia tem o shape mínimo.
 * @param {Object} node
 * @param {Object} [expected]
 */
function assertTreeShape(node, expected = {}) {
    assert.isObject(node, 'tree node deve ser um objeto');
    assert.property(node, 'name');
    assert.property(node, 'level');
    assert.isArray(node.children, 'node.children deve ser array');

    for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual(node[key], value, `node.${key}`);
    }
}

/**
 * Verifica recursivamente que todos os nós de uma árvore têm o shape mínimo.
 */
function assertTreeShapeDeep(nodes) {
    for (const node of nodes) {
        assertTreeShape(node);
        if (node.children && node.children.length > 0) {
            assertTreeShapeDeep(node.children);
        }
    }
}

// ---------------------------------------------------------------------------
// Code / Reference arrays
// ---------------------------------------------------------------------------

/**
 * Verifica que todo item de um array de codes tem os campos obrigatórios.
 */
function assertCodeShape(code, expected = {}) {
    assert.isObject(code, 'code deve ser um objeto');
    assert.property(code, 'code');
    assert.property(code, 'usageCount');
    assert.property(code, 'ontologyDefined');
    assert.isArray(code.occurrences, 'code.occurrences deve ser array');

    for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual(code[key], value, `code.${key}`);
    }
}

/**
 * Verifica que todos os codes de um array satisfazem uma predicado.
 * @param {Array} codes
 * @param {Function} predicate - recebe cada code e deve lançar AssertionError se inválido
 */
function assertAllCodesHave(codes, predicate) {
    assert.isArray(codes, 'esperado array de codes');
    for (const code of codes) {
        predicate(code);
    }
}

/**
 * Verifica que um array de referências tem o shape normalizado.
 */
function assertReferenceShape(ref, expected = {}) {
    assert.isObject(ref, 'reference deve ser um objeto');
    assert.property(ref, 'bibref');
    assert.property(ref, 'itemCount');
    assert.isArray(ref.occurrences, 'ref.occurrences deve ser array');

    for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual(ref[key], value, `ref.${key}`);
    }
}

// ---------------------------------------------------------------------------
// Blocks (getBlocks)
// ---------------------------------------------------------------------------

/**
 * Verifica que um bloco tem o shape de getBlocks.
 */
function assertBlockShape(block, expected = {}) {
    assert.isObject(block, 'block deve ser um objeto');
    assert.oneOf(block.kind, ['SOURCE', 'ITEM'], 'block.kind deve ser SOURCE ou ITEM');
    assert.property(block, 'bibref');
    assert.isObject(block.range, 'block.range deve ser objeto');
    assert.property(block.range, 'start');
    assert.property(block.range, 'end');

    for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual(block[key], value, `block.${key}`);
    }
}

module.exports = {
    assertOccurrence,
    assertLinesAreZeroIndexed,
    assertTreeShape,
    assertTreeShapeDeep,
    assertCodeShape,
    assertAllCodesHave,
    assertReferenceShape,
    assertBlockShape
};
