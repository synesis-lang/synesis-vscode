/**
 * workspaceScanner.js - Busca e indexa arquivos Synesis no workspace
 *
 * Propósito:
 *     Encontra arquivos .syn, .synt, .synp no workspace VSCode.
 *     Fornece interface simples para explorers.
 *
 * Componentes principais:
 *     - findSynFiles: Glob para arquivos .syn
 *     - findProjectFile: Localiza .synp (com quick pick se múltiplos)
 *     - findTemplateFile: Localiza .synt associado ao projeto
 *
 * Dependências críticas:
 *     - vscode: API de workspace
 *
 * Exemplo de uso:
 *     const scanner = new WorkspaceScanner();
 *     const synFiles = await scanner.findSynFiles();
 *     const project = await scanner.findProjectFile();
 */

const path = require('path');
const vscode = require('vscode');
const projectLoader = require('./projectLoader');
const { expandInclude } = require('./includeExpander');

class WorkspaceScanner {
    /**
     * Busca todos os arquivos .syn no workspace
     * @returns {Promise<vscode.Uri[]>}
     */
    async findSynFiles(projectUri) {
        const project = await this._loadProject(projectUri);
        if (project) {
            const included = await this._collectIncludedFiles(project, '.syn');
            if (included.length > 0) {
                return included;
            }
            return await this._findFilesInFolder(project.dir, '**/*.syn');
        }

        return await this._findFilesInActiveWorkspace('**/*.syn');
    }

    /**
     * Busca todos os arquivos .syno no workspace
     * @returns {Promise<vscode.Uri[]>}
     */
    async findSynoFiles(projectUri) {
        const project = await this._loadProject(projectUri);
        if (project) {
            const included = await this._collectIncludedFiles(project, '.syno');
            if (included.length > 0) {
                return included;
            }
            return await this._findFilesInFolder(project.dir, '**/*.syno');
        }

        return await this._findFilesInActiveWorkspace('**/*.syno');
    }

    /**
     * Busca arquivo .synp (projeto). Se múltiplos, pede ao usuário escolher.
     * @returns {Promise<vscode.Uri|null>}
     */
    async findProjectFile() {
        const workspaceFolder = this._getActiveWorkspaceFolder();
        if (!workspaceFolder) {
            return null;
        }

        const projects = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceFolder, '**/*.synp'),
            '**/node_modules/**'
        );

        if (projects.length === 0) {
            return null;
        }

        if (projects.length === 1) {
            return projects[0];
        }

        const preferred = this._pickClosestProject(projects);
        if (preferred) {
            return preferred;
        }

        // Múltiplos projetos: mostrar quick pick no workspace ativo
        const items = projects.map(uri => ({
            label: this._getFileName(uri),
            description: this._getRelativePath(uri),
            uri: uri
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Multiple Synesis projects found. Select one:'
        });

        return selected ? selected.uri : null;
    }

    /**
     * Busca arquivo .synt (template) no mesmo diretório do projeto
     * @param {vscode.Uri} projectUri - URI do arquivo .synp
     * @returns {Promise<vscode.Uri|null>}
     */
    async findTemplateFile(projectUri) {
        if (!projectUri) {
            return null;
        }

        const projectDir = this._getDirectory(projectUri);
        const templates = await vscode.workspace.findFiles(
            new vscode.RelativePattern(projectDir, '**/*.synt'),
            '**/node_modules/**'
        );

        return templates.length > 0 ? templates[0] : null;
    }

    /**
     * Extrai nome do arquivo de uma URI
     * @private
     */
    _getFileName(uri) {
        return path.basename(uri.fsPath || '');
    }

    /**
     * Extrai caminho relativo ao workspace
     * @private
     */
    _getRelativePath(uri) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (!workspaceFolder) {
            return uri.fsPath;
        }
        return path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
    }

    /**
     * Extrai diretório de uma URI
     * @private
     */
    _getDirectory(uri) {
        return path.dirname(uri.fsPath || '');
    }

    _getActiveWorkspaceFolder(document) {
        const doc = document || vscode.window.activeTextEditor?.document;
        if (doc && doc.uri) {
            const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
            if (folder) {
                return folder;
            }
        }
        const folders = vscode.workspace.workspaceFolders;
        return folders && folders.length > 0 ? folders[0] : null;
    }

    _pickClosestProject(projects) {
        const document = vscode.window.activeTextEditor?.document;
        if (!document || !document.uri) {
            return null;
        }

        const docPath = document.uri.fsPath;
        let best = null;
        let bestDepth = -1;

        for (const uri of projects) {
            const projectDir = path.dirname(uri.fsPath);
            if (!docPath.startsWith(projectDir + path.sep) && docPath !== uri.fsPath) {
                continue;
            }

            const depth = projectDir.split(path.sep).length;
            if (depth > bestDepth) {
                bestDepth = depth;
                best = uri;
            }
        }

        return best;
    }

    async _loadProject(projectUri) {
        const projectFile = projectUri || await this.findProjectFile();
        if (!projectFile) {
            return null;
        }

        try {
            return await projectLoader.load(projectFile);
        } catch (error) {
            console.warn('Failed to load project file:', error);
            return null;
        }
    }

    async _collectIncludedFiles(project, extension) {
        if (!project || !Array.isArray(project.includes) || project.includes.length === 0) {
            return [];
        }

        // Mesma regra do compilador (includeExpander): arquivo, curinga ou pasta
        // recursiva, restritos ao projeto e em ordem estável. Antes o curinga ia
        // ao findFiles como caminho ABSOLUTO — que ele não casa —, e a lista caía
        // no fallback "todos os .syn da pasta", incluindo arquivos não declarados.
        const results = new Map();
        for (const include of project.includes) {
            if (!include?.path) {
                continue;
            }
            const shared = Boolean(include.shared) && include.type === 'ONTOLOGY';
            const { files } = expandInclude(project.dir, include.path, extension, { shared });
            for (const file of files) {
                if (this._matchesExtension(file, extension)) {
                    results.set(file, vscode.Uri.file(file));
                }
            }
        }

        return Array.from(results.values());
    }

    _matchesExtension(filePath, extension) {
        return path.extname(filePath || '').toLowerCase() === extension;
    }

    async _findFilesInActiveWorkspace(pattern) {
        const workspaceFolder = this._getActiveWorkspaceFolder();
        if (!workspaceFolder) {
            return [];
        }
        return await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceFolder, pattern),
            '**/node_modules/**'
        );
    }

    async _findFilesInFolder(folderPath, pattern) {
        if (!folderPath) {
            return [];
        }
        return await vscode.workspace.findFiles(
            new vscode.RelativePattern(folderPath, pattern),
            '**/node_modules/**'
        );
    }
}

module.exports = WorkspaceScanner;
