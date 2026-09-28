/**
 * includeExpander.js — expande o caminho de um INCLUDE do .synp em arquivos.
 *
 * Espelha `synesis.parser.paths.expand_include` do compilador (synesis >= 0.13),
 * para que a extensão veja exatamente os arquivos que o `synesis compile` vê:
 *
 *   - arquivo: o próprio arquivo;
 *   - curinga (`fontes/*.bib`, com `*`, `?`, `[...]` e `**`): os arquivos que
 *     casam, sem filtrar extensão — o autor já escolheu o que casa;
 *   - pasta (`Sources`): busca RECURSIVA pela extensão do tipo de INCLUDE.
 *
 * Mesma contenção (o arquivo precisa estar dentro da pasta do projeto, exceto em
 * INCLUDE SHARED ONTOLOGY) e mesma ordem: caminho sem diferenciar caixa, igual
 * em todo sistema operacional. A ordem importa: numa chave repetida entre dois
 * `.bib`, vale a primeira ocorrência.
 *
 * Módulo puro (fs/path, sem a API do VS Code): testável em mocha.
 */

const fs = require('fs');
const path = require('path');
const { isWithin } = require('./pathContainment');

/** Extensão que uma PASTA seleciona em cada tipo de INCLUDE. */
const INCLUDE_EXTENSIONS = Object.freeze({
    BIBLIOGRAPHY: '.bib',
    ANNOTATIONS: '.syn',
    ONTOLOGY: '.syno',
    DATASET: '.toml'
});

