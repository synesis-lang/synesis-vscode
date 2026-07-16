const assert = require('assert');
const path = require('path');
const { computeWatchTargets, diffWatchTargets } = require('../../src/lsp/sharedWatchTargets');

describe('sharedWatchTargets', () => {
    describe('computeWatchTargets', () => {
        it('maps a target to the root of the project that includes it', () => {
            const wanted = computeWatchTargets([
                { target: '/shared/vocab.syno', projects: ['/estudo/proj/p.synp'] }
            ]);
            assert.strictEqual(wanted.size, 1);
            assert.deepStrictEqual(
                [...wanted.get('/shared/vocab.syno')],
                [path.dirname('/estudo/proj/p.synp')]
            );
        });

        it('accumulates roots when two projects share one ontology', () => {
            // O caso que motiva a feature: vocabulário único, vários projetos.
            const wanted = computeWatchTargets([
                { target: '/shared/vocab.syno', projects: ['/a/x.synp', '/b/y.synp'] }
            ]);
            const roots = wanted.get('/shared/vocab.syno');
            assert.strictEqual(roots.size, 2);
            assert.ok(roots.has(path.dirname('/a/x.synp')));
            assert.ok(roots.has(path.dirname('/b/y.synp')));
        });

        it('merges duplicate entries for the same target', () => {
            const wanted = computeWatchTargets([
                { target: '/shared/v.syno', projects: ['/a/x.synp'] },
                { target: '/shared/v.syno', projects: ['/b/y.synp'] }
            ]);
            assert.strictEqual(wanted.size, 1);
            assert.strictEqual(wanted.get('/shared/v.syno').size, 2);
        });

        it('returns empty for a project without shared includes', () => {
            assert.strictEqual(computeWatchTargets([]).size, 0);
        });

        it('tolerates malformed payloads without throwing', () => {
            // Um payload ruim nunca pode derrubar a ativação da extensão.
            assert.strictEqual(computeWatchTargets(null).size, 0);
            assert.strictEqual(computeWatchTargets(undefined).size, 0);
            assert.strictEqual(computeWatchTargets('nonsense').size, 0);
            assert.strictEqual(computeWatchTargets([null, {}, { target: '' }]).size, 0);
        });

        it('keeps a target whose projects list is missing or empty', () => {
            // Alvo sem projeto ainda merece watcher: o .synp pode passar a
            // incluí-lo; o que não pode é o compute lançar.
            const wanted = computeWatchTargets([{ target: '/shared/v.syno' }]);
            assert.strictEqual(wanted.size, 1);
            assert.strictEqual(wanted.get('/shared/v.syno').size, 0);
        });

        it('skips non-string project entries', () => {
            const wanted = computeWatchTargets([
                { target: '/s/v.syno', projects: ['/a/x.synp', null, 42] }
            ]);
            assert.strictEqual(wanted.get('/s/v.syno').size, 1);
        });
    });

    describe('diffWatchTargets', () => {
        it('reports a new target as toAdd', () => {
            const d = diffWatchTargets(new Map(), new Map([['/s/v.syno', new Set(['/a'])]]));
            assert.deepStrictEqual(d.toAdd, ['/s/v.syno']);
            assert.deepStrictEqual(d.toRemove, []);
            assert.deepStrictEqual(d.toUpdate, []);
        });

        it('reports a dropped target as toRemove', () => {
            const current = new Map([['/s/old.syno', { watcher: {} }]]);
            const d = diffWatchTargets(current, new Map());
            assert.deepStrictEqual(d.toRemove, ['/s/old.syno']);
            assert.deepStrictEqual(d.toAdd, []);
        });

        it('reports an existing target as toUpdate, not toAdd', () => {
            // Não recriar o watcher: só atualizar o índice reverso.
            const current = new Map([['/s/v.syno', { watcher: {} }]]);
            const wanted = new Map([['/s/v.syno', new Set(['/a', '/b'])]]);
            const d = diffWatchTargets(current, wanted);
            assert.deepStrictEqual(d.toUpdate, ['/s/v.syno']);
            assert.deepStrictEqual(d.toAdd, []);
            assert.deepStrictEqual(d.toRemove, []);
        });

        it('handles add, remove and update together', () => {
            const current = new Map([
                ['/s/keep.syno', { watcher: {} }],
                ['/s/drop.syno', { watcher: {} }]
            ]);
            const wanted = new Map([
                ['/s/keep.syno', new Set(['/a'])],
                ['/s/new.syno', new Set(['/b'])]
            ]);
            const d = diffWatchTargets(current, wanted);
            assert.deepStrictEqual(d.toAdd, ['/s/new.syno']);
            assert.deepStrictEqual(d.toRemove, ['/s/drop.syno']);
            assert.deepStrictEqual(d.toUpdate, ['/s/keep.syno']);
        });

        it('is a no-op when nothing changed', () => {
            const current = new Map([['/s/v.syno', { watcher: {} }]]);
            const wanted = new Map([['/s/v.syno', new Set(['/a'])]]);
            const d = diffWatchTargets(current, wanted);
            assert.deepStrictEqual(d.toAdd, []);
            assert.deepStrictEqual(d.toRemove, []);
        });
    });
});
