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

class CoderService {
    /**
     * @param {import('../core/workspaceScanner')} workspaceScanner
     */
    constructor(workspaceScanner) {
        this._workspaceScanner = workspaceScanner;
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

        const content = editor.document.getText();
        const cursorOffset = editor.document.offsetAt(editor.selection.start);

        // 2. Detectar bibref
        let bibref = this._detectBibref(content, cursorOffset);
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
     *
     * Algoritmo:
     *   1. Parseia todos os blocos SOURCE e ITEM com offsets
     *   2. Encontra o bloco que contém o cursorOffset
     *   3. Fallback: bloco anterior mais próximo (cursor entre blocos)
     *
     * @param {string} content - Conteúdo completo do arquivo .syn
     * @param {number} cursorOffset - Posição absoluta do cursor
     * @returns {string|null} bibref sem '@', ou null se não encontrado
     */
    _detectBibref(content, cursorOffset) {
        const sources = this._parser.parseSourceBlocks(content, '');
        const items = this._parser.parseItems(content, '');

        // Mesclar e ordenar por startOffset
        const allBlocks = [...sources, ...items].sort((a, b) => a.startOffset - b.startOffset);

        if (allBlocks.length === 0) {
            return null;
        }

        // Buscar bloco que contém o cursor
        for (const block of allBlocks) {
            if (cursorOffset >= block.startOffset && cursorOffset <= block.endOffset) {
                return block.bibref.replace(/^@/, '');
            }
        }

        // Fallback: bloco anterior mais próximo
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
     *
     * @param {string} content - Conteúdo completo do arquivo .syn
     * @param {number} cursorOffset - Posição absoluta do cursor
     * @returns {number} Offset para inserção (após END ITEM/END SOURCE)
     */
    _findInsertionPoint(content, cursorOffset) {
        const sources = this._parser.parseSourceBlocks(content, '');
        const items = this._parser.parseItems(content, '');

        const allBlocks = [...sources, ...items].sort((a, b) => a.startOffset - b.startOffset);

        if (allBlocks.length === 0) {
            return content.length;
        }

        // Buscar bloco que contém o cursor
        for (const block of allBlocks) {
            if (cursorOffset >= block.startOffset && cursorOffset <= block.endOffset) {
                return block.endOffset;
            }
        }

        // Fallback: após o bloco anterior mais próximo
        let nearest = null;
        for (const block of allBlocks) {
            if (block.startOffset <= cursorOffset) {
                nearest = block;
            } else {
                break;
            }
        }

        return nearest ? nearest.endOffset : content.length;
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
                    encoding: 'utf-8'
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
        // Normalizar aspas (mesmo padrão de startLspClient)
        return String(raw || 'synesis-coder').trim()
            .replace(/^"(.*)"$/, '$1')
            .replace(/^'(.*)'$/, '$1');
    }
}

module.exports = CoderService;
