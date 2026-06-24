/**
 * extension.js - Entry point for Synesis VSCode extension
 *
 * Propósito:
 *     Registra explorers, viewers, comandos e file watchers.
 *     Gerencia lifecycle da extensão.
 *
 * Componentes principais:
 *     - activate: Inicializa extensão e registra componentes
 *     - deactivate: Cleanup ao desativar extensão
 *
 * Dependências críticas:
 *     - vscode: API do VSCode
 *     - explorers: Reference, Code, Relation explorers
 *     - viewers: Graph, Abstract viewers
 *     - core: TemplateManager
 *
 * Notas de implementação:
 *     - Activation event: onStartupFinished (lazy loading)
 *     - File watchers para .syn, .synt, .synp
 *     - Template manager compartilhado entre explorers
 */

const path = require('path');
const vscode = require('vscode');
const SynesisLspClient = require('./src/lsp/synesisClient');
const DataService = require('./src/services/dataService');

// Core
const TemplateManager = require('./src/core/templateManager');
const WorkspaceScanner = require('./src/core/workspaceScanner');

// Explorers
const ReferenceExplorer = require('./src/explorers/reference/referenceExplorer');
const CodeExplorer = require('./src/explorers/code/codeExplorer');
const RelationExplorer = require('./src/explorers/relation/relationExplorer');
const OntologyExplorer = require('./src/explorers/ontology/ontologyExplorer');
const OntologyAnnotationExplorer = require('./src/explorers/ontology/ontologyAnnotationExplorer');
const { TemplateExplorer, goToField } = require('./src/explorers/template/templateExplorer');

// Viewers
const GraphViewer = require('./src/viewers/graphViewer');
const AbstractViewer = require('./src/viewers/abstractViewer');

// Services
const CoderService = require('./src/services/coderService');

let lspClient;
let lspStatusItem;
let lspLoadTimer;
let dataService;
let lspStartPromise;
let lspCommandLabel;
let lspCommandPath;
let lspCommandArgs;
let pendingLspWorkspaceRoot;
let referenceTreeView;
let codeTreeView;
let relationTreeView;

const MIN_LSP_VERSION = '0.13.0';
const SYNESIS_CUSTOM_METHODS = [
    {
        method: 'synesis/getReferences',
        dataServiceMethod: 'getReferences',
        legacy: ['synesis/get_references']
    },
    {
        method: 'synesis/getCodes',
        dataServiceMethod: 'getCodes',
        legacy: ['synesis/get_codes']
    },
    {
        method: 'synesis/getRelations',
        dataServiceMethod: 'getRelations',
        legacy: ['synesis/get_relations']
    },
    {
        method: 'synesis/getRelationGraph',
        dataServiceMethod: 'getRelationGraph',
        legacy: ['synesis/get_relation_graph']
    },
    {
        method: 'synesis/getOntologyTopics',
        dataServiceMethod: 'getOntologyTopics',
        legacy: ['synesis/get_ontology_topics']
    },
    {
        method: 'synesis/getOntologyAnnotations',
        dataServiceMethod: 'getOntologyAnnotations',
        legacy: ['synesis/get_ontology_annotations']
    }
];


