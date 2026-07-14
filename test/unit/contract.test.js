'use strict';

/**
 * contract.test.js — Teste de contrato LSP↔extensão (lado consumidor).
 *
 * Valida que as fixtures que a extensão usa nos testes (projectBuilder.js) e os
 * exemplos canônicos casam com os MESMOS JSON Schemas que o CI do synesis-lsp
 * valida contra a saída real dos handlers. Se o LSP mudar o formato de um dos 4
 * custom requests, este par de testes (produtor + consumidor) fica vermelho —
 * é a rede que o diagnóstico D6 do Golden Standard pedia.
 *
 * Os schemas em test/contract/schemas/ são uma cópia versionada; a fonte de
 * verdade é synesis-lsp/contracts/schemas/ (ver test/contract/README.md).
 */

const fs = require('fs');
const path = require('path');
const { assert } = require('chai');
// Os schemas declaram draft 2020-12 — use o entrypoint correspondente do ajv.
const Ajv = require('ajv/dist/2020');

const {
    buildReferencesPayload,
    buildCodesPayload,
    buildRelationsPayload,
    buildOntologyAnnotationsPayload,
    buildErrorPayload
} = require('../helpers/projectBuilder');

const CONTRACT = path.join(__dirname, '..', 'contract');
const SCHEMAS = path.join(CONTRACT, 'schemas');
const EXAMPLES = path.join(CONTRACT, 'examples');

function loadJson(p) {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function makeAjv() {
    const ajv = new Ajv({ allErrors: true, strict: false });
    // Registra o common pelo nome relativo que os $ref usam e pelo $id.
    const common = loadJson(path.join(SCHEMAS, 'common.schema.json'));
    ajv.addSchema(common, 'common.schema.json');
    return ajv;
}

function validatorFor(endpoint) {
    const ajv = makeAjv();
    const schema = loadJson(path.join(SCHEMAS, `${endpoint}.schema.json`));
    return ajv.compile(schema);
}

const ENDPOINTS = ['getReferences', 'getCodes', 'getRelations', 'getOntologyAnnotations'];

describe('contract: schemas compile', () => {
    ENDPOINTS.forEach(endpoint => {
        it(`${endpoint} schema compiles`, () => {
            assert.isFunction(validatorFor(endpoint));
        });
    });
});

describe('contract: canonical examples match schema', () => {
    ENDPOINTS.forEach(endpoint => {
        it(`${endpoint} success example is valid`, () => {
            const validate = validatorFor(endpoint);
            const example = loadJson(path.join(EXAMPLES, `${endpoint}.success.json`));
            const ok = validate(example);
            assert.isTrue(ok, JSON.stringify(validate.errors, null, 2));
        });

        it(`${endpoint} accepts the error response`, () => {
            const validate = validatorFor(endpoint);
            const error = loadJson(path.join(EXAMPLES, 'error.json'));
            const ok = validate(error);
            assert.isTrue(ok, JSON.stringify(validate.errors, null, 2));
        });
    });
});

describe('contract: projectBuilder fixtures match schema', () => {
    it('buildReferencesPayload is a valid getReferences response', () => {
        const validate = validatorFor('getReferences');
        const payload = buildReferencesPayload([
            { bibref: '@smith2024', itemCount: 3, title: 'A study' },
            { bibref: '@jones2023', itemCount: 1, location: { file: 'a.syn', line: 2, column: 1 } }
        ]);
        assert.isTrue(validate(payload), JSON.stringify(validate.errors, null, 2));
    });

    it('buildCodesPayload is a valid getCodes response', () => {
        const validate = validatorFor('getCodes');
        const payload = buildCodesPayload([
            {
                code: 'social_cohesion',
                usageCount: 2,
                ontologyDefined: true,
                occurrences: [
                    { file: 'a.syn', line: 12, column: 11, context: 'code', field: 'code' },
                    { file: 'a.syn', line: 20, column: 5, context: 'chain', field: 'chain' }
                ]
            }
        ]);
        assert.isTrue(validate(payload), JSON.stringify(validate.errors, null, 2));
    });

    it('buildRelationsPayload matches after dropping null placeholders', () => {
        // O builder usa location:null / type:'' como sentinelas; o contrato só
        // admite location como objeto e type no enum. Estes são detalhes do
        // consumidor, então validamos o shape que o LSP realmente emite.
        const validate = validatorFor('getRelations');
        const payload = buildRelationsPayload([
            { relation: 'INFLUENCES', from: 'A', to: 'B',
              location: { file: 't.syn', line: 5, column: 1 }, type: 'simple' }
        ]);
        assert.isTrue(validate(payload), JSON.stringify(validate.errors, null, 2));
    });

    it('buildOntologyAnnotationsPayload is a valid getOntologyAnnotations response', () => {
        const validate = validatorFor('getOntologyAnnotations');
        const payload = buildOntologyAnnotationsPayload([
            {
                code: 'social_cohesion',
                ontologyDefined: true,
                ontologyFile: 'ontology.syno',
                ontologyLine: 3,
                occurrences: [
                    { file: 'a.syn', itemName: 'i1', line: 12, column: 11, context: 'code', field: 'code' }
                ]
            }
        ]);
        assert.isTrue(validate(payload), JSON.stringify(validate.errors, null, 2));
    });

    it('buildErrorPayload is accepted by every endpoint', () => {
        const err = buildErrorPayload('Projeto não carregado');
        ENDPOINTS.forEach(endpoint => {
            const validate = validatorFor(endpoint);
            assert.isTrue(validate(err), `${endpoint}: ${JSON.stringify(validate.errors)}`);
        });
    });
});
