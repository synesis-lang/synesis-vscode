'use strict';

/**
 * Idioma dos PROMPTS do chat — o texto que vai ao modelo.
 *
 * A interface da extensão é em inglês (idioma oficial das saídas, 2026-11-17).
 * Os prompts são outra coisa: seguem o idioma do PROJETO, o mesmo que o
 * synesis-coder usa, declarado em `SYNESIS_CODER_LANGUAGE` no `.env`. O Social
 * Acceptance é todo em inglês; o face85, todo em português — um prompt num
 * idioma e um corpus em outro obriga o modelo a traduzir de cabeça termos que
 * ele precisa casar literalmente no banco.
 *
 * Ordem de busca (a mesma precedência do coder):
 *   1. `.env` da pasta do projeto (`.synp`), subindo até a raiz do workspace;
 *   2. `.env` ao lado do executável do coder, subindo (instalação editável);
 *   3. a variável de ambiente `SYNESIS_CODER_LANGUAGE` do processo;
 *   4. inglês.
 *
 * Só dois idiomas têm prompt escrito: `pt` (qualquer `pt-*`) e `en` (todo o
 * resto). A RESPOSTA continua no idioma da pergunta — isso é regra do prompt,
 * não desta escolha.
 */

const fs = require('fs');
const path = require('path');

const ENV_VAR = 'SYNESIS_CODER_LANGUAGE';
const LANGUAGES = Object.freeze(['en', 'pt']);
const DEFAULT_LANGUAGE = 'en';

let current = DEFAULT_LANGUAGE;

/** `pt-BR`, `PT`, `portuguese` → `pt`; qualquer outro valor não vazio → `en`. */
function normalizeLanguage(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) {
        return undefined;
    }
    return text.startsWith('pt') || text.startsWith('portug') ? 'pt' : 'en';
}

/** Valor de `SYNESIS_CODER_LANGUAGE` num texto de `.env`; `undefined` se ausente. */
function readEnvLanguage(text) {
    let found;
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match || match[1] !== ENV_VAR) {
            continue;
        }
        let value = match[2].trim();
        const quoted = /^(['"])(.*)\1$/.exec(value);
        value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '');
        found = value.trim();
    }
    return found || undefined;
}

/** Primeiro `.env` com a variável, de `startDir` subindo até `stopDir` (inclusive). */
function findEnvLanguage(startDir, stopDir, { fsImpl = fs, maxLevels = 12 } = {}) {
    if (!startDir) {
        return undefined;
    }
    let dir = path.resolve(startDir);
    const stop = stopDir ? path.resolve(stopDir) : undefined;
    for (let level = 0; level < maxLevels; level += 1) {
        const candidate = path.join(dir, '.env');
        try {
            if (fsImpl.existsSync(candidate)) {
                const value = readEnvLanguage(fsImpl.readFileSync(candidate, 'utf-8'));
                if (value) {
                    return value;
                }
            }
        } catch (_error) {
            // `.env` ilegível não decide nada: segue subindo.
        }
        if (stop && dir.toLowerCase() === stop.toLowerCase()) {
            break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return undefined;
}

/**
 * Resolve o idioma dos prompts. Todos os argumentos são opcionais.
 *
 * @param {object} options
 * @param {string} [options.projectDir]  pasta do `.synp`
 * @param {string} [options.workspaceDir] raiz do workspace (limite da subida)
 * @param {string} [options.coderPath]   caminho configurado do synesis-coder
 * @param {object} [options.env]         ambiente (padrão: process.env)
 * @returns {{language: 'en'|'pt', source: string}}
 */
function resolvePromptLanguage({ projectDir, workspaceDir, coderPath, env = process.env, fsImpl = fs } = {}) {
    const fromProject = findEnvLanguage(projectDir, workspaceDir, { fsImpl });
    if (fromProject) {
        return { language: normalizeLanguage(fromProject), source: 'project .env' };
    }
    if (coderPath && path.isAbsolute(coderPath)) {
        const fromCoder = findEnvLanguage(path.dirname(coderPath), undefined, { fsImpl, maxLevels: 5 });
        if (fromCoder) {
            return { language: normalizeLanguage(fromCoder), source: 'synesis-coder .env' };
        }
    }
    const fromEnv = normalizeLanguage(env && env[ENV_VAR]);
    if (fromEnv) {
        return { language: fromEnv, source: 'environment' };
    }
    return { language: DEFAULT_LANGUAGE, source: 'default' };
}

function setPromptLanguage(language) {
    current = normalizeLanguage(language) || DEFAULT_LANGUAGE;
    return current;
}

function getPromptLanguage() {
    return current;
}

/**
 * Roda `fn` com os prompts em `language` e restaura o idioma anterior, mesmo
 * se `fn` lançar. Útil onde o texto é montado fora do turno (testes, comandos).
 */
function withPromptLanguage(language, fn) {
    const previous = current;
    setPromptLanguage(language);
    try {
        return fn();
    } finally {
        current = previous;
    }
}

/**
 * O texto do idioma atual: `pick({ en: '...', pt: '...' })`.
 * Sem a versão no idioma atual, cai para o inglês.
 */
function pick(texts) {
    if (!texts || typeof texts !== 'object') {
        return texts;
    }
    return texts[current] !== undefined ? texts[current] : texts[DEFAULT_LANGUAGE];
}

module.exports = {
    ENV_VAR,
    LANGUAGES,
    DEFAULT_LANGUAGE,
    normalizeLanguage,
    readEnvLanguage,
    findEnvLanguage,
    resolvePromptLanguage,
    setPromptLanguage,
    getPromptLanguage,
    withPromptLanguage,
    pick
};
