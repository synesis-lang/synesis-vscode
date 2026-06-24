/**
 * templateExplorer.js - TreeDataProvider para navegação no template Synesis
 *
 * Propósito:
 *     Lista os campos do template compilado agrupados por escopo (SOURCE / ITEM / ONTOLOGY).
 *     Ao clicar num campo, abre o arquivo .synt e move o cursor para a declaração FIELD.
 *
 * Dependências:
 *     - DataService: getTemplate() via LSP
 */

const vscode = require('vscode');

const TYPE_ICONS = {
    CODE:      'symbol-enum-member',
    CHAIN:     'type-hierarchy-sub',
    TEXT:      'symbol-string',
    QUOTATION: 'quote',
    ORDERED:   'list-ordered',
    BOOLEAN:   'symbol-boolean',
    NUMBER:    'symbol-number',
    FILE:      'file',
};

const SCOPE_ORDER = ['SOURCE', 'ITEM', 'ONTOLOGY'];

class TemplateExplorer {
    constructor(dataService) {
        this.dataService = dataService;
        this._fields = [];
        this._templateName = '';
        this._placeholder = null;
        this._treeView = null;

        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }

    async refresh() {
        this._fields = [];
        this._templateName = '';
        this._placeholder = null;

        const lspReady = Boolean(
            this.dataService &&
            this.dataService.lspClient &&
            this.dataService.lspClient.isReady()
        );

        if (!lspReady) {
            this._placeholder = 'LSP not ready';
            this._onDidChangeTreeData.fire();
            return;
        }

        const template = await this.dataService.getTemplate();
        if (!template || !Array.isArray(template.fields) || template.fields.length === 0) {
            this._placeholder = 'No template loaded';
            this._onDidChangeTreeData.fire();
            return;
        }

        this._templateName = template.name || '';
        this._fields = template.fields;
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element) {
        return element;
    }

    getChildren(element) {
        if (!element) {
            return this._getRoots();
        }
        if (element.contextValue === 'templateScope') {
            return this._getFieldsForScope(element.scopeKey);
        }
        return [];
    }

    _getRoots() {
        if (this._placeholder) {
            const item = new vscode.TreeItem(this._placeholder);
            item.contextValue = 'placeholder';
            return [item];
        }

        const usedScopes = new Set(this._fields.map(f => f.scope));
        return SCOPE_ORDER
            .filter(s => usedScopes.has(s))
            .map(scope => {
                const count = this._fields.filter(f => f.scope === scope).length;
                const item = new vscode.TreeItem(
                    `${scope} (${count})`,
                    vscode.TreeItemCollapsibleState.Expanded
                );
                item.scopeKey = scope;
                item.contextValue = 'templateScope';
                item.iconPath = new vscode.ThemeIcon('symbol-namespace');
                item.tooltip = `${count} fields in ${scope} scope`;
                return item;
            });
    }

    _getFieldsForScope(scope) {
        return this._fields
            .filter(f => f.scope === scope)
            .map(f => {
                const type = (f.type || '').toUpperCase();
                const label = f.name;
                const item = new vscode.TreeItem(
                    label,
                    vscode.TreeItemCollapsibleState.None
                );
                item.description = type;
                item.contextValue = 'templateField';
                item.fieldName = f.name;
                item.iconPath = new vscode.ThemeIcon(TYPE_ICONS[type] || 'symbol-field');

                const relationsStr = Array.isArray(f.relations) && f.relations.length > 0
                    ? `\nRelations: ${f.relations.join(', ')}`
                    : '';
                const arityStr = f.arity
                    ? `\nArity: ${typeof f.arity === 'object' ? `${f.arity.operator} ${f.arity.value}` : f.arity}`
                    : '';
                item.tooltip = `${f.name} (${type}) — ${scope}${arityStr}${relationsStr}`;

                item.command = {
                    command: 'synesis.template.goToField',
                    title: 'Go to Field',
                    arguments: [{ name: f.name, line: f.line, column: f.column }],
                };

                return item;
            });
    }
}

async function goToField(fieldData) {
    // fieldData: { name, line, column } — line/column são 0-based vindos do LSP
    const syntFiles = await vscode.workspace.findFiles('**/*.synt', '**/node_modules/**', 5);
    if (!syntFiles || syntFiles.length === 0) {
        vscode.window.showWarningMessage('No .synt template file found in the workspace.');
        return;
    }

    // Prefer already-open template file, fall back to first found
    const editors = vscode.window.visibleTextEditors;
    let targetUri = syntFiles[0];
    for (const e of editors) {
        if (e.document.uri.fsPath.endsWith('.synt')) {
            targetUri = e.document.uri;
            break;
        }
    }

    const doc = await vscode.workspace.openTextDocument(targetUri);
    const editor = await vscode.window.showTextDocument(doc);

    const line = typeof fieldData.line === 'number' ? fieldData.line : 0;
    const col = typeof fieldData.column === 'number' ? fieldData.column : 0;

    const position = new vscode.Position(line, col);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenter
    );
}

module.exports = { TemplateExplorer, goToField };
