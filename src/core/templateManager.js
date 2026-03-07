/**
 * templateManager.js - Gerencia cache de templates Synesis
 *
 * Propósito:
 *     Carrega, parseia e cacheia arquivos .synt para uso pelos explorers.
 *     Fornece fallback para defaults quando template indisponível.
 *
 * Componentes principais:
 *     - loadTemplate: Carrega template com cache
 *     - invalidateCache: Limpa cache quando template modificado
 *     - getDefaults: Retorna field definitions padrão
 *
 * Dependencias criticas:
 *     - projectLoader: Leitura de .synp e resolucao de paths
 *     - templateParser: Parse de .synt files
 *
 * Exemplo de uso:
 *     const manager = new TemplateManager();
 *     const fieldRegistry = await manager.loadTemplate(projectUri);
 *     const codeFields = fieldRegistry.getCodeFields();
 *
 * Notas de implementação:
 *     - Cache é Map<projectPath, fieldRegistry> para multi-project
 *     - Fallback para DEFAULT_FIELDS se parsing falhar
 */

const vscode = require('vscode');
const projectLoader = require('./projectLoader');
const templateParser = require('../parsers/templateParser');

const DEFAULT_FIELDS = {
    code: { type: 'CODE', scope: 'ITEM' },
    codes: { type: 'CODE', scope: 'ITEM' },
    chain: { type: 'CHAIN', scope: 'ITEM', relations: null },
    chains: { type: 'CHAIN', scope: 'ITEM', relations: null },
    text: { type: 'QUOTATION', scope: 'ITEM' },
    quote: { type: 'QUOTATION', scope: 'ITEM' },
    note: { type: 'MEMO', scope: 'ITEM' },
    description: { type: 'TEXT', scope: 'SOURCE' },
    epistemic_model: { type: 'TEXT', scope: 'SOURCE' },
    method: { type: 'TEXT', scope: 'SOURCE' }
};

class TemplateManager {
    constructor() {
        this.cache = new Map();
        this.cacheInfo = new Map();
    }

    /**
     * Carrega template do projeto, usando cache se disponível
     * @param {vscode.Uri|null} projectUri - URI do arquivo .synp
     * @returns {Promise<Object>} Field registry (field name -> field definition)
     */
    async loadTemplate(projectUri) {
        if (!projectUri) {
            console.log('No project file, using defaults');
            this._setCacheInfo('', {
                fromTemplate: false,
                hasChainFields: false,
                hasTopicFields: false
            });
            return DEFAULT_FIELDS;
        }

        const key = this._getProjectKey(projectUri);

        // Cache hit
        if (this.cache.has(key)) {
            return this.cache.get(key);
        }

        try {
            console.log(`Loading template for project: ${key}`);
            const project = await projectLoader.load(projectUri);

            if (!project.templatePath) {
                vscode.window.showWarningMessage(
                    'Template not found in project. Using default field names.'
                );
                this._setCacheInfo(key, {
                    fromTemplate: false,
                    hasChainFields: false,
                    hasTopicFields: false
                });
                this.cache.set(key, DEFAULT_FIELDS);
                return DEFAULT_FIELDS;
            }

            console.log(`Resolved template path: ${project.templatePath}`);
            const template = await templateParser.parse(project.templatePath);
            const registry = this.buildFieldRegistry(template);

            this._setCacheInfo(key, {
                fromTemplate: true,
                hasChainFields: this._hasChainFields(template),
                hasTopicFields: this._hasTopicFields(template)
            });
            this.cache.set(key, registry);
            return registry;
        } catch (error) {
            console.warn('Template load failed, using defaults:', error);
            vscode.window.showWarningMessage(
                'Template not found or invalid. Using default field names.'
            );
            this._setCacheInfo(key, {
                fromTemplate: false,
                hasChainFields: false,
                hasTopicFields: false
            });
            return DEFAULT_FIELDS;
        }
    }

    /**
     * Invalida cache de template(s)
     * @param {vscode.Uri|null} projectUri - URI específica ou null para limpar tudo
     */
    invalidateCache(projectUri = null) {
        if (projectUri) {
            const key = this._getProjectKey(projectUri);
            this.cache.delete(key);
            this.cacheInfo.delete(key);
            console.log(`Cache invalidated for: ${key}`);
        } else {
            this.cache.clear();
            this.cacheInfo.clear();
            console.log('All template cache cleared');
        }
    }

    /**
     * Retorna field definitions padrão
     * @returns {Object}
     */
    getDefaults() {
        return DEFAULT_FIELDS;
    }

    /**
     * Retorna informacoes sobre template carregado
     * @param {vscode.Uri|string|null} projectUri
     * @returns {Object|null}
     */
    getTemplateInfo(projectUri) {
        const key = this._getProjectKey(projectUri);
        return this.cacheInfo.get(key) || null;
    }

    /**
     * Converte template parseado em registry de fields
     * @param {Object} template
     * @returns {Object}
     */
    buildFieldRegistry(template) {
        const registry = {};

        if (!template || !Array.isArray(template.fields)) {
            return registry;
        }

        for (const fieldDef of template.fields) {
            registry[fieldDef.name] = {
                type: fieldDef.type,
                scope: fieldDef.scope,
                relations: fieldDef.relations || null,
                arity: fieldDef.arity || null,
                values: fieldDef.values || null,
                guidelines: fieldDef.guidelines || null
            };
        }

        return registry;
    }

    _hasChainFields(template) {
        if (!template || !Array.isArray(template.fields)) {
            return false;
        }

        return template.fields.some(field => field.type === 'CHAIN');
    }

    _hasTopicFields(template) {
        if (!template || !Array.isArray(template.fields)) {
            return false;
        }

        const topicTypes = new Set(['TOPIC', 'ORDERED', 'ENUMERATED']);
        return template.fields.some(field => topicTypes.has(field.type) && field.scope === 'ONTOLOGY');
    }

    _setCacheInfo(key, info) {
        if (!key) {
            return;
        }

        this.cacheInfo.set(key, info);
    }

    /**
     * Normaliza chave do projeto para o cache
     * @private
     */
    _getProjectKey(projectUri) {
        if (!projectUri) {
            return '';
        }

        if (typeof projectUri === 'string') {
            return projectUri;
        }

        return projectUri.fsPath || '';
    }
}

module.exports = TemplateManager;