/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('Synesis is now active');
    vscode.commands.executeCommand('setContext', 'synesis.hasCodes', false);
    vscode.commands.executeCommand('setContext', 'synesis.hasChains', false);
    vscode.commands.executeCommand('setContext', 'synesis.hasTopics', false);
    vscode.commands.executeCommand('setContext', 'synesis.hasOntologyAnnotations', false);
    vscode.commands.executeCommand('setContext', 'synesis.code.filterActive', false);
    vscode.commands.executeCommand('setContext', 'synesis.reference.filterActive', false);
    vscode.commands.executeCommand('setContext', 'synesis.ontology.filterActive', false);
    vscode.commands.executeCommand('setContext', 'synesis.ontology.annotation.filterActive', false);
    vscode.commands.executeCommand('setContext', 'synesis.relation.filterActive', false);

    // LSP setup
    const lspConfig = vscode.workspace.getConfiguration('synesisExplorer');
    const lspEnabled = lspConfig.get('lsp.enabled', true);
    const pythonPath = lspConfig.get('lsp.pythonPath', 'synesis-lsp');
    const lspArgs = lspConfig.get('lsp.args', []);

    lspStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    lspStatusItem.tooltip = 'Synesis LSP';
    lspStatusItem.show();
    context.subscriptions.push(lspStatusItem);

    if (lspEnabled) {
        lspClient = new SynesisLspClient();
        lspStartPromise = startLspClient(lspClient, pythonPath, lspArgs);
    } else {
        setLspStatus('disabled');
    }

    // Shared template manager
    const templateManager = new TemplateManager();
    const workspaceScanner = new WorkspaceScanner();

    // DataService (LSP-only adapter) — criado antes do CoderService para injeção
    dataService = new DataService({
        lspClient: lspClient || null,
        onLspIncompatible: () => setLspStatus('incompatible')
    });

    // Coder service (synesis-coder CLI integration)
    const coderService = new CoderService(workspaceScanner, dataService);

    // Injetar dataService no templateManager (após criação do DataService)
    templateManager.setDataService(dataService);

    // Initialize Reference Explorer
    const referenceExplorer = new ReferenceExplorer(dataService);
    referenceTreeView = vscode.window.createTreeView('synesisReferenceExplorer', {
        treeDataProvider: referenceExplorer,
        showCollapseAll: true
    });
    referenceExplorer._treeView = referenceTreeView;

    const codeExplorer = new CodeExplorer(dataService);
    codeTreeView = vscode.window.createTreeView('synesisCodeExplorer', {
        treeDataProvider: codeExplorer,
        showCollapseAll: true
    });
    codeExplorer._treeView = codeTreeView;

    const relationExplorer = new RelationExplorer(dataService);
    relationTreeView = vscode.window.createTreeView('synesisRelationExplorer', {
        treeDataProvider: relationExplorer,
        showCollapseAll: true
    });
    relationExplorer._treeView = relationTreeView;

    const ontologyExplorer = new OntologyExplorer(dataService);
    const ontologyTreeView = vscode.window.createTreeView('synesisOntologyTopicsExplorer', {
        treeDataProvider: ontologyExplorer,
        showCollapseAll: true
    });
    ontologyExplorer._treeView = ontologyTreeView;

    const ontologyAnnotationExplorer = new OntologyAnnotationExplorer(dataService);
    const ontologyAnnotationTreeView = vscode.window.createTreeView('synesisOntologyAnnotationExplorer', {
        treeDataProvider: ontologyAnnotationExplorer,
        showCollapseAll: true
    });
    ontologyAnnotationExplorer._treeView = ontologyAnnotationTreeView;

    const templateExplorer = new TemplateExplorer(dataService);
    const templateTreeView = vscode.window.createTreeView('synesisTemplateExplorer', {
        treeDataProvider: templateExplorer,
    });
    templateExplorer._treeView = templateTreeView;

    const abstractViewer = new AbstractViewer(workspaceScanner, templateManager, dataService);
    const graphViewer = new GraphViewer(dataService, context.extensionUri);

    // Register commands
    const refreshAllExplorers = () => {
        referenceExplorer.refresh();
        codeExplorer.refresh();
        relationExplorer.refresh();
        ontologyExplorer.refresh();
        ontologyAnnotationExplorer.refresh();
        templateExplorer.refresh();
    };

    // Debounce factory — each caller gets an independent timer (no cross-cancellation)
    class Debouncer {
        constructor(delay = 300) {
            this.delay = delay;
            this.timer = null;
        }
        run(fn) {
            clearTimeout(this.timer);
            this.timer = setTimeout(fn, this.delay);
        }
        cancel() {
            clearTimeout(this.timer);
        }
    }

    const editorChangeDebouncer = new Debouncer(200);
    // (lspLoadDebouncer managed separately via lspLoadTimer — kept as-is)

    // Selective refresh by file extension — avoids unnecessary LSP calls
    // .syn  → references, codes, ontology annotations (not topology/relations)
    // .syno → ontology topics + annotations
    // .synt → all (template change affects everything)
    // .bib  → references only
    // .synp → all (project change affects everything)
    const FILE_REFRESH_MAP = {
        '.syn':  ['reference', 'code', 'ontologyAnnotation'],
        '.syno': ['ontology', 'ontologyAnnotation'],
        '.synt': ['all'],
        '.bib':  ['reference'],
        '.synp': ['all'],
    };

    const refreshExplorersForFileType = (ext) => {
        const targets = FILE_REFRESH_MAP[ext] || ['all'];
        if (targets.includes('all')) {
            refreshAllExplorers();
            return;
        }
        if (targets.includes('reference')) referenceExplorer.refresh();
        if (targets.includes('code')) codeExplorer.refresh();
        if (targets.includes('relation')) relationExplorer.refresh();
        if (targets.includes('ontology')) ontologyExplorer.refresh();
        if (targets.includes('ontologyAnnotation')) ontologyAnnotationExplorer.refresh();
    };

    // debouncedRefresh kept for backward-compat with onDidChangeActiveTextEditor usage below
    const debouncedRefresh = (refreshFn, delay = 300) => {
        editorChangeDebouncer.delay = delay;
        editorChangeDebouncer.run(refreshFn);
    };

    const runLspLoadProject = async ({ showProgress, showErrorMessage, workspaceRoot, fileExt }) => {
        if (!lspClient || !lspClient.isReady()) {
            setLspStatus('error');
            if (showErrorMessage) {
                vscode.window.showErrorMessage('Synesis LSP is not ready.');
            }
            return;
        }

        const resolvedRoot = workspaceRoot || resolveWorkspaceRoot(vscode.window.activeTextEditor?.document);
        if (!resolvedRoot) {
            setLspStatus('error');
            if (showErrorMessage) {
                vscode.window.showErrorMessage('No workspace folder found to load project.');
            }
            return;
        }

        setLspStatus('loading');
        try {
            // Invalidate cache before loading so explorer refreshes fetch fresh data.
            lspClient.invalidateCache();
            const loadRequest = () => lspClient.sendRequest('synesis/loadProject', { workspaceRoot: resolvedRoot });
            const result = showProgress
                ? await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Window,
                        title: 'Synesis LSP: Loading project'
                    },
                    loadRequest
                )
                : await loadRequest();

            if (result && result.success) {
                setLspStatus('ready', result.stats, result.lsp_version, result.compiler_version);
                // Selective refresh: only update explorers affected by the saved file type.
                // Manual load (no fileExt) refreshes all explorers.
                if (fileExt) {
                    refreshExplorersForFileType(fileExt);
                } else {
                    refreshAllExplorers();
                }
            } else {
                setLspStatus('error');
                if (showErrorMessage) {
                    const message = result && result.error ? result.error : 'Unknown error from LSP.';
                    vscode.window.showErrorMessage(`Synesis LSP load failed: ${message}`);
                }
            }
        } catch (error) {
            setLspStatus('error');
            if (showErrorMessage) {
                vscode.window.showErrorMessage(`Synesis LSP load failed: ${error.message}`);
            }
        }
    };

    if (lspStartPromise) {
        lspStartPromise.then(async (started) => {
            if (started) {
                validateLspCapabilities();
                await validateSynesisCustomMethods();
                runLspLoadProject({ showProgress: true, showErrorMessage: true });
            } else {
                refreshAllExplorers();
            }
        });
    } else {
        setTimeout(() => refreshAllExplorers(), 500);
    }

    let pendingFileExt = null;
    const scheduleLspLoadProject = (document, fileExt) => {
        if (!lspClient || !lspClient.isReady()) {
            return;
        }
        if (lspLoadTimer) {
            clearTimeout(lspLoadTimer);
        }
        pendingLspWorkspaceRoot = resolveWorkspaceRoot(document) || pendingLspWorkspaceRoot;
        // If multiple saves arrive before the debounce fires, keep the broadest scope:
        // 'all' always wins over a specific type, otherwise use the latest file's type.
        if (fileExt && pendingFileExt) {
            const prevTargets = FILE_REFRESH_MAP[pendingFileExt] || ['all'];
            const newTargets  = FILE_REFRESH_MAP[fileExt] || ['all'];
            if (prevTargets.includes('all') || newTargets.includes('all')) {
                pendingFileExt = null; // null → refreshAllExplorers
            } else {
                pendingFileExt = fileExt;
            }
        } else {
            pendingFileExt = fileExt || null;
        }
        lspLoadTimer = setTimeout(() => {
            const ext = pendingFileExt;
            pendingFileExt = null;
            runLspLoadProject({
                showProgress: false,
                showErrorMessage: false,
                workspaceRoot: pendingLspWorkspaceRoot,
                fileExt: ext
            });
        }, 1000);
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.lsp.loadProject', async () => {
            await runLspLoadProject({
                showProgress: true,
                showErrorMessage: true,
                workspaceRoot: resolveWorkspaceRoot(vscode.window.activeTextEditor?.document)
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.reference.refresh', () => {
            referenceExplorer.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.reference.filter', async () => {
            const value = await vscode.window.showInputBox({
                prompt: 'Filter references by name (leave blank to show all)',
                value: referenceExplorer.getFilter()
            });

            if (value === undefined) {
                return;
            }

            referenceExplorer.setFilter(value);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.reference.filterActive', async () => {
            const value = await vscode.window.showInputBox({
                prompt: 'Filter references by name (leave blank to show all)',
                value: referenceExplorer.getFilter()
            });

            if (value === undefined) {
                return;
            }

            referenceExplorer.setFilter(value);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.code.refresh', () => {
            codeExplorer.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.code.filter', async () => {
            const value = await vscode.window.showInputBox({
                prompt: 'Filter codes by name (leave blank to show all)',
                value: codeExplorer.getFilter()
            });

            if (value === undefined) {
                return;
            }

            codeExplorer.setFilter(value);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.code.filterActive', async () => {
            const value = await vscode.window.showInputBox({
                prompt: 'Filter codes by name (leave blank to show all)',
                value: codeExplorer.getFilter()
            });

            if (value === undefined) {
                return;
            }

            codeExplorer.setFilter(value);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.relation.refresh', () => {
            relationExplorer.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.relation.filter', async () => {
            const value = await vscode.window.showInputBox({
                prompt: 'Filter relations by name (leave blank to show all)',
                value: relationExplorer.getFilter()
            });

            if (value === undefined) {
                return;
            }

            relationExplorer.setFilter(value);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.relation.filterActive', async () => {
            const value = await vscode.window.showInputBox({
                prompt: 'Filter relations by name (leave blank to show all)',
                value: relationExplorer.getFilter()
            });

            if (value === undefined) {
                return;
            }

            relationExplorer.setFilter(value);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.ontology.refresh', () => {
            ontologyExplorer.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.ontology.filter', async () => {
            const value = await vscode.window.showInputBox({
                prompt: 'Filter topics by name (leave blank to show all)',
                value: ontologyExplorer.getFilter()
            });

            if (value === undefined) {
                return;
            }

            ontologyExplorer.setFilter(value);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.ontology.filterActive', async () => {
            const value = await vscode.window.showInputBox({
                prompt: 'Filter topics by name (leave blank to show all)',
                value: ontologyExplorer.getFilter()
            });

            if (value === undefined) {
                return;
            }

            ontologyExplorer.setFilter(value);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.ontology.annotation.refresh', () => {
            ontologyAnnotationExplorer.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.ontology.annotation.filter', async () => {
            const value = await vscode.window.showInputBox({
                prompt: 'Filter ontology annotations by name (leave blank to show all)',
                value: ontologyAnnotationExplorer.getFilter()
            });

            if (value === undefined) {
                return;
            }

            ontologyAnnotationExplorer.setFilter(value);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.ontology.annotation.filterActive', async () => {
            const value = await vscode.window.showInputBox({
                prompt: 'Filter ontology annotations by name (leave blank to show all)',
                value: ontologyAnnotationExplorer.getFilter()
            });

            if (value === undefined) {
                return;
            }

            ontologyAnnotationExplorer.setFilter(value);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.showAbstract', () => {
            abstractViewer.showAbstract();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.showGraph', () => {
            graphViewer.showGraph();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.showGraphPerFile', () => {
            graphViewer.showGraphForFile();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.showGraphPerItem', () => {
            graphViewer.showGraphForItem();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.template.goToField', async (fieldName) => {
            await goToField(fieldName);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.template.refresh', () => {
            templateExplorer.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.openLocation', (filePath, line, column) => {
            openLocation(filePath, line, column);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.code.goToDefinition', async (treeItem) => {
            // Fallback: keybinding (F12) não passa treeItem, usar seleção do tree view
            if (!treeItem && codeTreeView && codeTreeView.selection.length > 0) {
                treeItem = codeTreeView.selection[0];
            }
            if (!treeItem || !treeItem.code) {
                return;
            }

            const ontologyDef = await findOntologyDefinition(treeItem.code);
            if (ontologyDef) {
                openLocation(ontologyDef.file, ontologyDef.line || 0, 0);
                return;
            }

            const position = await findSymbolPosition(treeItem);
            if (!position) {
                vscode.window.showWarningMessage('Could not find code position for definition lookup.');
                return;
            }

            const definitions = await vscode.commands.executeCommand(
                'vscode.executeDefinitionProvider',
                position.uri,
                position.position
            );

            if (definitions && definitions.length > 0) {
                const def = definitions[0];
                const targetUri = def.targetUri || def.uri;
                const targetRange = def.targetRange || def.range;
                const doc = await vscode.workspace.openTextDocument(targetUri);
                const editor = await vscode.window.showTextDocument(doc);
                editor.selection = new vscode.Selection(targetRange.start, targetRange.start);
                editor.revealRange(targetRange, vscode.TextEditorRevealType.InCenter);
            } else {
                vscode.window.showWarningMessage(`No definition found for "${treeItem.code}".`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.code.rename', async (treeItem) => {
            if (!treeItem && codeTreeView && codeTreeView.selection.length > 0) {
                treeItem = codeTreeView.selection[0];
            }
            const oldName = treeItem ? treeItem.code : '';
            const renamed = await renameSymbol(treeItem, 'code', 'Enter new code name');
            if (renamed) {
                await runLspLoadProject({ showProgress: false, showErrorMessage: false });
                vscode.window.showInformationMessage(`Renamed code "${oldName}".`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.reference.rename', async (treeItem) => {
            if (!treeItem && referenceTreeView && referenceTreeView.selection.length > 0) {
                treeItem = referenceTreeView.selection[0];
            }
            const oldName = treeItem ? treeItem.bibref : '';
            const renamed = await renameSymbol(treeItem, 'bibref', 'Enter new reference name (with @)');
            if (renamed) {
                await runLspLoadProject({ showProgress: false, showErrorMessage: false });
                vscode.window.showInformationMessage(`Renamed reference "${oldName}".`);
            }
        })
    );

    // Synesis Coder: code selection via context menu
    context.subscriptions.push(
        vscode.commands.registerCommand('synesis.coder.codeSelection', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            await coderService.codeSelection(editor);
        })
    );

    // Active editor change - only refresh ontology annotations (context-specific)
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            updateActiveFileKind(editor);
            // Only refresh ontology annotations as it's file-specific
            debouncedRefresh(() => ontologyAnnotationExplorer.refresh(), 200);
        })
    );

    // File save handler - triggers LSP reload with selective explorer refresh
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(document => {
            const ext = path.extname(document.uri.fsPath || '').toLowerCase();
            if (ext === '.syn' || ext === '.syno' || ext === '.synp' || ext === '.synt' || ext === '.bib') {
                scheduleLspLoadProject(document, ext);
            }
        })
    );

    updateActiveFileKind(vscode.window.activeTextEditor);

    context.subscriptions.push(referenceTreeView);
    context.subscriptions.push(codeTreeView);
    context.subscriptions.push(relationTreeView);
    context.subscriptions.push(ontologyTreeView);
    context.subscriptions.push(ontologyAnnotationTreeView);
}

