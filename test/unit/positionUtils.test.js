'use strict';

const { assert } = require('chai');
const {
    buildLineOffsets,
    getLineColumn,
    findFieldValueInfo,
    findTokenOffset,
    findTokenPosition
} = require('../../src/utils/positionUtils');

describe('positionUtils', () => {

    describe('buildLineOffsets', () => {
        it('returns [0] for a single-line string', () => {
            assert.deepEqual(buildLineOffsets('hello'), [0]);
        });

        it('returns correct offsets for two lines', () => {
            // "abc\ndef" → newline at index 3 → second line starts at 4
            assert.deepEqual(buildLineOffsets('abc\ndef'), [0, 4]);
        });

        it('returns correct offsets for three lines', () => {
            assert.deepEqual(buildLineOffsets('a\nb\nc'), [0, 2, 4]);
        });

        it('handles empty string', () => {
            assert.deepEqual(buildLineOffsets(''), [0]);
        });

        it('handles trailing newline', () => {
            assert.deepEqual(buildLineOffsets('a\n'), [0, 2]);
        });

        it('handles consecutive newlines', () => {
            assert.deepEqual(buildLineOffsets('a\n\nb'), [0, 2, 3]);
        });
    });

    describe('getLineColumn', () => {
        const offsets = buildLineOffsets('abc\nde\nf');
        // line 0: "abc"  offsets[0]=0
        // line 1: "de"   offsets[1]=4
        // line 2: "f"    offsets[2]=7

        it('returns line 0, col 0 for offset 0', () => {
            assert.deepEqual(getLineColumn(offsets, 0), { line: 0, column: 0 });
        });

        it('returns line 0, col 2 for last char of first line', () => {
            assert.deepEqual(getLineColumn(offsets, 2), { line: 0, column: 2 });
        });

        it('returns line 1, col 0 for start of second line', () => {
            assert.deepEqual(getLineColumn(offsets, 4), { line: 1, column: 0 });
        });

        it('returns line 1, col 1 for second char of second line', () => {
            assert.deepEqual(getLineColumn(offsets, 5), { line: 1, column: 1 });
        });

        it('returns line 2, col 0 for start of third line', () => {
            assert.deepEqual(getLineColumn(offsets, 7), { line: 2, column: 0 });
        });

        it('handles empty lineOffsets', () => {
            assert.deepEqual(getLineColumn([], 5), { line: 0, column: 0 });
        });

        it('clamps negative offset to 0', () => {
            assert.deepEqual(getLineColumn(offsets, -1), { line: 0, column: 0 });
        });
    });

    describe('findFieldValueInfo', () => {
        it('finds value of a simple single-line field', () => {
            const block = 'citation: Some text here\nnote: other\n';
            const info = findFieldValueInfo(block, 'citation');
            assert.isNotNull(info);
            assert.include(info.value, 'Some text here');
        });

        it('returns null when field is absent', () => {
            const block = 'note: something\n';
            assert.isNull(findFieldValueInfo(block, 'citation'));
        });

        it('finds field even with leading spaces', () => {
            const block = '    citation: value\n    note: other\n';
            const info = findFieldValueInfo(block, 'citation');
            assert.isNotNull(info);
            assert.include(info.value, 'value');
        });
    });

    describe('findTokenOffset', () => {
        it('finds offset of a token at the start', () => {
            assert.equal(findTokenOffset('CODE_A -> CODE_B', 'CODE_A'), 0);
        });

        it('finds offset of a token in the middle', () => {
            const offset = findTokenOffset('hello CODE_B world', 'CODE_B');
            assert.equal(offset, 6);
        });

        it('returns null when token is absent', () => {
            assert.isNull(findTokenOffset('hello world', 'CODE_X'));
        });

        it('does not match partial token', () => {
            // "CODE" should not match "CODE_A" as whole token
            assert.isNull(findTokenOffset('CODE_A', 'CODE'));
        });
    });

    describe('findTokenPosition', () => {
        it('returns null when item has no blockContent', () => {
            const offsets = buildLineOffsets('abc');
            assert.isNull(findTokenPosition({}, 'citation', 'TOKEN', offsets));
        });

        it('returns null when field not found in block', () => {
            const item = { blockContent: 'note: hello\n', blockOffset: 0 };
            const offsets = buildLineOffsets('note: hello\n');
            assert.isNull(findTokenPosition(item, 'citation', 'hello', offsets));
        });

        it('returns correct position when token found', () => {
            // "citation: TOKEN\n"
            //  0         10
            const block = 'citation: TOKEN\n';
            const item = { blockContent: block, blockOffset: 0 };
            const offsets = buildLineOffsets(block);
            const pos = findTokenPosition(item, 'citation', 'TOKEN', offsets);
            assert.isNotNull(pos);
            assert.equal(pos.line, 0);
            assert.equal(pos.column, 10);
        });
    });
});
