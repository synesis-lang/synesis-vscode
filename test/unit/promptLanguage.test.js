/**
 * Idioma dos prompts do chat — segue o projeto (`SYNESIS_CODER_LANGUAGE` no
 * `.env`), enquanto a interface da extensão é em inglês.
 *
 * O Social Acceptance é todo em inglês; o face85, todo em português. Um prompt
 * num idioma e o corpus em outro obriga o modelo a traduzir de cabeça termos que
 * ele precisa casar literalmente no banco.
 */
require('../helpers/vscodeMock').install();

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    normalizeLanguage,
    readEnvLanguage,
    findEnvLanguage,
    resolvePromptLanguage,
    setPromptLanguage,
    getPromptLanguage,
    withPromptLanguage,
    pick
} = require('../../src/chat/promptLanguage');

function tempTree(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synesis-lang-'));
    for (const [rel, text] of Object.entries(files)) {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, text, 'utf-8');
    }
    return root;
}

describe('Idioma dos prompts — normalização e leitura do .env', () => {
    it('pt-BR, PT e portuguese viram pt; o resto vira en; vazio não decide', () => {
        assert.strictEqual(normalizeLanguage('pt-BR'), 'pt');
        assert.strictEqual(normalizeLanguage('PT'), 'pt');
        assert.strictEqual(normalizeLanguage('portuguese'), 'pt');
        assert.strictEqual(normalizeLanguage('en'), 'en');
        assert.strictEqual(normalizeLanguage('es'), 'en');
        assert.strictEqual(normalizeLanguage(''), undefined);
        assert.strictEqual(normalizeLanguage(undefined), undefined);
    });

    it('lê a variável com aspas, export e comentário; ignora linhas comentadas', () => {
        assert.strictEqual(readEnvLanguage('SYNESIS_CODER_LANGUAGE=pt-BR'), 'pt-BR');
        assert.strictEqual(readEnvLanguage('export SYNESIS_CODER_LANGUAGE="en"'), 'en');
        assert.strictEqual(readEnvLanguage("SYNESIS_CODER_LANGUAGE='en'  "), 'en');
        assert.strictEqual(readEnvLanguage('SYNESIS_CODER_LANGUAGE=en # idioma'), 'en');
        assert.strictEqual(readEnvLanguage('# SYNESIS_CODER_LANGUAGE=pt\nOUTRA=1'), undefined);
        assert.strictEqual(readEnvLanguage('ANTHROPIC_API_KEY=sk-x\r\nSYNESIS_CODER_LANGUAGE=pt-BR\r\n'), 'pt-BR');
    });
});

describe('Idioma dos prompts — de onde vem', () => {
    it('o .env do projeto decide: SA em inglês, face85 em português', () => {
        const root = tempTree({
            'Social_Acceptance/.env': 'SYNESIS_CODER_LANGUAGE=en\n',
            'Social_Acceptance/social_acceptance.synp': 'PROJECT sa\n',
            'face85/.env': 'SYNESIS_CODER_LANGUAGE=pt-BR\n',
            'face85/face85.synp': 'PROJECT face85\n'
        });
        const sa = resolvePromptLanguage({ projectDir: path.join(root, 'Social_Acceptance'), workspaceDir: root, env: {} });
        const face = resolvePromptLanguage({ projectDir: path.join(root, 'face85'), workspaceDir: root, env: {} });
        assert.deepStrictEqual(sa, { language: 'en', source: 'project .env' });
        assert.deepStrictEqual(face, { language: 'pt', source: 'project .env' });
    });

    it('sobe da pasta do projeto até a raiz do workspace, e não além', () => {
        const root = tempTree({
            '.env': 'SYNESIS_CODER_LANGUAGE=pt\n',
            'ws/proj/sub/x.synp': '',
        });
        const ws = path.join(root, 'ws');
        assert.strictEqual(findEnvLanguage(path.join(ws, 'proj', 'sub'), ws), undefined);
        assert.strictEqual(findEnvLanguage(path.join(ws, 'proj', 'sub'), root), 'pt');
    });

    it('o .env do projeto vence a variável de ambiente', () => {
        const root = tempTree({ 'p/.env': 'SYNESIS_CODER_LANGUAGE=en\n' });
        const r = resolvePromptLanguage({
            projectDir: path.join(root, 'p'),
            workspaceDir: root,
            env: { SYNESIS_CODER_LANGUAGE: 'pt-BR' }
        });
        assert.strictEqual(r.language, 'en');
    });

    it('sem .env no projeto, usa o .env ao lado do coder (instalação editável)', () => {
        const root = tempTree({
            'synesis-coder/.env': 'SYNESIS_CODER_LANGUAGE=pt-BR\n',
            'synesis-coder/.venv/Scripts/synesis-coder.exe': '',
            'proj/x.synp': ''
        });
        const r = resolvePromptLanguage({
            projectDir: path.join(root, 'proj'),
            workspaceDir: path.join(root, 'proj'),
            coderPath: path.join(root, 'synesis-coder', '.venv', 'Scripts', 'synesis-coder.exe'),
            env: {}
        });
        assert.deepStrictEqual(r, { language: 'pt', source: 'synesis-coder .env' });
    });

    it('sem nada declarado, inglês', () => {
        const root = tempTree({ 'p/x.synp': '' });
        assert.deepStrictEqual(
            resolvePromptLanguage({ projectDir: path.join(root, 'p'), workspaceDir: root, env: {} }),
            { language: 'en', source: 'default' }
        );
    });
});

