'use strict';

const { assert } = require('chai');
const { findExcerpt } = require('../../src/utils/fuzzyMatcher');

describe('fuzzyMatcher', () => {

    describe('findExcerpt — exact match', () => {
        it('finds an exact substring at the start', () => {
            const result = findExcerpt('Hello world', 'Hello');
            assert.deepEqual(result, { start: 0, end: 5 });
        });

        it('finds an exact substring in the middle', () => {
            const result = findExcerpt('The quick brown fox', 'quick');
            assert.deepEqual(result, { start: 4, end: 9 });
        });

        it('finds case-insensitive match', () => {
            const result = findExcerpt('Hello World', 'hello');
            assert.isNotNull(result);
            assert.equal(result.start, 0);
        });
    });

    describe('findExcerpt — normalized match', () => {
        it('finds excerpt with extra whitespace', () => {
            const abstract = 'The quick   brown fox';
            const excerpt = 'quick brown';
            const result = findExcerpt(abstract, excerpt);
            assert.isNotNull(result);
            assert.isTrue(result.start >= 4);
        });

        it('finds excerpt across different punctuation', () => {
            const abstract = 'knowledge: synthesis method';
            const excerpt = 'knowledge synthesis';
            const result = findExcerpt(abstract, excerpt);
            assert.isNotNull(result);
        });

        it('returns null when excerpt is not present', () => {
            assert.isNull(findExcerpt('Hello world', 'foobar'));
        });
    });

    describe('findExcerpt — edge cases', () => {
        it('returns null for empty abstract', () => {
            assert.isNull(findExcerpt('', 'hello'));
        });

        it('returns null for empty excerpt', () => {
            assert.isNull(findExcerpt('hello world', ''));
        });

        it('returns null when both are null/undefined', () => {
            assert.isNull(findExcerpt(null, null));
        });

        it('finds single-word excerpt', () => {
            const result = findExcerpt('The cat sat on the mat', 'cat');
            assert.isNotNull(result);
            assert.equal(result.start, 4);
            assert.equal(result.end, 7);
        });

        it('returned range covers the correct text', () => {
            const abstract = 'Synthesis is the key concept here';
            const excerpt = 'key concept';
            const result = findExcerpt(abstract, excerpt);
            assert.isNotNull(result);
            assert.equal(abstract.slice(result.start, result.end), 'key concept');
        });
    });
});
