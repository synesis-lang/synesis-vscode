/**
 * coderService.js - Integração com synesis-coder CLI
 *
 * Propósito:
 *     Encapsula chamadas ao synesis-coder item mode a partir do editor.
 *     Detecta bibref do contexto do cursor, chama o CLI e insere o resultado.
 *
 * Componentes principais:
 *     - codeSelection: Orquestrador principal (comando do menu de contexto)
 *     - _detectBibref: Detecta bibref do bloco sob o cursor
 *     - _findInsertionPoint: Calcula posição de inserção após bloco corrente
 *     - _runCoderCli: Executa synesis-coder via child_process.execFile
 *
 * Dependências críticas:
 *     - SynesisParser: parseSourceBlocks/parseItems (offsets de blocos)
 *     - WorkspaceScanner: findProjectFile (localiza .synp)
 *     - child_process: execFile (invocação do CLI)
 *
 * Exemplo de uso:
 *     const coderService = new CoderService(workspaceScanner);
 *     // Registrado como handler de synesis.coder.codeSelection
 *     await coderService.codeSelection(editor);
 */

const { execFile } = require('child_process');
const vscode = require('vscode');
const SynesisParser = require('../parsers/synesisParser');
const { resolveExecutable } = require('../lsp/executableGuard');

class CoderService {
    /**
     * @param {import('../core/workspaceScanner')} workspaceScanner
     * @param {import('../services/dataService')} dataService
     */
    constructor(workspaceScanner, dataService) {
        this._workspaceScanner = workspaceScanner;
        this._dataService = dataService || null;
        this._parser = new SynesisParser();
    }