describe('Idioma dos prompts — escolha do texto', () => {
    afterEach(() => setPromptLanguage('en'));

    it('pick devolve o texto do idioma atual, e cai no inglês quando falta', () => {
        setPromptLanguage('pt');
        assert.strictEqual(pick({ en: 'A', pt: 'B' }), 'B');
        assert.strictEqual(pick({ en: 'A' }), 'A');
        setPromptLanguage('en');
        assert.strictEqual(pick({ en: 'A', pt: 'B' }), 'A');
    });

    it('withPromptLanguage restaura o idioma anterior, mesmo com exceção', () => {
        setPromptLanguage('en');
        assert.strictEqual(withPromptLanguage('pt', () => getPromptLanguage()), 'pt');
        assert.strictEqual(getPromptLanguage(), 'en');
        assert.throws(() => withPromptLanguage('pt', () => { throw new Error('x'); }));
        assert.strictEqual(getPromptLanguage(), 'en');
    });
});

describe('Idioma dos prompts — o que muda no chat', () => {
    const { SYSTEM_PROMPT, describeGraphMetrics, renderSemanticCapability, buildSuggestedQuestions } =
        require('../../src/chat/chatParticipant');
    const { SYSTEM_PROMPT_PT } = require('../../src/chat/promptTextPt');
    const { describeTools } = require('../../src/chat/graphClients');
    const { renderLexicalCapability } = require('../../src/chat/lexicalCapability');
    const { buildAuditPrompt } = require('../../src/chat/auditTrail');
    const { buildSystemPromptWithDatabase } = require('../../src/chat/databaseSelection');

    afterEach(() => setPromptLanguage('en'));

    it('os dois prompts de sistema citam os mesmos nomes técnicos', () => {
        // Aliases, arestas, ferramentas e funções não são traduzidos: o modelo
        // precisa casá-los literalmente com o banco.
        // Ficam de fora só o que é texto de exemplo, e por isso traduzível: o
        // modelo de formato da citação (`> "trecho" — Autor (ano)`) e os
        // placeholders entre < > (`HAS_<FIELD>`).
        const technical = (text) =>
            [...new Set(text.match(/`[^`]+`/g) || [])]
                .filter((token) => !token.includes('<') && !token.startsWith('`>'))
                .sort();
        assert.deepStrictEqual(technical(SYSTEM_PROMPT_PT), technical(SYSTEM_PROMPT));
    });

    it('o prompt em português diz que o idioma da instrução não é o da resposta', () => {
        assert.match(SYSTEM_PROMPT_PT, /Responda no idioma da pergunta/);
        assert.match(SYSTEM_PROMPT, /Answer in the language of the question/);
    });

    it('o banco selecionado entra no idioma do projeto', () => {
        assert.match(withPromptLanguage('en', () => buildSystemPromptWithDatabase('X', 'face85')), /selected for this conversation/);
        assert.match(withPromptLanguage('pt', () => buildSystemPromptWithDatabase('X', 'face85')), /selecionado para esta conversa/);
    });

    it('métricas, busca semântica e lexical seguem o idioma', () => {
        const vertices = [{ name: 'Chain', properties: [{ name: 'pagerank' }, { name: 'degree' }] }];
        assert.match(withPromptLanguage('en', () => describeGraphMetrics(vertices)), /do not recompute/);
        assert.match(withPromptLanguage('pt', () => describeGraphMetrics(vertices)), /não recalcule/);
        const ctx = { conceptLabel: 'Chain', embeddingFields: 'ontology_description' };
        assert.match(withPromptLanguage('en', () => renderSemanticCapability(ctx)), /by proximity/);
        assert.match(withPromptLanguage('pt', () => renderSemanticCapability(ctx)), /por proximidade/);
        const lex = { conceptLabel: 'Chain', fulltextConceptFields: 'name' };
        assert.match(withPromptLanguage('en', () => renderLexicalCapability(lex)), /Lexical \(full-text\) search/);
        assert.match(withPromptLanguage('pt', () => renderLexicalCapability(lex)), /Busca lexical/);
    });

    it('as descrições das ferramentas seguem o idioma', () => {
        const query = (lang) => withPromptLanguage(lang, () => describeTools('arcadedb'))[0].description;
        assert.match(query('en'), /READ query/);
        assert.match(query('pt'), /consulta de LEITURA/);
    });

    it('as perguntas sugeridas — que viram a pergunta ao modelo — seguem o idioma', () => {
        const ctx = { conceptLabel: 'Chain' };
        const tax = { label: 'Topic', values: ['Economia', 'Gestão'] };
        const en = withPromptLanguage('en', () => buildSuggestedQuestions(ctx, tax, ['pagerank']));
        const pt = withPromptLanguage('pt', () => buildSuggestedQuestions(ctx, tax, ['pagerank']));
        assert.ok(en.some((s) => /^List the concepts/.test(s.prompt)));
        assert.ok(pt.some((s) => /^Liste os conceitos/.test(s.prompt)));
        assert.strictEqual(en.length, pt.length);
    });

    it('o prompt de reavaliação segue o idioma e mantém a regra de divergência', () => {
        assert.match(withPromptLanguage('en', () => buildAuditPrompt('Q?', 'A.', [])), /Divergence rule — mandatory/);
        assert.match(withPromptLanguage('pt', () => buildAuditPrompt('Q?', 'A.', [])), /Regra de divergência — obrigatória/);
    });
});
