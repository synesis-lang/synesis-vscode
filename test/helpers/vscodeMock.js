'use strict';

/**
 * vscodeMock.js — Stub mínimo do módulo 'vscode' para testes Node (sem Electron).
 *
 * Registra o stub em require.cache antes de importar qualquer módulo
 * que dependa de 'vscode'. Use assim no topo do arquivo de teste:
 *
 *   require('../helpers/vscodeMock').install();
 *   const DataService = require('../../src/services/dataService');
 */

const Module = require('module');
const path = require('path');

// Shape mínimo que dataService.js usa
const stub = {
    Uri: {
        parse: (uri) => ({ fsPath: uri.replace(/^file:\/\//, '') })
    },
    window: {
        activeTextEditor: null,
        showWarningMessage: () => {}
    },
    workspace: {
        workspaceFolders: null,
        getWorkspaceFolder: () => null
    }
};

let installed = false;

function install() {
    if (installed) return;
    installed = true;

    // Injeta o stub no cache de require com o nome que os módulos usam
    const fakeId = 'vscode';
    Module._resolveFilename = (function (original) {
        return function (request, parent, isMain, options) {
            if (request === fakeId) return fakeId;
            return original.call(this, request, parent, isMain, options);
        };
    }(Module._resolveFilename));

    require.cache[fakeId] = {
        id: fakeId,
        filename: fakeId,
        loaded: true,
        exports: stub
    };
}

function uninstall() {
    if (!installed) return;
    delete require.cache['vscode'];
    installed = false;
}

module.exports = { stub, install, uninstall };
