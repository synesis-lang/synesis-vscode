/**
 * includeExpander.test.js — vários arquivos, curingas e pastas nos INCLUDE (Fase D).
 *
 * A extensão precisa ver os mesmos arquivos que o `synesis compile` (>= 0.13):
 * várias linhas INCLUDE se somam; arquivo, curinga ou pasta recursiva; restrição
 * à pasta do projeto; ordem sem diferenciar caixa. Antes, a bibliografia lia só
 * a PRIMEIRA linha, e um curinga virava o caminho literal `fontes/*.bib`.
 * Estudo: synesis-planning/synesis/Estudo_Includes_Multiplos_Pastas_e_Lotes.md §6.5.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { expandInclude, expandIncludesOfType, pathOrder } = require('../../src/core/includeExpander');
const projectLoader = require('../../src/core/projectLoader');
const bibtexParser = require('../../src/parsers/bibtexParser');

const BIB_A = '@article{alpha2020,\n  title = {Primeiro},\n  abstract = {Resumo A.}\n}\n';
const BIB_B = '@article{beta2021,\n  title = {Segundo},\n  abstract = {Resumo B.}\n}\n';

function write(file, content = '') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf-8');
}

function names(files) {
    return files.map((f) => path.basename(f));
}

describe('includeExpander — expandInclude', () => {
    let root;
    let project;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'synesis-inc-'));
        project = path.join(root, 'projeto');
        fs.mkdirSync(project);
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('arquivo literal', () => {
        write(path.join(project, 'refs.bib'), BIB_A);
        const r = expandInclude(project, 'refs.bib', '.bib');
        assert.strictEqual(r.error, null);
        assert.deepStrictEqual(names(r.files), ['refs.bib']);
    });

    it('arquivo ausente é not_found', () => {
        assert.strictEqual(expandInclude(project, 'ausente.bib', '.bib').error, 'not_found');
    });

    it('pasta é recursiva e filtra pela extensão do tipo', () => {
        write(path.join(project, 'Sources', 'a.bib'));
        write(path.join(project, 'Sources', 'docente', 'b.bib'));
        write(path.join(project, 'Sources', 'leia-me.txt'));
        const r = expandInclude(project, 'Sources', '.bib');
        assert.strictEqual(r.kind, 'directory');
        assert.deepStrictEqual(names(r.files), ['a.bib', 'b.bib']);
    });

    it('pasta sem arquivos do tipo é no_matches', () => {
        fs.mkdirSync(path.join(project, 'vazia'));
        assert.strictEqual(expandInclude(project, 'vazia', '.bib').error, 'no_matches');
    });

    it('pasta sem extensão declarada é not_a_file', () => {
        fs.mkdirSync(path.join(project, 'pasta'));
        assert.strictEqual(expandInclude(project, 'pasta', null).error, 'not_a_file');
    });

    it('curinga casa só o que descreve', () => {
        write(path.join(project, 'annotations_kely', 'a.syn'));
        write(path.join(project, 'annotations_face85', 'b.syn'));
        write(path.join(project, 'outra', 'c.syn'));
        const r = expandInclude(project, 'annotations_*/*.syn', '.syn');
        assert.strictEqual(r.kind, 'glob');
        assert.deepStrictEqual(names(r.files), ['b.syn', 'a.syn']);
    });

    it('curinga ** desce em subpastas', () => {
        write(path.join(project, 'lotes', 'a.bib'));
        write(path.join(project, 'lotes', '2025', 'b.bib'));
        const r = expandInclude(project, 'lotes/**/*.bib', '.bib');
        assert.deepStrictEqual(names(r.files).sort(), ['a.bib', 'b.bib']);
    });

    it('curinga sem match é no_matches', () => {
        assert.strictEqual(expandInclude(project, 'fontes/*.bib', '.bib').error, 'no_matches');
    });

    it('literal que escapa do projeto é escapes_project', () => {
        write(path.join(root, 'fora', 'x.bib'));
        assert.strictEqual(expandInclude(project, '../fora/x.bib', '.bib').error, 'escapes_project');
    });

    it('curinga que escapa do projeto vai para outside, não para files', () => {
        write(path.join(root, 'fora', 'x.bib'));
        const r = expandInclude(project, '../fora/*.bib', '.bib');
        assert.deepStrictEqual(r.files, []);
        assert.deepStrictEqual(names(r.outside), ['x.bib']);
    });

    it('SHARED aceita alvo fora do projeto', () => {
        write(path.join(root, 'comum', 'c.syno'));
        const r = expandInclude(project, '../comum/c.syno', '.syno', { shared: true });
        assert.strictEqual(r.error, null);
        assert.deepStrictEqual(names(r.files), ['c.syno']);
    });

    it('ordem ignora caixa em qualquer sistema', () => {
        for (const nome of ['Kely.bib', 'face85.bib', 'Anderson.bib']) {
            write(path.join(project, 'Sources', nome));
        }
        const esperado = ['Anderson.bib', 'face85.bib', 'Kely.bib'];
        assert.deepStrictEqual(names(expandInclude(project, 'Sources', '.bib').files), esperado);
        assert.deepStrictEqual(names(expandInclude(project, 'Sources/*.bib', '.bib').files), esperado);
    });

    it('pathOrder é estável para nomes que só diferem na caixa', () => {
        assert.ok(pathOrder('a/B.bib', 'a/b.bib') < 0);
    });

    it('expandIncludesOfType soma linhas e não repete arquivo', () => {
        write(path.join(project, 'Sources', 'a.bib'));
        write(path.join(project, 'Sources', 'b.bib'));
        const includes = [
            { type: 'BIBLIOGRAPHY', path: 'Sources' },
            { type: 'BIBLIOGRAPHY', path: 'Sources/a.bib' },
            { type: 'ANNOTATIONS', path: 'x.syn' }
        ];
        assert.deepStrictEqual(names(expandIncludesOfType(project, includes, 'BIBLIOGRAPHY')), ['a.bib', 'b.bib']);
    });
});

