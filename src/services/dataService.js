/**
 * dataService.js - Adapter Pattern para dados LSP
 *
 * Proposito:
 *     Abstrai a fonte de dados (LSP server)
 *     para que explorers e viewers consumam uma interface unica.
 *
 * Componentes:
 *     - LspDataProvider: envia requests ao LSP e normaliza respostas
 *     - DataService: orquestrador de acesso LSP-only
 *
 * Shapes normalizados:
 *     - getReferences() -> Array<{ bibref, itemCount, occurrences }>
 *     - getCodes() -> Array<{ code, usageCount, ontologyDefined, occurrences }>
 *     - getRelations() -> Array<{ relation, triplets }>
 *     - getRelationGraph(bibref?) -> { mermaidCode } | null
 *     - getOntologyTopics() -> Array<{ name, level, file, line, children }>
 *     - getOntologyAnnotations(activeFile?) -> Array<{ code, ontologyDefined, ontologyFile, ontologyLine, occurrences }>
 */

const path = require('path');
const vscode = require('vscode');

// ---------------------------------------------------------------------------
// LspDataProvider
// ---------------------------------------------------------------------------

class LspDataProvider {
    constructor(lspClient) {
        this.lspClient = lspClient;
    }

    _isMethodNotFound(error) {
        return Boolean(error && (error.code === -32601 || /Method Not Found/i.test(error.message)));
    }

    async _sendRequestWithFallback(primaryMethod, params, fallbackMethods = []) {
        try {
            return await this.lspClient.sendRequest(primaryMethod, params);
        } catch (error) {
            if (!this._isMethodNotFound(error) || fallbackMethods.length === 0) {
                throw error;
            }

            for (const method of fallbackMethods) {
                try {
                    return await this.lspClient.sendRequest(method, params);
                } catch (fallbackError) {
                    if (!this._isMethodNotFound(fallbackError)) {
                        throw fallbackError;
                    }
                }
            }

            throw error;
        }
    }

    async getReferences(workspaceRoot) {
        const result = await this._sendRequestWithFallback(
            'synesis/getReferences',
            { workspaceRoot },
            ['synesis/get_references']
        );
        if (!result || !result.success) {
            return null;
        }

        const grouped = new Map();
        for (const ref of (result.references || [])) {
            if (!grouped.has(ref.bibref)) {
                grouped.set(ref.bibref, { bibref: ref.bibref, itemCount: 0, occurrences: [], title: ref.title || '' });
            }
            const entry = grouped.get(ref.bibref);
            entry.itemCount += ref.itemCount || 0;
            if (!entry.title && ref.title) {
                entry.title = ref.title;
            }
            if (ref.location) {
                const resolvedFile = this._resolveFilePath(ref.location.file, workspaceRoot);
                entry.occurrences.push({
                    file: resolvedFile,
                    line: ref.location.line - 1,
                    itemCount: ref.itemCount || 0
                });
            }
        }
        return Array.from(grouped.values());
    }

    async getCodes(workspaceRoot) {
        const result = await this._sendRequestWithFallback(
            'synesis/getCodes',
            { workspaceRoot },
            ['synesis/get_codes']
        );
        if (!result || !result.success) {
            return null;
        }

        const codes = (result.codes || []).map(c => {
            const occurrences = (c.occurrences || []).map(o => {
                const resolvedFile = this._resolveFilePath(o.file, workspaceRoot);
                return {
                    file: resolvedFile,
                    line: typeof o.line === 'number' ? o.line - 1 : 0,
                    column: typeof o.column === 'number' ? o.column - 1 : 0,
                    context: o.context || 'code',
                    field: o.field || ''
                };
            });

            let usageCount = typeof c.usageCount === 'number' ? c.usageCount : occurrences.length;
            if (usageCount === 0 && occurrences.length > 0) {
                usageCount = occurrences.length;
            }

            return {
                code: c.code,
                usageCount,
                ontologyDefined: c.ontologyDefined || false,
                occurrences
            };
        });

        return codes;
    }

