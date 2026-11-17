'use strict';

// Arvore da hierarquia no explorador de ontologia (etapa A2d do plano ROLE/EXPORT).
require('../helpers/vscodeMock').install();

const { assert } = require('chai');
const { LspDataProvider } = require('../../src/services/dataService');

describe('DataService: arvore da hierarquia', () => {
    const ds = new LspDataProvider({});

    it('mantem especie, contagens e fundamentacao dos nos', () => {
        const node = ds._normalizeTopic({
            name: 'phishing', level: 1, file: 'ontologia.syno', line: 37,
            species: 'KIND', items: 2, itemsSubtree: 4, ungrounded: false,
            children: [{ name: 'spear_phishing', level: 2, file: 'ontologia.syno', line: 74,
                         species: 'KIND', items: 0, itemsSubtree: 0, ungrounded: true, children: [] }]
        }, '');
        assert.equal(node.species, 'KIND');
        assert.equal(node.itemsSubtree, 4);
        assert.equal(node.line, 36, 'linha 1-based do LSP vira 0-based');
        assert.isTrue(node.children[0].ungrounded);
    });

    it('um no de topico (sem hierarquia) nao ganha os campos novos', () => {
        const node = ds._normalizeTopic({ name: 'canais', level: 0, file: 'o.syno', line: 1, children: [] }, '');
        assert.notProperty(node, 'itemsSubtree');
    });
});
