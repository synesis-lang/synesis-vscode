/**
 * sharedWatchTargets.js - Reverse index for INCLUDE SHARED ONTOLOGY targets.
 *
 * Propósito:
 *     Traduz o payload `sharedIncludes` do LSP (alvo -> projetos que o incluem)
 *     no conjunto de watchers desejado: alvo -> raízes de workspace a recarregar.
 *
 * Por que existe:
 *     A ontologia compartilhada vive FORA da pasta do projeto, então
 *     onDidSaveTextDocument (que só dispara para documentos abertos) nunca vê
 *     suas edições — git pull, outra janela ou outro processo passam batido.
 *     O watcher precisa saber QUAIS projetos invalidar quando um alvo muda.
 *
 * Notas de implementação:
 *     - Lógica pura (sem dependência do módulo `vscode`) para ser testável.
 *     - Entrada malformada nunca lança: um payload ruim não pode derrubar a
 *       ativação da extensão; no pior caso não há watcher.
 */

const path = require('path');

/**
 * Computes the desired watcher set from the LSP's sharedIncludes payload.
 *
 * @param {Array<{target: string, projects: string[]}>} sharedIncludes
 * @returns {Map<string, Set<string>>} target -> set of workspace roots to reload
 */
function computeWatchTargets(sharedIncludes) {
    const wanted = new Map();
    if (!Array.isArray(sharedIncludes)) {
        return wanted;
    }
    for (const entry of sharedIncludes) {
        if (!entry || typeof entry.target !== 'string' || !entry.target) {
            continue;
        }
        const roots = new Set();
        const projects = Array.isArray(entry.projects) ? entry.projects : [];
        for (const synp of projects) {
            if (typeof synp === 'string' && synp) {
                roots.add(path.dirname(synp));
            }
        }
        // An existing target keeps accumulating roots: two projects may include
        // the same shared ontology, and both must be reloaded when it changes.
        const existing = wanted.get(entry.target);
        if (existing) {
            for (const r of roots) existing.add(r);
        } else {
            wanted.set(entry.target, roots);
        }
    }
    return wanted;
}

/**
 * Diffs current watchers against the desired set.
 *
 * @param {Map<string, any>} current  target -> watcher entry
 * @param {Map<string, Set<string>>} wanted  target -> roots
 * @returns {{toAdd: string[], toRemove: string[], toUpdate: string[]}}
 */
function diffWatchTargets(current, wanted) {
    const toAdd = [];
    const toRemove = [];
    const toUpdate = [];
    for (const target of wanted.keys()) {
        if (current.has(target)) {
            toUpdate.push(target);
        } else {
            toAdd.push(target);
        }
    }
    for (const target of current.keys()) {
        if (!wanted.has(target)) {
            toRemove.push(target);
        }
    }
    return { toAdd, toRemove, toUpdate };
}

module.exports = { computeWatchTargets, diffWatchTargets };
