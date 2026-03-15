const path = require('path');
const vscode = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

class SynesisLspClient {
    constructor() {
        this.client = null;
        this.ready = false;
        this.readyPromise = null;
        this.lastLoadProjectResult = null;
        this.lastLoadProjectAt = null;
        this.effectiveCommand = null;
        this.effectiveArgs = null;
        this.effectiveLabel = null;
        this.outputChannel = null;
        // Cache layer (Fase 2)
        this._responseCache = new Map();   // cacheKey → { result, expiry }
        this._inFlightRequests = new Map(); // cacheKey → Promise
        this._cacheTTL = 5000;             // 5 seconds
    }

    start(pythonPath = 'python', args = []) {
        if (this.client) {
            return this.readyPromise || Promise.resolve();
        }

        const normalizedPath = String(pythonPath || '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
        const baseName = path.basename(normalizedPath).toLowerCase();

        const command = normalizedPath || pythonPath;
        const normalizedArgs = Array.isArray(args)
            ? args.map(value => String(value))
            : String(args || '').trim().split(/\s+/).filter(Boolean);
        this.effectiveCommand = command;
        this.effectiveArgs = normalizedArgs;
        this.effectiveLabel = baseName || command;

        const serverOptions = {
            command,
            args: normalizedArgs,
            transport: TransportKind.stdio
        };

        this.outputChannel = vscode.window.createOutputChannel('Synesis LSP', { log: true });

        const clientOptions = {
            documentSelector: [
                { scheme: 'file', language: 'synesis' }
            ],
            synchronize: {
                fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{syn,synt,synp,syno,bib}')
            },
            outputChannel: this.outputChannel,
            middleware: this._buildMiddleware()
        };

        this.client = new LanguageClient(
            'synesisLspClient',
            'Synesis LSP',
            serverOptions,
            clientOptions
        );

        this.readyPromise = this.client.start().then(() => {
            this.ready = true;
            if (this.outputChannel && this.client.initializeResult) {
                const caps = this.client.initializeResult.capabilities;
                this.outputChannel.appendLine(
                    `Server capabilities: hover=${!!caps.hoverProvider}, ` +
                    `completion=${!!caps.completionProvider}, ` +
                    `definition=${!!caps.definitionProvider}, ` +
                    `rename=${!!caps.renameProvider}`
                );
            }
        });

        return this.readyPromise;
    }

    stop() {
        if (!this.client) {
            return Promise.resolve();
        }

        const client = this.client;
        this.client = null;
        this.ready = false;
        this.readyPromise = null;

        if (this.outputChannel) {
            this.outputChannel.dispose();
            this.outputChannel = null;
        }

        return client.stop();
    }

    isReady() {
        return Boolean(this.client && this.ready);
    }

    async sendRequest(method, params) {
        if (!this.client) {
            throw new Error('Synesis LSP client is not started.');
        }

        if (this.readyPromise) {
            await this.readyPromise;
        }

        // loadProject is never cached — it must always reach the server.
        // Non-synesis methods (standard LSP) are also not cached.
        const cacheable = this._isSynesisMethod(method) && method !== 'synesis/loadProject';

        if (cacheable) {
            const cacheKey = `${method}:${JSON.stringify(params || {})}`;

            // 1. Cache hit
            const cached = this._responseCache.get(cacheKey);
            if (cached && cached.expiry > Date.now()) {
                return cached.result;
            }

            // 2. Deduplicate: coalesce with an identical in-flight request
            const inFlight = this._inFlightRequests.get(cacheKey);
            if (inFlight) {
                return inFlight;
            }

            // 3. New request — track it, cache on success
            const promise = this._actualSendRequest(method, params)
                .then(result => {
                    this._responseCache.set(cacheKey, {
                        result,
                        expiry: Date.now() + this._cacheTTL
                    });
                    return result;
                })
                .finally(() => {
                    this._inFlightRequests.delete(cacheKey);
                });

            this._inFlightRequests.set(cacheKey, promise);
            return promise;
        }

        const result = await this._actualSendRequest(method, params);

        if (method === 'synesis/loadProject') {
            this.lastLoadProjectResult = result;
            this.lastLoadProjectAt = Date.now();
        }
        return result;
    }

    async _actualSendRequest(method, params) {
        let result;
        try {
            if (this._isSynesisMethod(method)) {
                result = await this._sendExecuteCommand(method, params);
            } else {
                result = await this.client.sendRequest(method, params);
            }
        } catch (error) {
            if (this._isSynesisMethod(method) && this._isMethodNotFound(error)) {
                // Fallback to direct request only when executeCommand is not registered (-32601).
                result = await this.client.sendRequest(method, params);
            } else {
                throw error;
            }
        }
        return result;
    }

    /**
     * Invalidates the response cache. Must be called before synesis/loadProject
     * so that subsequent explorer refreshes fetch fresh data from the server.
     */
    invalidateCache() {
        this._responseCache.clear();
        // Do not clear _inFlightRequests — in-flight promises resolve to their own results.
    }

    _isSynesisMethod(method) {
        return typeof method === 'string' && method.startsWith('synesis/');
    }

    _isMethodNotFound(error) {
        return Boolean(error && (error.code === -32601 || /Method Not Found/i.test(error.message)));
    }

    async _sendExecuteCommand(method, params) {
        const execParams = {
            command: method,
            arguments: params !== undefined ? [params] : []
        };
        return this.client.sendRequest('workspace/executeCommand', execParams);
    }

    get lastLoadProject() {
        return this.lastLoadProjectResult;
    }

    get lastLoadProjectTimestamp() {
        return this.lastLoadProjectAt;
    }

    getEffectiveCommand() {
        return this.effectiveCommand;
    }

    getEffectiveArgs() {
        return this.effectiveArgs || [];
    }

    getEffectiveLabel() {
        return this.effectiveLabel;
    }

    _getConfig(key) {
        return vscode.workspace.getConfiguration('synesisExplorer').get(key);
    }

    /**
     * Builds LSP middleware that gates features based on user configuration.
     * Each provider check reads config at call time so hot-reload works without restart.
     */
    _buildMiddleware() {
        return {
            // Gate: diagnostics
            handleDiagnostics: (uri, diagnostics, next) => {
                if (this._getConfig('diagnostics.enabled') === false) {
                    next(uri, []);
                    return;
                }
                next(uri, diagnostics);
            },

            // Gate: inlay hints
            provideInlayHints: (document, range, token, next) => {
                if (this._getConfig('inlayHints.enabled') === false) {
                    return Promise.resolve([]);
                }
                return next(document, range, token);
            },

            // Gate: semantic tokens (full)
            provideDocumentSemanticTokens: (document, token, next) => {
                if (this._getConfig('semanticHighlighting.enabled') === false) {
                    return Promise.resolve(null);
                }
                return next(document, token);
            },

            // Gate: completion — filter out code suggestions when autoImportCodes is off
            provideCompletionItem: (document, position, context, token, next) => {
                return next(document, position, context, token).then(result => {
                    if (this._getConfig('completion.autoImportCodes') === false && result) {
                        const items = Array.isArray(result) ? result : (result.items || []);
                        const filtered = items.filter(item => {
                            // Remove items with kind=EnumMember (codes from ontology)
                            // CompletionItemKind.EnumMember = 20
                            return item.kind !== 20;
                        });
                        return Array.isArray(result) ? filtered : { ...result, items: filtered };
                    }
                    return result;
                });
            }
        };
    }
}

module.exports = SynesisLspClient;