describe('projectLoader — bibliografia e SHARED', () => {
    let project;

    beforeEach(() => {
        project = fs.mkdtempSync(path.join(os.tmpdir(), 'synesis-proj-'));
    });

    afterEach(() => {
        fs.rmSync(project, { recursive: true, force: true });
    });

    function synp(body) {
        const file = path.join(project, 'p.synp');
        write(file, `PROJECT p\n    TEMPLATE "t.synt"\n${body}END PROJECT\n`);
        return file;
    }

    it('INCLUDE SHARED ONTOLOGY é lido como ONTOLOGY, não como tipo SHARED', () => {
        const includes = projectLoader.extractIncludes('INCLUDE SHARED ONTOLOGY "../comum.syno"\n');
        assert.deepStrictEqual(includes, [{ type: 'ONTOLOGY', path: '../comum.syno', shared: true }]);
    });

    it('duas linhas INCLUDE BIBLIOGRAPHY se somam', async () => {
        write(path.join(project, 'fontes', 'a.bib'), BIB_A);
        write(path.join(project, 'fontes', 'b.bib'), BIB_B);
        const loaded = await projectLoader.load(synp(
            '    INCLUDE BIBLIOGRAPHY "fontes/a.bib"\n    INCLUDE BIBLIOGRAPHY "fontes/b.bib"\n'
        ));
        assert.deepStrictEqual(names(loaded.bibliographyPaths), ['a.bib', 'b.bib']);
        assert.strictEqual(path.basename(loaded.bibliographyPath), 'a.bib');
    });

    it('pasta de .bib', async () => {
        write(path.join(project, 'Sources', 'a.bib'), BIB_A);
        write(path.join(project, 'Sources', 'docente', 'b.bib'), BIB_B);
        const loaded = await projectLoader.load(synp('    INCLUDE BIBLIOGRAPHY "Sources"\n'));
        assert.deepStrictEqual(names(loaded.bibliographyPaths), ['a.bib', 'b.bib']);
    });

    it('sem bibliografia: lista vazia e bibliographyPath null', async () => {
        const loaded = await projectLoader.load(synp(''));
        assert.deepStrictEqual(loaded.bibliographyPaths, []);
        assert.strictEqual(loaded.bibliographyPath, null);
    });
});

describe('bibtexParser — findEntryInFiles', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synesis-bib-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('acha a entrada no segundo arquivo', async () => {
        write(path.join(dir, 'a.bib'), BIB_A);
        write(path.join(dir, 'b.bib'), BIB_B);
        const entry = await bibtexParser.findEntryInFiles(
            [path.join(dir, 'a.bib'), path.join(dir, 'b.bib')], 'beta2021'
        );
        assert.strictEqual(bibtexParser.getAbstract(entry), 'Resumo B.');
    });

    it('vale a primeira ocorrência', async () => {
        write(path.join(dir, 'a.bib'), BIB_A);
        write(path.join(dir, 'b.bib'), BIB_A.replace('Resumo A.', 'Outro'));
        const entry = await bibtexParser.findEntryInFiles(
            [path.join(dir, 'a.bib'), path.join(dir, 'b.bib')], 'alpha2020'
        );
        assert.strictEqual(bibtexParser.getAbstract(entry), 'Resumo A.');
    });

    it('arquivo ausente é pulado', async () => {
        write(path.join(dir, 'b.bib'), BIB_B);
        const entry = await bibtexParser.findEntryInFiles(
            [path.join(dir, 'nao-existe.bib'), path.join(dir, 'b.bib')], 'beta2021'
        );
        assert.ok(entry);
    });
});