    async getRelations(workspaceRoot) {
        const result = await this._sendRequestWithFallback(
            'synesis/getRelations',
            { workspaceRoot },
            ['synesis/get_relations']
        );
        if (!result || !result.success) {
            return null;
        }

        const grouped = new Map();
        for (const rel of (result.relations || [])) {
            if (!grouped.has(rel.relation)) {
                grouped.set(rel.relation, { relation: rel.relation, triplets: [] });
            }
            const hasLocation = Boolean(rel.location && rel.location.file);
            const resolvedFile = hasLocation ? this._resolveFilePath(rel.location.file, workspaceRoot) : null;

            grouped.get(rel.relation).triplets.push({
                from: rel.from,
                to: rel.to,
                file: resolvedFile,
                line: hasLocation && typeof rel.location.line === 'number' ? (rel.location.line - 1) : -1,
                column: hasLocation
                    ? (typeof rel.location.column === 'number' ? Math.max(0, rel.location.column - 1) : 0)
                    : -1,
                type: rel.type || ''
            });
        }
        return Array.from(grouped.values());
    }

    async getRelationGraph(workspaceRoot, bibref) {
        const params = { workspaceRoot };
        if (bibref) {
            params.bibref = bibref;
        }
        const result = await this._sendRequestWithFallback(
            'synesis/getRelationGraph',
            params,
            ['synesis/get_relation_graph']
        );
        if (!result || !result.success) {
            return null;
        }
        const mermaidCode = result.mermaidCode || result.mermaid || '';
        return { mermaidCode };
    }

    async getRelationGraphForItem(workspaceRoot, itemBibref, itemLine, itemFile) {
        const params = { workspaceRoot, item: itemBibref };
        if (typeof itemLine === 'number') {
            params.itemLine = itemLine;
        }
        if (itemFile) {
            params.itemFile = itemFile;
        }
        const result = await this._sendRequestWithFallback(
            'synesis/getRelationGraph',
            params
        );
        if (!result || !result.success) {
            return null;
        }
        const mermaidCode = result.mermaidCode || result.mermaid || '';
        return { mermaidCode };
    }

    async getRelationGraphForFile(workspaceRoot, filePath) {
        const params = { workspaceRoot, file: filePath };
        const result = await this._sendRequestWithFallback(
            'synesis/getRelationGraph',
            params
        );
        if (!result || !result.success) {
            return null;
        }
        const mermaidCode = result.mermaidCode || result.mermaid || '';
        return { mermaidCode };
    }

    async getOntologyTopics(workspaceRoot) {
        const result = await this._sendRequestWithFallback(
            'synesis/getOntologyTopics',
            { workspaceRoot },
            ['synesis/get_ontology_topics']
        );
        if (!result || !result.success) {
            return null;
        }
        const topics = Array.isArray(result.topics) ? result.topics : [];
        return topics
            .map(topic => this._normalizeTopic(topic, workspaceRoot))
            .filter(Boolean);
    }

    _normalizeTopic(topic, workspaceRoot) {
        if (!topic || typeof topic !== 'object') {
            return null;
        }

        const children = Array.isArray(topic.children) ? topic.children : [];
        const normalizedChildren = children
            .map(child => this._normalizeTopic(child, workspaceRoot))
            .filter(Boolean);

        const resolvedFile = this._resolveFilePath(topic.file, workspaceRoot);
        const normalizedLine = typeof topic.line === 'number' ? Math.max(0, topic.line - 1) : 0;

        return {
            name: topic.name || '',
            level: typeof topic.level === 'number' ? topic.level : 0,
            file: resolvedFile,
            line: normalizedLine,
            children: normalizedChildren
        };
    }

    async getExcerpts(workspaceRoot, bibref) {
        const result = await this._sendRequestWithFallback(
            'synesis/getExcerpts',
            { workspaceRoot, bibref }
        );
        if (!result || !result.success) {
            return null;
        }
        return result.items || [];
    }

    async getBlocks(workspaceRoot, file) {
        const result = await this._sendRequestWithFallback(
            'synesis/getBlocks',
            { workspaceRoot, file }
        );
        if (!result || !result.success) {
            return null;
        }
        return result.blocks || [];
    }

