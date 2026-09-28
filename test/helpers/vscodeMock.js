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

// Shape mínimo que dataService.js usa.
// Position/Range/Selection foram acrescentados para coderService.js, que
// converte ranges LSP em offsets do documento.
class Position {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
}

class Range {
    constructor(start, end) {
        this.start = start;
        this.end = end;
    }
}

// Location é o que `stream.anchor()` recebe para apontar a uma linha de um
// arquivo — a âncora do chat até o `.syn` (Etapa G).
class Location {
    constructor(uri, rangeOrPosition) {
        this.uri = uri;
        this.range = rangeOrPosition;
    }
}

// Partes do Language Model API, usadas pelo chat (`src/chat/`). São classes
// reais e não objetos simples porque o código de produção decide o tipo com
// `instanceof` — um stub de objeto passaria pelos testes e falharia em runtime.
class LanguageModelTextPart {
    constructor(value) {
        this.value = value;
    }
}

class LanguageModelToolCallPart {
    constructor(callId, name, input) {
        this.callId = callId;
        this.name = name;
        this.input = input;
    }
}

class LanguageModelToolResultPart {
    constructor(callId, content) {
        this.callId = callId;
        this.content = content;
    }
}

const stub = {
    Uri: {
        parse: (uri) => ({ fsPath: uri.replace(/^file:\/\//, '') }),
        file: (fsPath) => ({ fsPath, scheme: 'file' }),
        // Usa `path.posix` para que o caminho gerado seja o mesmo nas três
        // plataformas: os testes do `mcp.json` comparam o caminho como string,
        // e um separador dependente do SO faria a asserção passar só no Windows.
        joinPath: (base, ...parts) => ({
            fsPath: path.posix.join(String(base && base.fsPath).replace(/\\/g, '/'), ...parts),
            scheme: 'file'
        })
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    Position,
    Range,
    Location,
    Selection: class Selection extends Range {},
    window: {
        activeTextEditor: null,
        showWarningMessage: () => {},
        showInformationMessage: () => {},
        showErrorMessage: () => {},
        showInputBox: async () => undefined,
        showQuickPick: async () => undefined,
        showTextDocument: async () => undefined
    },
    workspace: {
        workspaceFolders: null,
        getWorkspaceFolder: () => null,
        // Configuracao em memoria: `_config` guarda os valores por chave
        // completa ("secao.chave"), que e como os testes os declaram.
        _config: new Map(),
        getConfiguration: (section) => ({
            get: (key) => stub.workspace._config.get(section ? section + '.' + key : key),
            update: async (key, value) => {
                stub.workspace._config.set(section ? section + '.' + key : key, value);
            }
        }),
        onDidChangeConfiguration: () => ({ dispose() {} }),
        openTextDocument: async () => ({}),
        // Sistema de arquivos em memória. `readFile` rejeitando é o sinal de
        // "não existe" que `readExistingMcpConfig` interpreta — o mesmo contrato
        // do `vscode.workspace.fs` real.
        fs: {
            _files: new Map(),
            readFile: async (uri) => {
                const found = stub.workspace.fs._files.get(uri.fsPath);
                if (found === undefined) {
                    throw new Error('ENOENT');
                }
                return Buffer.from(found, 'utf8');
            },
            writeFile: async (uri, content) => {
                stub.workspace.fs._files.set(uri.fsPath, Buffer.from(content).toString('utf8'));
            },
            createDirectory: async () => undefined
        }
    },
    // Emissor de evento: os providers de modelo o usam para avisar o editor
    // que a lista de modelos mudou.
    EventEmitter: class EventEmitter {
        constructor() { this._handlers = []; }
        get event() {
            return (handler) => {
                this._handlers.push(handler);
                return { dispose: () => {} };
            };
        }
        fire(value) { this._handlers.forEach((h) => h(value)); }
        dispose() { this._handlers = []; }
    },
    LanguageModelTextPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    // O que `invokeGraphTool` devolve: mesmo shape do resultado de uma
    // ferramenta MCP, para que o restante do chat não distinga os dois caminhos.
    LanguageModelToolResult: class LanguageModelToolResult {
        constructor(content) {
            this.content = content;
        }
    },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    // `tools` e `invokeTool` são substituídos pelo teste que precisa deles;
    // o padrão é "nenhuma ferramenta disponível", que é o caminho de
    // degradação que o chat tem de suportar de qualquer forma.
    lm: {
        tools: [],
        invokeTool: async () => ({ content: [] })
    },
    commands: {
        executeCommand: async () => undefined
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
