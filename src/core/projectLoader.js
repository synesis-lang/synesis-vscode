/**
 * projectLoader.js - Carrega arquivos .synp e resolve paths
 *
 * Proposito:
 *     Le o arquivo de projeto e extrai dados relevantes.
 *     Resolve caminhos relativos para template e includes.
 *
 * Componentes principais:
 *     - load: Carrega e parseia o arquivo .synp
 *     - parseProject: Extrai nome, template, includes e metadata
 *
 * Dependencias criticas:
 *     - fs: leitura de arquivos
 *     - path: resolucao de paths
 */

const fs = require('fs');
const path = require('path');
const { expandIncludesOfType } = require('./includeExpander');

/**
 * Carrega um arquivo .synp e retorna metadados do projeto
 * @param {string|Object} projectUri - Caminho ou vscode.Uri
 * @returns {Promise<Object>}
 */
async function load(projectUri) {
    const projectPath = resolveProjectPath(projectUri);
    if (!projectPath) {
        throw new Error('Project path not provided');
    }

    const content = await fs.promises.readFile(projectPath, 'utf-8');
    const parsed = parseProject(content);
    if (!parsed) {
        throw new Error('PROJECT block not found');
    }

    const projectDir = path.dirname(projectPath);
    const templateToken = parsed.template || parsed.fields.template || null;

    const templatePath = templateToken
        ? path.resolve(projectDir, templateToken)
        : null;
    const includes = parsed.includes.map(include => ({
        type: include.type,
        path: include.path,
        shared: include.shared,
        absolutePath: path.resolve(projectDir, include.path)
    }));

    // Todos os .bib do projeto — várias linhas INCLUDE BIBLIOGRAPHY, curinga ou
    // pasta —, na ordem e pela regra do compilador (synesis >= 0.13). Antes só a
    // PRIMEIRA linha contava, e um curinga virava o caminho literal `fontes/*.bib`.
    let bibliographyPaths = expandIncludesOfType(projectDir, includes, 'BIBLIOGRAPHY');
    if (bibliographyPaths.length === 0 && parsed.fields.bibliography) {
        // Forma antiga `bibliography: arquivo.bib`, fora de INCLUDE.
        bibliographyPaths = [path.resolve(projectDir, parsed.fields.bibliography)];
    }

    return {
        path: projectPath,
        dir: projectDir,
        name: parsed.name || parsed.fields.name || null,
        templatePath,
        bibliographyPaths,
        // Compatibilidade: o primeiro .bib. Use bibliographyPaths.
        bibliographyPath: bibliographyPaths[0] || null,
        includes,
        metadata: parsed.metadata,
        description: parsed.description,
        fields: parsed.fields
    };
}

/**
 * Extrai dados do arquivo .synp
 * @private
 * @param {string} content
 * @returns {Object|null}
 */
function parseProject(content) {
    const headerMatch = content.match(/^\s*PROJECT\b([^\n]*)/mi);
    const name = headerMatch && headerMatch[1] ? headerMatch[1].trim() : null;

    const blockMatch = content.match(/PROJECT\b[^\n]*\n([\s\S]*?)END\s+PROJECT/mi);
    if (!blockMatch) {
        return null;
    }

    const blockContent = blockMatch[1];
    const template = extractSingleDirective(blockContent, 'TEMPLATE');
    const includes = extractIncludes(blockContent);
    const metadata = extractBlockFields(blockContent, 'METADATA');
    const description = extractBlockText(blockContent, 'DESCRIPTION');
    const fields = parseFieldEntries(stripBlocks(blockContent, ['METADATA', 'DESCRIPTION']));

    return {
        name,
        template,
        includes,
        metadata,
        description,
        fields
    };
}

/**
 * Extrai campos key:value
 * @private
 * @param {string} blockContent
 * @returns {Object}
 */
function parseFieldEntries(blockContent) {
    const fields = {};
    const lines = blockContent.split('\n');
    let currentField = null;
    let currentValue = [];

    for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        const fieldMatch = trimmed.match(/^([\p{L}\p{N}._-]+)\s*:\s*(.*)$/u);

        if (fieldMatch) {
            if (currentField) {
                fields[currentField] = currentValue.join('\n').trim();
            }

            currentField = fieldMatch[1];
            currentValue = [fieldMatch[2]];
        } else if (currentField) {
            currentValue.push(trimmed);
        }
    }

    if (currentField) {
        fields[currentField] = currentValue.join('\n').trim();
    }

    return fields;
}

function extractSingleDirective(content, directive) {
    const pattern = new RegExp(`^\\s*${directive}\\s+("([^"]+)"|([^\\s#]+))`, 'mi');
    const match = content.match(pattern);
    if (!match) {
        return null;
    }

    return match[2] || match[3] || null;
}

function extractIncludes(content) {
    const includes = [];
    // `SHARED` é opcional (INCLUDE SHARED ONTOLOGY "../comum.syno"). Sem este
    // grupo, a linha virava tipo `SHARED` com caminho `ONTOLOGY`.
    const pattern = /^\s*INCLUDE\s+(SHARED\s+)?([A-Z_]+)\s+("([^"]+)"|([^\s#]+))/gmi;

    let match;
    while ((match = pattern.exec(content)) !== null) {
        includes.push({
            type: match[2].toUpperCase(),
            path: match[4] || match[5],
            shared: Boolean(match[1])
        });
    }

    return includes;
}

function extractBlockFields(content, blockName) {
    const pattern = new RegExp(`${blockName}([\\s\\S]*?)END\\s+${blockName}`, 'i');
    const match = content.match(pattern);
    if (!match) {
        return {};
    }

    return parseFieldEntries(match[1]);
}

function extractBlockText(content, blockName) {
    const pattern = new RegExp(`${blockName}([\\s\\S]*?)END\\s+${blockName}`, 'i');
    const match = content.match(pattern);
    if (!match) {
        return null;
    }

    return match[1].trim();
}

function stripBlocks(content, blockNames) {
    let result = content;
    for (const name of blockNames) {
        const pattern = new RegExp(`${name}[\\s\\S]*?END\\s+${name}`, 'gi');
        result = result.replace(pattern, '');
    }
    return result;
}

/**
 * Normaliza caminho do projeto
 * @private
 * @param {string|Object} projectUri
 * @returns {string|null}
 */
function resolveProjectPath(projectUri) {
    if (!projectUri) {
        return null;
    }

    if (typeof projectUri === 'string') {
        return projectUri;
    }

    return projectUri.fsPath || null;
}

module.exports = {
    load,
    // exposto para teste
    extractIncludes
};
