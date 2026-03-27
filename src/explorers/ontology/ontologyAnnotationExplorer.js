/**
 * ontologyAnnotationExplorer.js - TreeDataProvider para ontologia em anotacoes (via LSP)
 *
 * Proposito:
 *     Lista conceitos da ontologia usados no arquivo .syn ativo,
 *     com ocorrencias retornadas pelo LSP.
 *
 * Dependencias criticas:
 *     - DataService: LSP-only data access
 */

const vscode = require('vscode');

class OntologyAnnotationExplorer {
    constructor(dataService) {
        this.dataService = dataService;
        this.annotations = new Map(); // code -> { ontologyDefined, ontologyFile, ontologyLine, occurrences }
        this.filterText = '';
        this.placeholder = null;
        this._lastDataHash = null; // Cache hash to avoid unnecessary refreshes
        this._lastActiveFile = null; // Track active file changes
        this._treeView = null; // set by extension.js after createTreeView

        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }

    /**
     * Simple hash function for cache comparison
     */
    _hashData(annotations, activeFile) {
        if (!annotations || annotations.length === 0) {
            return `empty:${activeFile}`;
        }
        const parts = annotations.map(annotation => {
            const code = String(annotation.code || '');
            const occCount = Array.isArray(annotation.occurrences) ? annotation.occurrences.length : 0;
            return `${code}:${occCount}`;
        });
        parts.sort();
        return `${activeFile || ''}:${parts.join('|')}`;
    }

    /**
     * Obtém annotations via DataService e atualiza índice
     */
    async refresh() {
        this.placeholder = null;

        const activeEditor = vscode.window.activeTextEditor;
        const document = activeEditor ? activeEditor.document : null;
        if (!this._isSynDocument(document)) {
            await this._setHasOntologyAnnotations(false);
            this._onDidChangeTreeData.fire();
            return;
        }

        const lspStatus = this._getLspStatus();
        if (lspStatus !== 'ready') {
            const label = lspStatus === 'disabled' ? 'LSP disabled' : 'LSP not ready';
            const description = lspStatus === 'disabled'
                ? 'Synesis LSP is disabled in settings.'
                : 'Waiting for Synesis LSP to initialize...';
            this._setPlaceholder(label, description);
            await this._setHasOntologyAnnotations(false);
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            const activeFile = document && document.uri ? document.uri.fsPath : null;
            const annotations = await this.dataService.getOntologyAnnotations(activeFile);
            const entries = Array.isArray(annotations) ? annotations : [];

            // Check if data actually changed
            const newHash = this._hashData(entries, activeFile);
            if (newHash === this._lastDataHash && activeFile === this._lastActiveFile) {
                // Data hasn't changed, skip update
                return;
            }
            this._lastDataHash = newHash;
            this._lastActiveFile = activeFile;

            this.annotations.clear();
            for (const entry of entries) {
                this.annotations.set(entry.code, entry);
            }

            await this._setHasOntologyAnnotations(this.annotations.size > 0);
            this._updateTitle();
            this._onDidChangeTreeData.fire();
        } catch (error) {
            console.error('OntologyAnnotationExplorer: Error loading annotations:', error);
            await this._setHasOntologyAnnotations(false);
            vscode.window.showErrorMessage(`Failed to load ontology annotations: ${error.message}`);
        }
    }

    getTreeItem(element) {
        return element;
    }

    async getChildren(element) {
        if (!element) {
            if (this.placeholder) {
                return [this.placeholder];
            }

            const items = [];
            const filter = this.filterText;
            for (const [code, data] of this.annotations.entries()) {
                if (filter && !code.toLowerCase().includes(filter)) {
                    continue;
                }
                items.push(new AnnotationTreeItem(code, data));
            }
            return items.sort((a, b) => a.code.localeCompare(b.code));
        }

        if (element.isPlaceholder) {
            return [];
        }

        if (element instanceof AnnotationTreeItem) {
            return (element.occurrences || []).map(occ => new OccurrenceTreeItem(occ));
        }

        return [];
    }

    _isSynDocument(document) {
        if (!document || !document.uri) {
            return false;
        }
        return document.uri.fsPath.toLowerCase().endsWith('.syn');
    }

    async _setHasOntologyAnnotations(value) {
        await vscode.commands.executeCommand('setContext', 'synesis.hasOntologyAnnotations', value);
    }

    _getLspStatus() {
        const client = this.dataService && this.dataService.lspClient;
        if (!client) {
            return 'disabled';
        }
        if (typeof client.isReady !== 'function' || !client.isReady()) {
            return 'loading';
        }
        return 'ready';
    }

    _setPlaceholder(label, description) {
        this.placeholder = new StatusTreeItem(label, description);
    }

    setFilter(text) {
        this.filterText = (text || '').trim().toLowerCase();
        this._setFilterActive(this.filterText.length > 0);
        this._onDidChangeTreeData.fire();
    }

    getFilter() {
        return this.filterText;
    }

    async _setFilterActive(value) {
        await vscode.commands.executeCommand('setContext', 'synesis.ontology.annotation.filterActive', value);
    }

    _updateTitle() {
        if (!this._treeView) return;
        const n = this.annotations.size;
        this._treeView.title = n > 0 ? `Ontology (${n})` : 'Ontology';
    }
}

class AnnotationTreeItem extends vscode.TreeItem {
    constructor(code, data) {
        const occurrences = Array.isArray(data.occurrences) ? data.occurrences : [];
        const state = occurrences.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

        super(code, state);

        this.code = code;
        this.occurrences = occurrences;
        this.contextValue = 'ontologyAnnotationCode';
        this.iconPath = new vscode.ThemeIcon(data.ontologyDefined ? 'symbol-key' : 'symbol-variable');

        const n = occurrences.length;

        if (data.ontologyDefined && data.ontologyFile) {
            const lineLabel = typeof data.ontologyLine === 'number' && data.ontologyLine >= 0
                ? data.ontologyLine + 1
                : '?';
            this.description = `(${n}) · Ln ${lineLabel}`;
            this.tooltip = data.ontologyFile;
        } else if (!data.ontologyDefined) {
            this.description = `(${n}) · not in ontology`;
        } else {
            this.description = `(${n})`;
        }
    }
}

class OccurrenceTreeItem extends vscode.TreeItem {
    constructor(occurrence) {
        const lineLabel = typeof occurrence.line === 'number' && occurrence.line >= 0
            ? occurrence.line + 1
            : '?';

        super(`Ln ${lineLabel}`, vscode.TreeItemCollapsibleState.None);

        const ctx = (occurrence.context || 'code').toLowerCase();
        const fld = (occurrence.field || '').toLowerCase();
        this.description = (ctx === 'chain' || fld === 'chain') ? 'chain' : '';
        this.iconPath = new vscode.ThemeIcon(occurrence.file ? 'file' : 'question');
        this.tooltip = occurrence.file || '<location not available>';
        this.contextValue = 'ontologyAnnotationOccurrence';

        if (occurrence.file) {
            this.command = {
                command: 'synesis.openLocation',
                title: 'Open Location',
                arguments: [occurrence.file, occurrence.line || 0, occurrence.column || 0]
            };
        }
    }
}

class StatusTreeItem extends vscode.TreeItem {
    constructor(label, description) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = description || '';
        this.tooltip = description || '';
        this.iconPath = new vscode.ThemeIcon('sync');
        this.contextValue = 'status';
        this.isPlaceholder = true;
    }
}

module.exports = OntologyAnnotationExplorer;