    async getTemplate(workspaceRoot) {
        const result = await this._sendRequestWithFallback(
            'synesis/getTemplate',
            { workspaceRoot }
        );
        if (!result || !result.success) {
            return null;
        }
        return result.template || null;
    }

    async getOntologyAnnotations(workspaceRoot, activeFile) {
        const params = { workspaceRoot };
        if (activeFile) {
            params.activeFile = activeFile;
        }
        const result = await this._sendRequestWithFallback(
            'synesis/getOntologyAnnotations',
            params,
            ['synesis/get_ontology_annotations']
        );
        if (!result || !result.success) {
            return null;
        }
        const annotations = Array.isArray(result.annotations) ? result.annotations : [];
        return annotations.map(annotation => {
            const occurrences = Array.isArray(annotation.occurrences) ? annotation.occurrences : [];
            const normalizedOccurrences = occurrences.map(occ => ({
                file: this._resolveFilePath(occ.file, workspaceRoot),
                line: typeof occ.line === 'number' ? Math.max(0, occ.line - 1) : 0,
                column: typeof occ.column === 'number' ? Math.max(0, occ.column - 1) : 0,
                context: occ.context || '',
                field: occ.field || '',
                itemName: occ.itemName || ''
            }));

            return {
                code: annotation.code,
                ontologyDefined: Boolean(annotation.ontologyDefined),
                ontologyFile: this._resolveFilePath(annotation.ontologyFile, workspaceRoot),
                ontologyLine: typeof annotation.ontologyLine === 'number'
                    ? Math.max(0, annotation.ontologyLine - 1)
                    : null,
                occurrences: normalizedOccurrences
            };
        });
    }

    _resolveFilePath(fileValue, workspaceRoot) {
        if (!fileValue || typeof fileValue !== 'string') {
            return null;
        }

        let normalized = fileValue;
        if (normalized.startsWith('file://')) {
            try {
                normalized = vscode.Uri.parse(normalized).fsPath;
            } catch (error) {
                console.warn('DataService: Failed to parse file URI', normalized);
            }
        }

        if (path.isAbsolute(normalized)) {
            return normalized;
        }

        if (workspaceRoot) {
            return path.resolve(workspaceRoot, normalized);
        }

        return path.resolve(normalized);
    }
}

// ---------------------------------------------------------------------------
// DataService (orchestrator)
// ---------------------------------------------------------------------------

class DataService {
    constructor({ lspClient, onLspIncompatible } = {}) {
        this.lspClient = lspClient || null;
        this.lspProvider = lspClient ? new LspDataProvider(lspClient) : null;
        this.unsupportedMethods = new Set();
        this.warnedUnsupported = false;
        this.onLspIncompatible = typeof onLspIncompatible === 'function' ? onLspIncompatible : null;
        this._lspNullCount = 0;
        this._lspNullWarned = false;
        this._warnedLspRequired = new Set();
    }

    async getReferences() {
        return this._callLsp('getReferences');
    }

    async getCodes() {
        return this._callLsp('getCodes');
    }

    async getRelations() {
        return this._callLsp('getRelations');
    }

    async getRelationGraph(bibref) {
        return this._callLsp('getRelationGraph', bibref);
    }

    async getRelationGraphForItem(itemBibref, itemLine, itemFile) {
        return this._callLsp('getRelationGraphForItem', itemBibref, itemLine, itemFile);
    }

    async getRelationGraphForFile(filePath) {
        return this._callLsp('getRelationGraphForFile', filePath);
    }

    async getOntologyTopics() {
        return this._callLsp('getOntologyTopics');
    }

    async getOntologyAnnotations(activeFile) {
        return this._callLsp('getOntologyAnnotations', activeFile);
    }

    async getExcerpts(bibref) {
        return this._callLsp('getExcerpts', bibref);
    }

    async getBlocks(file) {
        return this._callLsp('getBlocks', file);
    }

    async getTemplate() {
        return this._callLsp('getTemplate');
    }