    /**
     * Comando principal: codifica seleção do editor via synesis-coder item.
     *
     * Fluxo:
     *   1. Valida seleção não-vazia
     *   2. Detecta bibref do bloco sob o cursor (ou pede ao usuário)
     *   3. Localiza .synp via workspaceScanner
     *   4. Chama synesis-coder item com progress indicator
     *   5. Insere bloco ITEM gerado após o bloco corrente
     *
     * @param {vscode.TextEditor} editor
     */
    async codeSelection(editor) {
        // 1. Validar seleção
        if (editor.selection.isEmpty) {
            vscode.window.showWarningMessage('Selecione um trecho de texto para codificar.');
            return;
        }

        const selectedText = editor.document.getText(editor.selection);
        if (!selectedText.trim()) {
            vscode.window.showWarningMessage('A seleção está vazia.');
            return;
        }

        // 2. Detectar bibref (via LSP com fallback local)
        let bibref = await this._detectBibref(editor);
        if (!bibref) {
            const input = await vscode.window.showInputBox({
                prompt: 'Nenhum bloco SOURCE/ITEM encontrado. Informe o bibref (ex: smith2024)',
                placeHolder: 'smith2024'
            });
            if (!input) {
                return; // cancelou
            }
            bibref = input.replace(/^@/, '');
        }

        // 3. Localizar .synp
        const projectUri = await this._workspaceScanner.findProjectFile();
        if (!projectUri) {
            vscode.window.showErrorMessage(
                'Nenhum arquivo .synp encontrado no workspace. ' +
                'Abra uma pasta que contenha um projeto Synesis.'
            );
            return;
        }

        const projectPath = projectUri.fsPath;

        // 4. Chamar synesis-coder com progress
        let output;
        try {
            output = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Synesis: Codificando seleção...',
                    cancellable: true
                },
                (progress, token) => this._runCoderCli(projectPath, bibref, selectedText, token)
            );
        } catch (error) {
            if (error.cancelled) {
                return; // cancelamento do usuário
            }
            vscode.window.showErrorMessage(`Synesis Coder: ${error.message}`);
            return;
        }

        if (!output || !output.trim()) {
            vscode.window.showWarningMessage('synesis-coder não retornou nenhum conteúdo.');
            return;
        }

        // 5. Substituir seleção pelo bloco ITEM gerado
        await editor.edit(editBuilder => {
            editBuilder.replace(editor.selection, '\n\n' + output.trim() + '\n');
        });
    }

    /**
     * Detecta o bibref do bloco SOURCE ou ITEM que contém o cursor.
     * Usa LSP (getBlocks) como fonte primária; parser local como fallback transitório.
     *
     * @param {vscode.TextEditor} editor
     * @returns {Promise<string|null>} bibref sem '@', ou null se não encontrado
     */
    async _detectBibref(editor) {
        const document = editor.document;
        const cursorOffset = document.offsetAt(editor.selection.start);
        const file = document.uri.fsPath;

        // Caminho primário: LSP estruturado (sem regex de gramática)
        if (this._dataService) {
            try {
                const blocks = await this._dataService.getBlocks(file);
                if (blocks && blocks.length > 0) {
                    return _bibrefFromLspBlocks(blocks, document, cursorOffset);
                }
            } catch (err) {
                console.warn('CoderService._detectBibref: LSP getBlocks failed, falling back to parser:', err.message);
            }
        }

        // Fallback: parser local (transitório — removido quando getBlocks estiver estável)
        const content = document.getText();
        const sources = this._parser.parseSourceBlocks(content, file);
        const items = this._parser.parseItems(content, file);
        const allBlocks = [...sources, ...items].sort((a, b) => a.startOffset - b.startOffset);

        for (const block of allBlocks) {
            if (cursorOffset >= block.startOffset && cursorOffset <= block.endOffset) {
                return block.bibref.replace(/^@/, '');
            }
        }

        let nearest = null;
        for (const block of allBlocks) {
            if (block.startOffset <= cursorOffset) {
                nearest = block;
            } else {
                break;
            }
        }
        return nearest ? nearest.bibref.replace(/^@/, '') : null;
    }

    /**
     * Calcula a posição de inserção após o bloco que contém o cursor.
     * Usa blocos LSP via getBlocks quando disponíveis.
     *
     * @param {vscode.TextEditor} editor
     * @param {Array|null} lspBlocks - blocos já carregados (reutiliza chamada anterior)
     * @returns {Promise<vscode.Position>} posição de inserção (fim do bloco)
     */
    async _findInsertionPoint(editor, lspBlocks) {
        const document = editor.document;
        const cursorOffset = document.offsetAt(editor.selection.start);

        if (lspBlocks && lspBlocks.length > 0) {
            let nearest = null;
            for (const block of lspBlocks) {
                const startOffset = document.offsetAt(
                    new vscode.Position(block.range.start.line, block.range.start.character)
                );
                const endOffset = document.offsetAt(
                    new vscode.Position(block.range.end.line, block.range.end.character)
                );
                if (cursorOffset >= startOffset && cursorOffset <= endOffset) {
                    return document.positionAt(endOffset);
                }
                if (startOffset <= cursorOffset) {
                    nearest = endOffset;
                }
            }
            if (nearest !== null) {
                return document.positionAt(nearest);
            }
        }

        // Fallback: parser local
        const content = document.getText();
        const file = document.uri.fsPath;
        const sources = this._parser.parseSourceBlocks(content, file);
        const items = this._parser.parseItems(content, file);
        const allBlocks = [...sources, ...items].sort((a, b) => a.startOffset - b.startOffset);

        for (const block of allBlocks) {
            if (cursorOffset >= block.startOffset && cursorOffset <= block.endOffset) {
                return document.positionAt(block.endOffset);
            }
        }
        let nearestEnd = null;
        for (const block of allBlocks) {
            if (block.startOffset <= cursorOffset) {
                nearestEnd = block.endOffset;
            } else {
                break;
            }
        }
        return document.positionAt(nearestEnd !== null ? nearestEnd : content.length);
    }

    /**
     * Executa synesis-coder item via child_process.execFile.
     *
     * Usa execFile (não exec) para evitar problemas de shell escaping
     * com textos contendo aspas, newlines e caracteres especiais.
     *
     * @param {string} projectPath - Caminho absoluto para o .synp
     * @param {string} bibref - Referência bibliográfica (sem @)
     * @param {string} text - Texto selecionado
     * @param {vscode.CancellationToken} token - Token de cancelamento
     * @returns {Promise<string>} stdout do CLI (bloco ITEM gerado)
     */
    _runCoderCli(projectPath, bibref, text, token) {
        return new Promise((resolve, reject) => {
            const coderPath = this._getCoderPath();
            const args = [
                'item',
                '--project', projectPath,
                '--bibref', bibref,
                '--text', text
            ];

            const child = execFile(
                coderPath,
                args,
                {
                    timeout: 120000,
                    maxBuffer: 1024 * 1024,
                    encoding: 'utf-8',
                    env: {
                        ...process.env,
                        PYTHONUTF8: '1',
                        PYTHONIOENCODING: 'utf-8',
                    }
                },
                (error, stdout, stderr) => {
                    if (error) {
                        if (error.killed) {
                            reject({ message: 'Operação cancelada.', cancelled: true });
                            return;
                        }

                        // Detectar erro de executável não encontrado
                        if (error.code === 'ENOENT') {
                            reject({
                                message: `synesis-coder não encontrado em '${coderPath}'. ` +
                                    'Instale com: pip install synesis-coder'
                            });
                            return;
                        }

                        // Usar stderr para mensagem de erro (o CLI escreve erros lá)
                        const errorMsg = (stderr || '').trim() || error.message;
                        reject({ message: errorMsg });
                        return;
                    }

                    resolve(stdout || '');
                }
            );

            // Suporte a cancelamento pelo usuário
            if (token) {
                token.onCancellationRequested(() => {
                    child.kill();
                });
            }
        });
    }

    /**
     * Lê o caminho do executável synesis-coder da configuração.
     * @returns {string}
     */
    _getCoderPath() {
        const config = vscode.workspace.getConfiguration('synesisExplorer');
        const raw = config.get('coder.path', 'synesis-coder');
        // Defense in depth: never run an executable supplied by (or living
        // inside) an untrusted workspace. See src/lsp/executableGuard.js.
        const guard = resolveExecutable(raw, 'synesis-coder');
        if (guard.forcedDefault) {
            vscode.window.showWarningMessage(`Synesis Coder: ${guard.reason}.`);
        }
        return guard.command;
    }
}

/**
 * Resolve bibref a partir de blocos LSP e posição do cursor.
 *
 * @param {Array<{kind,bibref,range}>} blocks - blocos do LSP (ordenados por linha)
 * @param {vscode.TextDocument} document
 * @param {number} cursorOffset
 * @returns {string|null}
 */
function _bibrefFromLspBlocks(blocks, document, cursorOffset) {
    let lastBefore = null;

    for (const block of blocks) {
        const startOffset = document.offsetAt(
            new vscode.Position(block.range.start.line, block.range.start.character)
        );
        const endOffset = document.offsetAt(
            new vscode.Position(block.range.end.line, block.range.end.character)
        );

        if (cursorOffset >= startOffset && cursorOffset <= endOffset) {
            return block.bibref || null;
        }

        if (startOffset <= cursorOffset) {
            lastBefore = block.bibref || null;
        }
    }

    return lastBefore;
}

module.exports = CoderService;
