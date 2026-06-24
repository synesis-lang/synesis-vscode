'use strict';

const { assert } = require('chai');
const { parseChain } = require('../../src/parsers/chainParser');

describe('chainParser', () => {

    describe('simple chains (no relations in fieldDef)', () => {
        const fieldDef = { relations: [] };

        it('parses a single code', () => {
            const result = parseChain('CODE_A', fieldDef);
            assert.deepEqual(result.codes, ['CODE_A']);
            assert.deepEqual(result.relations, []);
            assert.equal(result.type, 'simple');
        });

        it('parses two codes with ->', () => {
            const result = parseChain('CODE_A -> CODE_B', fieldDef);
            assert.deepEqual(result.codes, ['CODE_A', 'CODE_B']);
            assert.deepEqual(result.relations, ['relates_to']);
            assert.equal(result.type, 'simple');
        });

        it('parses three codes', () => {
            const result = parseChain('A -> B -> C', fieldDef);
            assert.deepEqual(result.codes, ['A', 'B', 'C']);
            assert.deepEqual(result.relations, ['relates_to', 'relates_to']);
            assert.equal(result.type, 'simple');
        });

        it('returns empty arrays for empty input', () => {
            const result = parseChain('', fieldDef);
            assert.deepEqual(result.codes, []);
            assert.deepEqual(result.relations, []);
            assert.equal(result.type, 'simple');
        });

        it('handles null input gracefully', () => {
            const result = parseChain(null, fieldDef);
            assert.deepEqual(result.codes, []);
        });

        it('returns type "simple" when fieldDef is null', () => {
            const result = parseChain('A -> B', null);
            assert.equal(result.type, 'simple');
        });
    });

    describe('qualified chains (fieldDef has relations)', () => {
        const fieldDef = { relations: ['enables', 'constrains'] };

        it('parses a qualified chain with one relation', () => {
            const result = parseChain('CODE_A -> enables -> CODE_B', fieldDef);
            assert.deepEqual(result.codes, ['CODE_A', 'CODE_B']);
            assert.deepEqual(result.relations, ['enables']);
            assert.equal(result.type, 'qualified');
        });

        it('parses a qualified chain with two relations', () => {
            const result = parseChain('A -> enables -> B -> constrains -> C', fieldDef);
            assert.deepEqual(result.codes, ['A', 'B', 'C']);
            assert.deepEqual(result.relations, ['enables', 'constrains']);
            assert.equal(result.type, 'qualified');
        });

        it('returns type "qualified" even for single code', () => {
            const result = parseChain('A', fieldDef);
            assert.equal(result.type, 'qualified');
            assert.deepEqual(result.codes, ['A']);
            assert.deepEqual(result.relations, []);
        });

        it('trims whitespace from elements', () => {
            const result = parseChain('  CODE_A  ->  enables  ->  CODE_B  ', fieldDef);
            assert.deepEqual(result.codes, ['CODE_A', 'CODE_B']);
            assert.deepEqual(result.relations, ['enables']);
        });
    });

    describe('edge cases', () => {
        it('handles -> with no codes (only arrow)', () => {
            const result = parseChain('->', { relations: [] });
            // split gives ['', ''] → both filtered by filter(Boolean)
            assert.deepEqual(result.codes, []);
            assert.deepEqual(result.relations, []);
        });

        it('handles fieldDef without relations key', () => {
            const result = parseChain('A -> B', {});
            assert.equal(result.type, 'simple');
            assert.deepEqual(result.codes, ['A', 'B']);
        });
    });
});
