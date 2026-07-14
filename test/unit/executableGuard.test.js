'use strict';

// O vscode stub DEVE ser instalado antes de qualquer require que importe 'vscode'
const { stub } = require('../helpers/vscodeMock');
require('../helpers/vscodeMock').install();

const { assert } = require('chai');
const path = require('path');
const { resolveExecutable, resolvesInsideWorkspace } = require('../../src/lsp/executableGuard');

function setWorkspace(trusted, folderPath) {
    stub.workspace.isTrusted = trusted;
    stub.workspace.workspaceFolders = folderPath
        ? [{ uri: { fsPath: folderPath } }]
        : null;
}

describe('executableGuard.resolveExecutable', () => {
    afterEach(() => setWorkspace(true, null));

    it('keeps the built-in default in a trusted workspace', () => {
        setWorkspace(true, null);
        const r = resolveExecutable('synesis-lsp', 'synesis-lsp');
        assert.equal(r.command, 'synesis-lsp');
        assert.isFalse(r.forcedDefault);
    });

    it('keeps a custom absolute path outside the workspace when trusted', () => {
        setWorkspace(true, path.resolve('/projeto'));
        const custom = path.resolve('/opt/tools/synesis-lsp');
        const r = resolveExecutable(custom, 'synesis-lsp');
        assert.equal(r.command, custom);
        assert.isFalse(r.forcedDefault);
    });

    it('forces the default when the workspace is not trusted and a custom path is set', () => {
        setWorkspace(false, path.resolve('/projeto'));
        const r = resolveExecutable('/opt/tools/synesis-lsp', 'synesis-lsp');
        assert.equal(r.command, 'synesis-lsp');
        assert.isTrue(r.forcedDefault);
        assert.match(r.reason, /not trusted/i);
    });

    it('allows the bare default even in an untrusted workspace', () => {
        setWorkspace(false, path.resolve('/projeto'));
        const r = resolveExecutable('synesis-lsp', 'synesis-lsp');
        assert.equal(r.command, 'synesis-lsp');
        assert.isFalse(r.forcedDefault);
    });

    it('refuses an executable that resolves inside the workspace even when trusted', () => {
        const root = path.resolve('/projeto');
        setWorkspace(true, root);
        const inside = path.join(root, 'venv', 'python');
        const r = resolveExecutable(inside, 'synesis-lsp');
        assert.equal(r.command, 'synesis-lsp');
        assert.isTrue(r.forcedDefault);
        assert.match(r.reason, /inside the workspace/i);
    });

    it('strips surrounding quotes from the configured value', () => {
        setWorkspace(true, null);
        const r = resolveExecutable('"synesis-lsp"', 'synesis-lsp');
        assert.equal(r.command, 'synesis-lsp');
    });
});

describe('executableGuard.resolvesInsideWorkspace', () => {
    afterEach(() => setWorkspace(true, null));

    it('treats a bare command name as outside (resolved via PATH)', () => {
        setWorkspace(true, path.resolve('/projeto'));
        assert.isFalse(resolvesInsideWorkspace('synesis-lsp'));
    });

    it('detects a relative path pointing into the workspace', () => {
        const root = process.cwd();
        setWorkspace(true, root);
        assert.isTrue(resolvesInsideWorkspace('./evil.bat'));
    });

    it('returns false when there is no workspace folder', () => {
        setWorkspace(true, null);
        assert.isFalse(resolvesInsideWorkspace('/projeto/evil'));
    });
});
