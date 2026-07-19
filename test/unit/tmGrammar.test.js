'use strict';

/**
 * tmGrammar.test.js — Verificação da grammar TextMate com o engine real.
 *
 * A grammar TextMate é a camada de base: cobre o período antes do LSP responder,
 * o caso de semantic highlighting desligado, e os contextos onde semantic tokens
 * não chegam (hover, blocos ```synesis em Markdown).
 *
 * Dois invariantes testados aqui:
 *
 *   1. Blocos de texto livre (GUIDELINES, DESCRIPTION) não colorem keywords no
 *      corpo. Na gramática do compilador o conteúdo é TEXT_LINE; a grammar
 *      TextMate precisa espelhar isso ou volta o bug de `FIELD`/`TYPE` coloridos
 *      no meio da prosa.
 *
 *   2. Partição por volatilidade: keywords estáveis são coloridas; keywords da
 *      fronteira em evolução (IDENTIFIES, REFERS TO, ...) são DELIBERADAMENTE
 *      omitidas — quem as colore é o LSP, a partir da gramática. Este teste trava
 *      essa decisão para que ninguém "complete" a lista e recrie a divergência.
 *
 * Ver synesis/Planning/syntax_semantic_highlight.md (Fase 3).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const GRAMMAR_PATH = path.join(__dirname, '..', '..', 'syntaxes', 'synesis.tmLanguage.json');

let vsctm;
let oniguruma;
try {
    vsctm = require('vscode-textmate');
    oniguruma = require('vscode-oniguruma');
} catch (err) {
    vsctm = null;
}

/** Tokeniza linhas e devolve [{ text, scope }] ignorando whitespace puro. */
async function tokenize(lines) {
    const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer;
    await oniguruma.loadWASM(wasm);

    const registry = new vsctm.Registry({
        onigLib: Promise.resolve({
            createOnigScanner: (s) => new oniguruma.OnigScanner(s),
            createOnigString: (s) => new oniguruma.OnigString(s),
        }),
        loadGrammar: async (scopeName) =>
            scopeName === 'source.synesis'
                ? vsctm.parseRawGrammar(fs.readFileSync(GRAMMAR_PATH, 'utf8'), GRAMMAR_PATH)
                : null,
    });

    const grammar = await registry.loadGrammar('source.synesis');
    assert.ok(grammar, 'grammar source.synesis não carregou');

    const out = [];
    let ruleStack = vsctm.INITIAL;
    for (const line of lines) {
        const result = grammar.tokenizeLine(line, ruleStack);
        ruleStack = result.ruleStack;
        for (const t of result.tokens) {
            const text = line.substring(t.startIndex, t.endIndex);
            if (!text.trim()) continue;
            out.push({ text: text.trim(), scope: t.scopes[t.scopes.length - 1] });
        }
    }
    return out;
}

const describeOrSkip = vsctm ? describe : describe.skip;

describeOrSkip('TextMate grammar', function () {
    this.timeout(10000);

    describe('blocos de texto livre', () => {
        it('não colore keywords dentro de DESCRIPTION', async () => {
            const toks = await tokenize([
                'FIELD x TYPE TEXT',
                '    DESCRIPTION',
                '    Aqui FIELD e TYPE sao texto comum',
                '    END DESCRIPTION',
                'END FIELD',
            ]);
            const corpo = toks.find((t) => t.text.startsWith('Aqui FIELD'));
            assert.ok(corpo, 'linha de corpo não tokenizada');
            assert.strictEqual(corpo.scope, 'string.unquoted.description.synesis');
        });

        it('não colore keywords dentro de GUIDELINES', async () => {
            const toks = await tokenize([
                'FIELD x TYPE TEXT',
                '    GUIDELINES',
                '    Use SCOPE e TYPE conforme o manual',
                '    END GUIDELINES',
                'END FIELD',
            ]);
            const corpo = toks.find((t) => t.text.startsWith('Use SCOPE'));
            assert.ok(corpo, 'linha de corpo não tokenizada');
            assert.strictEqual(corpo.scope, 'string.unquoted.guidelines.synesis');
        });

        it('DESCRIPTION inline é campo, não abre bloco', async () => {
            // `DESCRIPTION texto` (mesma linha) não tem END: se abrisse bloco,
            // engoliria o resto do arquivo.
            const toks = await tokenize([
                'FIELD x TYPE TEXT',
                '    DESCRIPTION texto curto aqui',
                '    SCOPE SOURCE',
                'END FIELD',
            ]);
            const scope = toks.find((t) => t.text === 'SCOPE');
            assert.ok(scope, 'SCOPE não tokenizado');
            assert.strictEqual(scope.scope, 'keyword.control.field.synesis');
        });
    });

    describe('partição por volatilidade', () => {
        it('colore keywords estáveis', async () => {
            const toks = await tokenize(['SOURCE @silva2020', '    text: exemplo', 'END SOURCE']);
            const source = toks.find((t) => t.text === 'SOURCE');
            assert.strictEqual(source.scope, 'keyword.control.block.synesis');
            const bibref = toks.find((t) => t.text === '@silva2020');
            assert.strictEqual(bibref.scope, 'entity.name.reference.synesis');
        });

        it('NÃO colore keywords voláteis — o LSP as cobre', async () => {
            // Decisão deliberada, não omissão. Ver comentário "STABLE KEYWORDS
            // ONLY" na grammar. Se este teste falhar porque alguém adicionou
            // IDENTIFIES à lista, a pergunta certa é se a keyword já estabilizou.
            const toks = await tokenize([
                'FIELD lattes_id TYPE TEXT',
                '    IDENTIFIES researcher',
                'END FIELD',
            ]);
            const alvo = toks.find((t) => t.text.includes('IDENTIFIES'));
            assert.ok(alvo, 'linha do modificador não tokenizada');
            assert.strictEqual(
                alvo.scope,
                'source.synesis',
                'IDENTIFIES deve ficar sem escopo próprio no TextMate'
            );
        });
    });

    describe('estrutura da grammar', () => {
        it('não tem includes órfãos', () => {
            const raw = fs.readFileSync(GRAMMAR_PATH, 'utf8');
            const grammar = JSON.parse(raw);
            const refs = new Set(
                Array.from(raw.matchAll(/"#(\w+)"/g)).map((m) => m[1])
            );
            const faltando = [...refs].filter((r) => !(r in grammar.repository));
            assert.deepStrictEqual(faltando, [], `includes sem definição: ${faltando}`);
        });
    });
});
