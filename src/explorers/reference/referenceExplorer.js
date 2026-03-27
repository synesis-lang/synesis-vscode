/**
 * referenceExplorer.js - TreeDataProvider para navegação de referências
 *
 * Propósito:
 *     Detecta e lista todas as referências SOURCE @bibref no workspace.
 *     Mostra ocorrências e contagem de ITEMs por referência.
 *
 * Componentes principais:
 *     - refresh: Obtém dados via DataService (LSP ou regex local)
 *     - getTreeItem: Retorna TreeItem para renderização
 *     - getChildren: Hierarquia (refs -> ocorrências)
 *
 * Dependências críticas:
 *     - DataService: LSP-only data access
 *
 * Exemplo de uso:
 *     const explorer = new ReferenceExplorer(dataService);
 *     await explorer.refresh();
 *     // TreeView mostra refs com ocorrências
 */

const path = require('path');
const vscode = require('vscode');

class ReferenceExplorer {
    constructor(dataService) {
        this.dataService = dataService;
        this.references = new Map(); // bibref -> [occurrences]
        this.filterText = '';
        this.placeholder = null;
        this._lastDataHash = null;
        this._treeView = null; // set by extension.js after createTreeView

        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }

    /**
     * Simple hash function for cache comparison
     */
    _hashData(refs) {
        if (!refs || refs.length === 0) {
            return 'empty';
        }
        const count = refs.length;
        const first = refs[0]?.bibref || '';
        const occCount = refs.reduce((sum, r) => sum + (r.occurrences?.length || 0), 0);
        return `${count}:${first}:${occCount}`;
    }

    /**
     * Obtém referências via DataService e atualiza índice
     */
    async refresh() {
        this.references.clear();
        this.placeholder = null;

        const lspStatus = this._getLspStatus();
        if (lspStatus !== 'ready') {
            const label = lspStatus === 'disabled' ? 'LSP disabled' : 'LSP not ready';
            const description = lspStatus === 'disabled'
                ? 'Synesis LSP is disabled in settings.'
                : 'Waiting for Synesis LSP to initialize...';
            this._setPlaceholder(label, description);
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            const refs = await this.dataService.getReferences();

            // Check if data actually changed
            const newHash = this._hashData(refs);
            if (newHash === this._lastDataHash) {
                // Data hasn't changed, skip update
                return;
            }
            this._lastDataHash = newHash;

            this.references.clear();
            for (const ref of refs) {
                this.references.set(ref.bibref, ref.occurrences);
            }

            this._updateTitle();
            this._onDidChangeTreeData.fire();
        } catch (error) {
            console.error('ReferenceExplorer: Error scanning workspace:', error);
            vscode.window.showErrorMessage(`Failed to scan workspace: ${error.message}`);
        }
    }

    /**
     * Retorna TreeItem para um elemento
     * @param {ReferenceTreeItem|OccurrenceTreeItem} element
     * @returns {vscode.TreeItem}
     */
    getTreeItem(element) {
        return element;
    }

    /**
     * Retorna filhos de um elemento
     * @param {ReferenceTreeItem|undefined} element
     * @returns {Promise<Array>}
     */
    async getChildren(element) {
        if (!element) {
            if (this.placeholder) {
                return [this.placeholder];
            }

            // Root level: lista de referências
            const items = [];
            const filter = this.filterText;

            for (const [bibref, occurrences] of this.references.entries()) {
                if (filter && !bibref.toLowerCase().includes(filter)) {
                    continue;
                }
                const totalItems = occurrences.reduce((sum, occ) => sum + occ.itemCount, 0);
                items.push(new ReferenceTreeItem(bibref, occurrences.length, totalItems, occurrences));
            }

            return items.sort((a, b) => a.bibref.localeCompare(b.bibref));
        }

        if (element.isPlaceholder) {
            return [];
        }

        // Child level: lista de ocorrências
        return element.occurrences.map(occ => new OccurrenceTreeItem(occ));
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

    /**
     * Atualiza o filtro por nome de referência
     * @param {string} text
     */
    setFilter(text) {
        this.filterText = (text || '').trim().toLowerCase();
        this._setFilterActive(this.filterText.length > 0);
        this._onDidChangeTreeData.fire();
    }

    /**
     * Retorna o filtro atual
     * @returns {string}
     */
    getFilter() {
        return this.filterText;
    }

    async _setFilterActive(value) {
        await vscode.commands.executeCommand('setContext', 'synesis.reference.filterActive', value);
    }

    _updateTitle() {
        if (!this._treeView) return;
        const n = this.references.size;
        this._treeView.title = n > 0 ? `References (${n})` : 'References';
    }
}

/**
 * TreeItem para uma referência (nível raiz)
 */
class ReferenceTreeItem extends vscode.TreeItem {
    constructor(bibref, occurrenceCount, itemCount, occurrences, title) {
        super(bibref, vscode.TreeItemCollapsibleState.Collapsed);

        this.bibref = bibref;
        this.occurrences = occurrences;

        this.description = `(${itemCount})`;
        this.iconPath = new vscode.ThemeIcon('book');
        this.contextValue = 'reference';
        this.tooltip = title || bibref;
    }
}

/**
 * TreeItem para uma ocorrência (nível filho)
 */
class OccurrenceTreeItem extends vscode.TreeItem {
    constructor(occurrence) {
        const lineLabel = typeof occurrence.line === 'number' && occurrence.line >= 0
            ? occurrence.line + 1
            : '?';

        super(`Ln ${lineLabel}`, vscode.TreeItemCollapsibleState.None);

        const n = occurrence.itemCount;
        this.description = `(${n})`;
        this.iconPath = new vscode.ThemeIcon('file');
        this.tooltip = occurrence.file;
        this.contextValue = 'occurrence';

        this.command = {
            command: 'synesis.openLocation',
            title: 'Open Location',
            arguments: [occurrence.file, occurrence.line]
        };
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

module.exports = ReferenceExplorer;
