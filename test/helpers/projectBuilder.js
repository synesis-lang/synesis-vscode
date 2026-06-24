'use strict';

/**
 * projectBuilder.js — Construtores de payloads LSP canônicos para testes.
 *
 * Evita repetição de fixtures inline nos testes. Cada função retorna
 * o shape exato que o Python LSP retorna antes da normalização pelo DataService.
 *
 * Uso:
 *   const { buildReferencesPayload, buildCodesPayload } = require('../helpers/projectBuilder');
 *   mock.set('synesis/getReferences', buildReferencesPayload([{ bibref: 'smith2020', itemCount: 3 }]));
 */

// ---------------------------------------------------------------------------
// Shapes LSP (antes de normalização pelo DataService)
// ---------------------------------------------------------------------------

function buildReferencesPayload(refs = []) {
    return {
        success: true,
        references: refs.map(r => ({
            bibref: r.bibref,
            itemCount: r.itemCount ?? 1,
            title: r.title ?? '',
            location: r.location ?? { file: `${r.bibref}.syn`, line: 1 }
        }))
    };
}

function buildCodesPayload(codes = []) {
    return {
        success: true,
        codes: codes.map(c => ({
            code: c.code,
            usageCount: c.usageCount ?? 1,
            ontologyDefined: c.ontologyDefined ?? false,
            occurrences: (c.occurrences ?? []).map(o => ({
                file: o.file ?? 'annotations.syn',
                line: o.line ?? 1,
                column: o.column ?? 1,
                context: o.context ?? 'code',
                field: o.field ?? ''
            }))
        }))
    };
}

function buildRelationsPayload(relations = []) {
    return {
        success: true,
        relations: relations.map(r => ({
            relation: r.relation,
            from: r.from,
            to: r.to,
            type: r.type ?? '',
            location: r.location ?? null
        }))
    };
}

function buildBlocksPayload(blocks = []) {
    return {
        success: true,
        blocks: blocks.map(b => ({
            kind: b.kind,                  // 'SOURCE' | 'ITEM'
            bibref: b.bibref,
            range: b.range ?? {
                start: { line: 0, character: 0 },
                end:   { line: 2, character: 0 }
            }
        }))
    };
}

function buildTemplatePayload(template = {}) {
    return {
        success: true,
        template: {
            name: template.name ?? 'test',
            fields: template.fields ?? [],
            requirements: template.requirements ?? {
                SOURCE: { required: [], optional: [], forbidden: [], bundles: [], optional_bundles: [] },
                ITEM:   { required: [], optional: [], forbidden: [], bundles: [], optional_bundles: [] },
                ONTOLOGY: { required: [], optional: [], forbidden: [], bundles: [], optional_bundles: [] }
            }
        }
    };
}

function buildOntologyAnnotationsPayload(annotations = []) {
    return {
        success: true,
        annotations: annotations.map(a => ({
            code: a.code,
            ontologyDefined: a.ontologyDefined ?? false,
            ontologyFile: a.ontologyFile ?? null,
            ontologyLine: a.ontologyLine ?? null,
            occurrences: (a.occurrences ?? []).map(o => ({
                file: o.file ?? 'annotations.syn',
                line: o.line ?? 1,
                column: o.column ?? 1,
                context: o.context ?? '',
                field: o.field ?? '',
                itemName: o.itemName ?? ''
            }))
        }))
    };
}

/** Payload de erro genérico (success: false). */
function buildErrorPayload(error = 'Unknown error') {
    return { success: false, error };
}

module.exports = {
    buildReferencesPayload,
    buildCodesPayload,
    buildRelationsPayload,
    buildBlocksPayload,
    buildTemplatePayload,
    buildOntologyAnnotationsPayload,
    buildErrorPayload
};