/**
 * Opens a file at a specific line number
 */
async function openLocation(filePath, line, column = 0) {
    try {
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);

        const position = new vscode.Position(line, Math.max(0, column || 0));
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to open location: ${error.message}`);
    }
}

/**
 * Finds a position in the workspace where a symbol (code or bibref) appears.
 * Used by Go to Definition and Rename handlers.
 */
async function findSymbolPosition(treeItem) {
    const symbol = treeItem.code || treeItem.bibref;
    if (!symbol) {
        return null;
    }

    const occurrences = Array.isArray(treeItem.occurrences) ? treeItem.occurrences : [];
    for (const occ of occurrences) {
        if (!occ || !occ.file) {
            continue;
        }
        const uri = vscode.Uri.file(occ.file);
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const lineIndex = typeof occ.line === 'number' ? occ.line : 0;
            if (lineIndex < 0 || lineIndex >= doc.lineCount) {
                continue;
            }
            const lineText = doc.lineAt(lineIndex).text;
            const preferredColumn = typeof occ.column === 'number' ? occ.column : 0;
            const resolvedColumn = findSymbolInLine(lineText, symbol, preferredColumn);
            if (resolvedColumn !== null) {
                return { uri, position: new vscode.Position(lineIndex, resolvedColumn) };
            }
        } catch (error) {
            console.warn('findSymbolPosition: failed to open document', occ.file, error.message);
        }
    }

    const files = await vscode.workspace.findFiles('**/*.syn', null, 50);
    for (const fileUri of files) {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const text = doc.getText();
        let idx = text.indexOf(symbol);
        if (idx < 0) {
            idx = text.toLowerCase().indexOf(symbol.toLowerCase());
        }
        if (idx >= 0) {
            const pos = doc.positionAt(idx);
            return { uri: fileUri, position: pos };
        }
    }

    return null;
}

function findSymbolInLine(lineText, symbol, preferredColumn = 0) {
    if (!lineText || !symbol) {
        return null;
    }

    const exactAt = lineText.indexOf(symbol, Math.max(0, preferredColumn));
    if (exactAt >= 0) {
        return exactAt;
    }

    const exact = lineText.indexOf(symbol);
    if (exact >= 0) {
        return exact;
    }

    const lowerLine = lineText.toLowerCase();
    const lowerSymbol = symbol.toLowerCase();
    const ciAt = lowerLine.indexOf(lowerSymbol, Math.max(0, preferredColumn));
    if (ciAt >= 0) {
        return ciAt;
    }

    const ci = lowerLine.indexOf(lowerSymbol);
    if (ci >= 0) {
        return ci;
    }

    return null;
}

async function findOntologyDefinition(code) {
    if (!code || !dataService) {
        return null;
    }

    const client = dataService.lspClient;
    const lspReady = Boolean(client && typeof client.isReady === 'function' && client.isReady());
    if (!lspReady) {
        return null;
    }

    try {
        const annotations = await dataService.getOntologyAnnotations();
        const normalized = String(code).toLowerCase();
        const match = (Array.isArray(annotations) ? annotations : []).find(
            (entry) => String(entry.code || '').toLowerCase() === normalized
        );
        if (match && match.ontologyFile) {
            return {
                file: match.ontologyFile,
                line: typeof match.ontologyLine === 'number' ? match.ontologyLine : 0
            };
        }
    } catch (error) {
        console.warn('findOntologyDefinition: failed to load ontology annotations:', error.message);
    }

    return null;
}

/**
 * Renames a symbol (code or bibref) using the LSP rename provider.
 * Returns true if rename was successful, false otherwise.
 */
async function renameSymbol(treeItem, symbolKey, promptMessage) {
    const symbol = treeItem ? treeItem[symbolKey] : null;
    if (!symbol) {
        return false;
    }

    const newName = await vscode.window.showInputBox({
        prompt: promptMessage,
        value: symbol,
        validateInput: (value) => {
            if (!value || !value.trim()) {
                return 'Name cannot be empty';
            }
            if (value.trim() === symbol) {
                return 'Name must be different';
            }
            return null;
        }
    });

    if (!newName) {
        return false;
    }

    const position = await findSymbolPosition(treeItem);
    if (!position) {
        vscode.window.showWarningMessage('Could not find symbol position for rename.');
        return false;
    }

    try {
        const edit = await vscode.commands.executeCommand(
            'vscode.executeDocumentRenameProvider',
            position.uri,
            position.position,
            newName.trim()
        );

        if (edit && edit.size > 0) {
            await vscode.workspace.applyEdit(edit);
            await vscode.workspace.saveAll(false);
            return true;
        } else {
            vscode.window.showWarningMessage('Rename failed. LSP may not be available.');
            return false;
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Rename failed: ${error.message}`);
        return false;
    }
}