function hasGlob(value) {
    return /[*?[]/.test(value || '');
}

/** Chave de ordenação idêntica em todo sistema (ver compilador, _path_order). */
function pathOrder(a, b) {
    const pa = a.replace(/\\/g, '/');
    const pb = b.replace(/\\/g, '/');
    const la = pa.toLowerCase();
    const lb = pb.toLowerCase();
    if (la !== lb) {
        return la < lb ? -1 : 1;
    }
    return pa < pb ? -1 : (pa > pb ? 1 : 0);
}

/** Converte um segmento de curinga (`*`, `?`, `[...]`) em RegExp. */
function segmentToRegExp(segment) {
    let out = '';
    for (let i = 0; i < segment.length; i += 1) {
        const ch = segment[i];
        if (ch === '*') {
            out += '[^/]*';
        } else if (ch === '?') {
            out += '[^/]';
        } else if (ch === '[') {
            const end = segment.indexOf(']', i + 1);
            if (end === -1) {
                out += '\\[';
            } else {
                let body = segment.slice(i + 1, end);
                if (body.startsWith('!')) {
                    body = '^' + body.slice(1);
                }
                out += `[${body.replace(/\\/g, '\\\\')}]`;
                i = end;
            }
        } else {
            out += ch.replace(/[.+^${}()|\\]/g, '\\$&');
        }
    }
    // FS do Windows e do macOS não diferenciam caixa; o Path.glob do compilador
    // também não, no Windows.
    return new RegExp(`^${out}$`, process.platform === 'win32' ? 'i' : '');
}

function safeReaddir(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
}

/**
 * Casa `segments` (curinga já dividido em `/`) a partir de `dir`.
 * `**` casa zero ou mais pastas.
 */
function walkGlob(dir, segments, out) {
    if (segments.length === 0) {
        return;
    }
    const [head, ...rest] = segments;
    if (head === '**') {
        walkGlob(dir, rest, out);
        for (const entry of safeReaddir(dir)) {
            if (entry.isDirectory()) {
                walkGlob(path.join(dir, entry.name), segments, out);
            }
        }
        return;
    }
    if (!hasGlob(head)) {
        const next = path.join(dir, head);
        if (rest.length === 0) {
            if (isFile(next)) {
                out.push(next);
            }
        } else if (isDirectory(next)) {
            walkGlob(next, rest, out);
        }
        return;
    }
    const re = segmentToRegExp(head);
    for (const entry of safeReaddir(dir)) {
        if (!re.test(entry.name)) {
            continue;
        }
        const next = path.join(dir, entry.name);
        if (rest.length === 0) {
            if (isFile(next)) {
                out.push(next);
            }
        } else if (isDirectory(next)) {
            walkGlob(next, rest, out);
        }
    }
}

function isFile(p) {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

function isDirectory(p) {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function realPath(p) {
    try {
        return fs.realpathSync.native(p);
    } catch {
        return path.resolve(p);
    }
}

function walkDirectory(dir, extension, out) {
    for (const entry of safeReaddir(dir)) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkDirectory(full, extension, out);
        } else if (path.extname(entry.name).toLowerCase() === extension && isFile(full)) {
            // isFile segue link simbólico: link para arquivo entra (e passa pela
            // contenção depois); link para pasta com nome `.bib`, não.
            out.push(full);
        }
    }
}

/**
 * Expande o caminho de um INCLUDE em arquivos.
 *
 * @param {string} projectDir Pasta do .synp.
 * @param {string} raw Caminho exatamente como escrito no .synp.
 * @param {string|null} extension Extensão que uma pasta seleciona (ex.: '.bib').
 * @param {{shared?: boolean}} [options] `shared` desliga a contenção
 *     (INCLUDE SHARED ONTOLOGY).
 * @returns {{files: string[], outside: string[], kind: string, error: string|null}}
 *     `error`: null, 'not_found', 'not_a_file', 'escapes_project' ou 'no_matches'.
 */
function expandInclude(projectDir, raw, extension, options = {}) {
    const shared = Boolean(options.shared);
    const normalized = String(raw || '').replace(/\\/g, '/').trim();
    const base = path.resolve(projectDir);
    const contained = (p) => shared || isWithin(realPath(p), realPath(base));

    const finish = (candidates, kind) => {
        const files = [];
        const outside = [];
        for (const candidate of candidates) {
            (contained(candidate) ? files : outside).push(path.resolve(candidate));
        }
        const unique = (list) => Array.from(new Set(list)).sort(pathOrder);
        const inside = unique(files);
        const out = unique(outside);
        const error = inside.length === 0 && out.length === 0 ? 'no_matches' : null;
        return { files: inside, outside: out, kind, error };
    };

    if (hasGlob(normalized)) {
        const segments = normalized.split('/').filter((s) => s !== '' && s !== '.');
        let start = base;
        // Prefixo estático (inclusive `..`) é resolvido direto; o resto é casado.
        while (segments.length > 0 && !hasGlob(segments[0]) && segments.length > 1) {
            start = path.join(start, segments.shift());
        }
        const matches = [];
        walkGlob(start, segments, matches);
        return finish(matches, 'glob');
    }

    const candidate = path.resolve(base, normalized);
    if (!shared && !isWithin(candidate, base)) {
        return { files: [], outside: [], kind: 'file', error: 'escapes_project' };
    }
    if (!fs.existsSync(candidate)) {
        return { files: [], outside: [], kind: 'file', error: 'not_found' };
    }
    if (isDirectory(candidate)) {
        if (!extension) {
            return { files: [], outside: [], kind: 'directory', error: 'not_a_file' };
        }
        const found = [];
        walkDirectory(candidate, extension.toLowerCase(), found);
        return finish(found, 'directory');
    }
    if (!isFile(candidate)) {
        return { files: [], outside: [], kind: 'file', error: 'not_a_file' };
    }
    return { files: [candidate], outside: [], kind: 'file', error: null };
}

/**
 * Arquivos de TODOS os INCLUDE de um tipo, sem repetição e na ordem do .synp.
 *
 * @param {string} projectDir
 * @param {Array<{type: string, path: string, shared?: boolean}>} includes
 * @param {string} type Ex.: 'BIBLIOGRAPHY'.
 * @returns {string[]}
 */
function expandIncludesOfType(projectDir, includes, type) {
    const seen = new Set();
    const files = [];
    for (const include of includes || []) {
        if (include.type !== type) {
            continue;
        }
        const shared = Boolean(include.shared) && type === 'ONTOLOGY';
        const { files: expanded } = expandInclude(projectDir, include.path, INCLUDE_EXTENSIONS[type], { shared });
        for (const file of expanded) {
            const key = process.platform === 'win32' ? file.toLowerCase() : file;
            if (!seen.has(key)) {
                seen.add(key);
                files.push(file);
            }
        }
    }
    return files;
}

module.exports = {
    INCLUDE_EXTENSIONS,
    expandInclude,
    expandIncludesOfType,
    hasGlob,
    pathOrder
};
