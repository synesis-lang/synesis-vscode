/**
 * ontologyExplorer.js - TreeDataProvider para topicos de ontologia (via LSP)
 *
 * Proposito:
 *     Lista topicos da ontologia retornados pelo LSP (hierarquia).
 *     Permite navegacao para a definicao em .syno.
 *
 * Dependencias criticas:
 *     - DataService: LSP-only data access
 */

const path = require('path');
const vscode = require('vscode');

class OntologyExplorer {
    constructor(dataService) {
        this.dataService = dataService;
        this.topics = [];
        this.filterText = '';
        this.placeholder = null;
        this._lastDataHash = null; // Cache hash to avoid unnecessary refreshes
        this._treeView = null; // set by extension.js after createTreeView

        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }

    /**
     * Simple hash function for cache comparison
     */
    _hashData(topics) {
        if (!topics || topics.length === 0) {
            return 'empty';
        }
        const parts = [];
        this._flattenTopics(topics, parts);
        return parts.join('|');
    }

    _flattenTopics(topics, parts) {
        if (!Array.isArray(topics)) {
            return;
        }
        for (const topic of topics) {
            if (!topic) {
                continue;
            }
            const name = String(topic.name || '');
            const file = String(topic.file || '');
            const line = typeof topic.line === 'number' ? topic.line : -1;
            const level = typeof topic.level === 'number' ? topic.level : -1;
            const children = Array.isArray(topic.children) ? topic.children : [];
            parts.push(`${name}:${file}:${line}:${level}:${children.length}`);
            this._flattenTopics(children, parts);
        }
    }

    /**
     * Obtém tópicos via DataService e atualiza índice
     */
    async refresh() {
        this.placeholder = null;

        const lspStatus = this._getLspStatus();
        if (lspStatus !== 'ready') {
            const label = lspStatus === 'disabled' ? 'LSP disabled' : 'LSP not ready';
            const description = lspStatus === 'disabled'
                ? 'Synesis LSP is disabled in settings.'
                : 'Waiting for Synesis LSP to initialize...';
            this._setPlaceholder(label, description);
            await this._setHasTopics(false);
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            const topics = await this.dataService.getOntologyTopics();
            const topicsArray = Array.isArray(topics) ? topics : [];

            // Check if data actually changed
            const newHash = this._hashData(topicsArray);
            if (newHash === this._lastDataHash) {
                // Data hasn't changed, skip update
                return;
            }
            this._lastDataHash = newHash;

            this.topics = topicsArray;
            await this._setHasTopics(this.topics.length > 0);
            this._updateTitle();
            this._onDidChangeTreeData.fire();
        } catch (error) {
            console.error('OntologyExplorer: Error loading ontology topics:', error);
            await this._setHasTopics(false);
            vscode.window.showErrorMessage(`Failed to load ontology topics: ${error.message}`);
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

            const filtered = this._filterTopics(this.topics, this.filterText);
            return filtered.map(topic => new TopicTreeItem(topic));
        }

        if (element.isPlaceholder) {
            return [];
        }

        return (element.children || []).map(child => new TopicTreeItem(child));
    }

    async _setHasTopics(value) {
        await vscode.commands.executeCommand('setContext', 'synesis.hasTopics', value);
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
     * Atualiza o filtro por tópico
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
        await vscode.commands.executeCommand('setContext', 'synesis.ontology.filterActive', value);
    }

    _updateTitle() {
        if (!this._treeView) return;
        const n = this.topics.length;
        this._treeView.title = n > 0 ? `Ontology Topics (${n})` : 'Ontology Topics';
    }

    _filterTopics(topics, filterText) {
        if (!filterText) {
            return topics.filter(topic => !this._isNoiseTopic(topic));
        }

        const lowered = filterText.toLowerCase();
        const result = [];

        for (const topic of topics) {
            const name = String(topic.name || '');
            if (this._isNoiseTopic(topic)) {
                continue;
            }
            const nameMatch = name.toLowerCase().includes(lowered);
            const children = Array.isArray(topic.children) ? topic.children : [];
            const filteredChildren = this._filterTopics(children, filterText);

            if (nameMatch || filteredChildren.length > 0) {
                result.push({
                    ...topic,
                    children: filteredChildren
                });
            }
        }

        return result;
    }

    _isNoiseTopic(topic) {
        const name = String(topic && topic.name ? topic.name : '').trim().toUpperCase();
        return name === 'END ONTOLOGY' || name.startsWith('END ONTOLOGY');
    }
}

class TopicTreeItem extends vscode.TreeItem {
    constructor(topic) {
        const children = Array.isArray(topic.children) ? topic.children : [];
        const state = children.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

        const label = topic.name || '<unnamed>';
        super(label, state);

        this.children = children;
        this.contextValue = 'ontologyTopic';

        if (children.length > 0) {
            this.iconPath = new vscode.ThemeIcon('tag');
            this.description = `(${children.length})`;
        } else {
            this.iconPath = new vscode.ThemeIcon('pin');
            if (topic.file) {
                const lineLabel = typeof topic.line === 'number' && topic.line >= 0
                    ? topic.line + 1
                    : '?';
                this.description = `Ln ${lineLabel}`;
            }
        }

        if (topic.file) {
            this.tooltip = topic.file;
            this.command = {
                command: 'synesis.openLocation',
                title: 'Open Location',
                arguments: [topic.file, topic.line || 0, 0]
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

module.exports = OntologyExplorer;
