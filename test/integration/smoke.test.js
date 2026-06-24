'use strict';

const { assert } = require('chai');
const vscode = require('vscode');

describe('Smoke: Extension Host', () => {
    it('activates the synesis extension', async () => {
        const ext = vscode.extensions.getExtension('synesis-lang.synesis');
        assert.ok(ext, 'extension not found — check publisher.name in package.json');
        if (!ext.isActive) {
            await ext.activate();
        }
        assert.isTrue(ext.isActive);
    });
});