    async _callLsp(method, ...args) {
        const lspReady = Boolean(this.lspClient && this.lspClient.isReady());

        if (lspReady && !this.unsupportedMethods.has(method)) {
            try {
                const workspaceRoot = this._getWorkspaceRoot();
                const result = await this.lspProvider[method](workspaceRoot, ...args);
                if (result !== null) {
                    return result;
                }

                this._trackLspNull();
                this._warnLspRequired(method, 'LSP returned empty data');
                return this._emptyResultFor(method);
            } catch (error) {
                if (this._isMethodNotFound(error)) {
                    this.unsupportedMethods.add(method);
                    this._warnUnsupported(method, error);
                    return this._emptyResultFor(method);
                }

                console.error(`DataService.${method}: LSP error:`, error.message);
                this._warnLspRequired(method, error.message);
                return this._emptyResultFor(method);
            }
        }

        if (this.unsupportedMethods.has(method)) {
            this._warnLspRequired(method, 'LSP method not supported');
        } else if (!lspReady) {
            this._warnLspRequired(method, this.lspClient ? 'LSP not ready' : 'LSP disabled');
        }
        return this._emptyResultFor(method);
    }

    _trackLspNull() {
        if (this._lspNullWarned) {
            return;
        }
        this._lspNullCount += 1;
        if (this._lspNullCount >= 3 && this.onLspIncompatible) {
            this._lspNullWarned = true;
            this.onLspIncompatible();
        }
    }

    _isMethodNotFound(error) {
        return Boolean(error && (error.code === -32601 || /Method Not Found/i.test(error.message)));
    }

    _warnUnsupported(method, error) {
        if (this.warnedUnsupported) {
            return;
        }

        this.warnedUnsupported = true;
        if (this.onLspIncompatible) {
            this.onLspIncompatible();
        }
        const lspMethod = this._resolveLspMethodName(method);
        const message = `Synesis LSP does not support "${lspMethod}". ` +
            'Update synesis-lsp to v0.13.0+ or adjust synesisExplorer.lsp.pythonPath.';

        vscode.window.showWarningMessage(message);
        console.warn(`DataService: LSP method not found (${lspMethod}):`, error.message);
    }

    _resolveLspMethodName(method) {
        switch (method) {
            case 'getReferences':
                return 'synesis/getReferences';
            case 'getCodes':
                return 'synesis/getCodes';
            case 'getRelations':
                return 'synesis/getRelations';
            case 'getRelationGraph':
            case 'getRelationGraphForItem':
            case 'getRelationGraphForFile':
                return 'synesis/getRelationGraph';
            case 'getOntologyTopics':
                return 'synesis/getOntologyTopics';
            case 'getOntologyAnnotations':
                return 'synesis/getOntologyAnnotations';
            case 'getExcerpts':
                return 'synesis/getExcerpts';
            case 'getBlocks':
                return 'synesis/getBlocks';
            case 'getTemplate':
                return 'synesis/getTemplate';
            default:
                return method;
        }
    }

    _emptyResultFor(method) {
        switch (method) {
            case 'getReferences':
            case 'getCodes':
            case 'getRelations':
            case 'getOntologyTopics':
            case 'getOntologyAnnotations':
                return [];
            case 'getRelationGraph':
            case 'getRelationGraphForItem':
            case 'getRelationGraphForFile':
                return null;
            case 'getExcerpts':
                return null;
            case 'getBlocks':
                return null;
            case 'getTemplate':
                return null;
            default:
                return null;
        }
    }

    _warnLspRequired(method, reason) {
        if (this._warnedLspRequired.has(method)) {
            return;
        }

        this._warnedLspRequired.add(method);
        const lspMethod = this._resolveLspMethodName(method);
        const suffix = reason ? ` (${reason})` : '';
        vscode.window.showWarningMessage(
            `Synesis LSP is required for "${lspMethod}".${suffix}`
        );
    }

    _getWorkspaceRoot() {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document && editor.document.uri) {
            const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
            if (folder && folder.uri && folder.uri.fsPath) {
                return folder.uri.fsPath;
            }
        }

        const folders = vscode.workspace.workspaceFolders;
        return folders && folders.length > 0 ? folders[0].uri.fsPath : '';
    }
}

module.exports = DataService;