function deactivate() {
    console.log('Synesis is now deactivated');
    if (lspClient) {
        lspClient.stop();
        lspClient = undefined;
    }
}

/**
 * Atualiza contexto do tipo de arquivo ativo
 * @param {vscode.TextEditor|undefined|null} editor
 */
function updateActiveFileKind(editor) {
    if (!editor || !editor.document || !editor.document.uri) {
        vscode.commands.executeCommand('setContext', 'synesis.activeFileKind', 'other');
        return;
    }

    const ext = path.extname(editor.document.uri.fsPath || '').toLowerCase();
    if (ext === '.syn') {
        vscode.commands.executeCommand('setContext', 'synesis.activeFileKind', 'syn');
        return;
    }
    if (ext === '.syno') {
        vscode.commands.executeCommand('setContext', 'synesis.activeFileKind', 'syno');
        return;
    }

    vscode.commands.executeCommand('setContext', 'synesis.activeFileKind', 'other');
}

function resolveWorkspaceRoot(document) {
    if (document && document.uri) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (folder && folder.uri && folder.uri.fsPath) {
            return folder.uri.fsPath;
        }
    }

    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : '';
}

async function startLspClient(client, pythonPath, lspArgs = []) {
    try {
        const normalizedPath = String(pythonPath || '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
        lspCommandPath = normalizedPath || pythonPath;
        lspCommandArgs = Array.isArray(lspArgs)
            ? lspArgs.map(value => String(value))
            : String(lspArgs || '').trim().split(/\s+/).filter(Boolean);
        const baseName = path.basename(lspCommandPath).toLowerCase();
        lspCommandLabel = baseName || lspCommandPath;
        setLspStatus('loading');
        await client.start(pythonPath, lspCommandArgs);
        lspCommandLabel = client.getEffectiveLabel() || lspCommandLabel;
        lspCommandPath = client.getEffectiveCommand() || lspCommandPath;
        lspCommandArgs = client.getEffectiveArgs() || lspCommandArgs;
        setLspStatus('ready');
        return true;
    } catch (error) {
        setLspStatus('error');
        const isNotFound = error.message && (
            error.message.includes('ENOENT') ||
            error.message.includes('not found') ||
            error.message.includes('not recognized')
        );
        const hint = isNotFound
            ? ` Is "${pythonPath}" installed and on PATH?`
            : '';
        vscode.window.showErrorMessage(`Failed to start Synesis LSP: ${error.message}.${hint}`);
        return false;
    }
}

function setLspStatus(state, stats, lspVersion, compilerVersion) {
    if (!lspStatusItem) {
        return;
    }

    const commandLabel = lspCommandLabel || 'LSP';
    const commandPath = lspCommandPath || '';
    const commandArgs = Array.isArray(lspCommandArgs) && lspCommandArgs.length > 0
        ? ` ${lspCommandArgs.join(' ')}`
        : '';

    const versionSuffix = (lspVersion || compilerVersion)
        ? ` — LSP v${lspVersion || '?'} · synesis v${compilerVersion || '?'}`
        : '';

    if (commandPath) {
        lspStatusItem.tooltip = `Synesis LSP: ${commandPath}${commandArgs}${versionSuffix}`;
    } else {
        lspStatusItem.tooltip = `Synesis LSP${versionSuffix}`;
    }

    if (state === 'disabled') {
        lspStatusItem.text = `$(circle-slash) LSP Disabled (${commandLabel})`;
        updateExplorerTitles('disabled');
        return;
    }

    if (state === 'loading') {
        lspStatusItem.text = `$(sync) LSP Loading (${commandLabel})`;
        updateExplorerTitles('loading');
        return;
    }

    if (state === 'error') {
        lspStatusItem.text = `$(alert) LSP Error (${commandLabel})`;
        updateExplorerTitles('error');
        return;
    }

    if (state === 'incompatible') {
        lspStatusItem.text = `$(alert) LSP Incompatível (${commandLabel})`;
        updateExplorerTitles('incompatible');
        return;
    }

    if (state === 'ready') {
        if (stats && typeof stats.source_count === 'number' && typeof stats.item_count === 'number') {
            const verLabel = (lspVersion && compilerVersion)
                ? ` [LSP v${lspVersion} · synesis v${compilerVersion}]`
                : '';
            lspStatusItem.text = `$(check) ${stats.source_count} fontes, ${stats.item_count} itens${verLabel}`;
        } else {
            lspStatusItem.text = `$(check) LSP Ready (${commandLabel})`;
        }
        updateExplorerTitles('ready');
    }
}

function validateLspCapabilities() {
    if (!lspClient || !lspClient.client || !lspClient.client.initializeResult) {
        console.warn('LSP client not initialized, skipping capability validation');
        return;
    }

    const caps = lspClient.client.initializeResult.capabilities;

    // Required capabilities — extension is degraded without these
    const required = [
        { key: 'hoverProvider',         label: 'Hover' },
        { key: 'definitionProvider',    label: 'Go to Definition' },
        { key: 'documentSymbolProvider',label: 'Document Symbols (required for Graph Viewer)' },
        { key: 'renameProvider',        label: 'Rename' },
        { key: 'completionProvider',    label: 'Completion' },
    ];

    // Optional capabilities — informational only
    const optional = [
        { key: 'signatureHelpProvider',   label: 'Signature Help' },
        { key: 'referencesProvider',      label: 'Find References' },
        { key: 'codeActionProvider',      label: 'Code Actions (Quick Fix)' },
        { key: 'semanticTokensProvider',  label: 'Semantic Tokens' },
        { key: 'inlayHintProvider',       label: 'Inlay Hints' },
        { key: 'documentHighlightProvider', label: 'Document Highlight' },
    ];

    const summary = {};
    required.forEach(c => { summary[c.label] = !!caps[c.key]; });
    optional.forEach(c => { summary[c.label] = !!caps[c.key]; });

    console.log('=== LSP Capabilities Validation ===');
    console.log('Capabilities:', JSON.stringify(summary, null, 2));

    const missing = required.filter(c => !caps[c.key]).map(c => c.label);
    const available = optional.filter(c => !!caps[c.key]).map(c => c.label);
    const unavailable = optional.filter(c => !caps[c.key]).map(c => c.label);

    if (available.length > 0) {
        console.log(`Optional features available: ${available.join(', ')}`);
    }
    if (unavailable.length > 0) {
        console.log(`Optional features not provided by this LSP version: ${unavailable.join(', ')}`);
    }

    if (missing.length > 0) {
        const message = `⚠️ Synesis LSP is missing critical capabilities: ${missing.join(', ')}. ` +
            `These features will NOT work. Please update synesis-lsp to v${MIN_LSP_VERSION}+ or later.`;

        console.error(message);
        vscode.window.showErrorMessage(message, 'Open Output').then(selection => {
            if (selection === 'Open Output') {
                vscode.commands.executeCommand('workbench.action.output.toggleOutput');
            }
        });
    } else {
        console.log(`✓ All required LSP capabilities validated: ${required.map(c => c.label).join(', ')}`);
    }
}

async function validateSynesisCustomMethods() {
    if (!lspClient || !lspClient.isReady()) {
        console.warn('LSP client not initialized, skipping Synesis method validation');
        return;
    }

    const workspaceRoot = resolveWorkspaceRoot(vscode.window.activeTextEditor?.document);
    const missing = [];
    const legacyOnly = [];

    for (const entry of SYNESIS_CUSTOM_METHODS) {
        const params = buildSynesisMethodParams(entry.method, workspaceRoot);
        const status = await trySynesisMethod(entry.method, params);

        if (status === 'ok') {
            continue;
        }

        if (status === 'not_found') {
            let legacySupported = false;

            for (const legacyMethod of entry.legacy || []) {
                const legacyStatus = await trySynesisMethod(legacyMethod, params);
                if (legacyStatus === 'ok') {
                    legacySupported = true;
                    break;
                }
            }

            if (legacySupported) {
                legacyOnly.push(entry.method);
            } else {
                missing.push(entry.method);
                if (dataService && dataService.unsupportedMethods) {
                    dataService.unsupportedMethods.add(entry.dataServiceMethod);
                }
            }
            continue;
        }

        console.warn(`Synesis LSP method validation failed: ${entry.method}`);
    }

    if (missing.length > 0) {
        setLspStatus('incompatible');
        const message = `Synesis LSP is missing custom methods: ${missing.join(', ')}. ` +
            `Please update synesis-lsp to v${MIN_LSP_VERSION}+ or later.`;
        console.error(message);
        vscode.window.showErrorMessage(message);
    }

    if (legacyOnly.length > 0) {
        const message = `Synesis LSP is using legacy method names (${legacyOnly.join(', ')}). ` +
            `Update synesis-lsp to v${MIN_LSP_VERSION}+ for full support.`;
        console.warn(message);
        vscode.window.showWarningMessage(message);
    }
}

function buildSynesisMethodParams(method, workspaceRoot) {
    const params = { workspaceRoot: workspaceRoot || '' };
    if (method === 'synesis/getRelationGraph') {
        params.bibref = '@placeholder';
    }
    return params;
}

async function trySynesisMethod(method, params) {
    try {
        await lspClient.sendRequest(method, params);
        return 'ok';
    } catch (error) {
        if (isMethodNotFound(error)) {
            return 'not_found';
        }
        console.warn(`Synesis LSP request failed for ${method}:`, error.message);
        return 'error';
    }
}

function isMethodNotFound(error) {
    return Boolean(error && (error.code === -32601 || /Method Not Found/i.test(error.message)));
}

function updateExplorerTitles(status) {
    const statusSuffix = {
        'loading': ' (LSP Loading...)',
        'ready': '',
        'incompatible': ' (LSP Incompatible)',
        'error': ' (LSP Error)',
        'disabled': ''
    };

    const suffix = statusSuffix[status] || '';

    if (referenceTreeView) {
        referenceTreeView.title = `References${suffix}`;
    }
    if (codeTreeView) {
        codeTreeView.title = `Codes${suffix}`;
    }
    if (relationTreeView) {
        relationTreeView.title = `Relations${suffix}`;
    }
}

module.exports = {
    activate,
    deactivate
};
