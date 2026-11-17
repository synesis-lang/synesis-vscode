'use strict';

/**
 * Testes do consumo do vértice `ProjectContext`, gravado no grafo pelo
 * `synesis-graph` a partir de 0.8.0.
 *
 * É o que dá semântica ao que o schema só descreve como sintaxe: a introspecção
 * diz que existe um vértice `Aspect` com a propriedade `name`, mas não que
 * aquilo é a escala modal de Dooyeweerd nem o que `[15] Fiducial` significa.
 *
 * Duas coisas aqui merecem cuidado, porque são as que quebram em silêncio:
 *
 * - **O custo é escalonado.** `description` + `project_summary` custam ~150
 *   tokens e entram sempre; o `template_doc` custa ~6,5k (medido no face85) e
 *   só entra quando a pergunta pede a semântica dos campos. Um bug aqui não
 *   falha — só desperdiça contexto, ou deixa o modelo adivinhando.
 * - **A ausência do vértice não é erro.** Um grafo gerado por versão anterior
 *   simplesmente não o tem, e o chat precisa seguir funcionando com o schema.
 */

require('../helpers/vscodeMock').install();

const assert = require('assert');
const { setPromptLanguage, withPromptLanguage } = require('../../src/chat/promptLanguage');
const {
    questionNeedsTemplateSemantics,
    renderProjectContext,
    describeStaleness,
    readProjectContext,
    renderWelcome,
    describeAccessFailure
} = require('../../src/chat/chatParticipant');

const vscode = require('vscode');

/** Ferramenta MCP falsa, no formato manglado que o VSCode entrega. */
function fakeQueryTool(payload, { fail = false } = {}) {
    const calls = [];
    vscode.lm.invokeTool = async (name, options) => {
        calls.push({ name, input: options.input });
        if (fail) {
            throw new Error('sem permissão');
        }
        return { content: [new vscode.LanguageModelTextPart(JSON.stringify(payload))] };
    };
    return { tools: [{ name: 'mcp_arcadedb-face_query' }], calls };
}

describe('ProjectContext — quando carregar a semântica do template', () => {
    // O critério deixou de ser lexical (Etapa 2). A versão anterior casava a
    // pergunta contra 26 palavras em português; num corpus em inglês nenhuma
    // casava, e o `template_doc` NUNCA era carregado — o chat perdia em
    // silêncio justamente a camada que o adapta ao projeto.
    const SCHEMA_NAMES = ['Chain', 'Item', 'Source', 'Topic', 'Aspect'];

    it('carrega sempre no primeiro turno, em qualquer idioma', () => {
        // É quando o modelo ainda não viu nada deste projeto, e o turno em que
        // errar a semântica sai mais caro: a resposta vira contexto das
        // seguintes.
        assert.strictEqual(questionNeedsTemplateSemantics('quantos conceitos existem?'), true);
        assert.strictEqual(questionNeedsTemplateSemantics('what fields does this template define?'), true);
        assert.strictEqual(questionNeedsTemplateSemantics('welche Felder gibt es?'), true);
    });

    it('não recarrega quando a pergunta já nomeia algo do schema', () => {
        // O pesquisador que cita um rótulo do grafo já está navegando o dado; a
        // semântica do template não é o que falta.
        const opts = { isFirstTurn: false, knownNames: SCHEMA_NAMES };
        assert.strictEqual(questionNeedsTemplateSemantics('liste 10 chains', opts), false);
        assert.strictEqual(questionNeedsTemplateSemantics('list the topics', opts), false);
    });

    it('carrega quando a pergunta não nomeia nada reconhecível', () => {
        // Pergunta sobre o que as coisas SÃO — que é o que o template responde.
        const opts = { isFirstTurn: false, knownNames: SCHEMA_NAMES };
        assert.strictEqual(questionNeedsTemplateSemantics('o que significa cada campo?', opts), true);
        assert.strictEqual(questionNeedsTemplateSemantics('how was this coded?', opts), true);
    });

    it('funciona em corpus inglês — o defeito que motivou a mudança', () => {
        // Nenhuma das 26 palavras portuguesas casava aqui, então o
        // `template_doc` nunca chegava ao modelo num projeto em inglês.
        const opts = { isFirstTurn: false, knownNames: ['Concept', 'Item', 'Source'] };
        assert.strictEqual(
            questionNeedsTemplateSemantics('what does the confidence scale mean?', opts),
            true
        );
    });

    it('sem schema, só o primeiro turno decide', () => {
        // Sem nomes conhecidos não há como saber se a pergunta navega o dado;
        // não carregar é o comportamento conservador fora do primeiro turno.
        assert.strictEqual(
            questionNeedsTemplateSemantics('qualquer coisa', { isFirstTurn: false, knownNames: [] }),
            false
        );
    });

    it('ignora nomes curtos demais para casar com segurança', () => {
        // Um rótulo de 3 letras casaria dentro de palavras comuns e desligaria
        // o carregamento por acidente.
        const opts = { isFirstTurn: false, knownNames: ['Ind'] };
        assert.strictEqual(questionNeedsTemplateSemantics('independência dos dados', opts), true);
    });

    it('tolera entrada vazia sem quebrar', () => {
        assert.strictEqual(questionNeedsTemplateSemantics(''), false);
        assert.strictEqual(questionNeedsTemplateSemantics(undefined), false);
    });
});

describe('ProjectContext — montagem do prompt', () => {
    // Este bloco confere o texto do prompt em português (projeto pt).
    before(() => setPromptLanguage('pt'));
    after(() => setPromptLanguage('en'));
    it('inclui a descrição do projeto e o resumo', () => {
        const out = renderProjectContext({
            description: 'Mapeamento semântico da produção científica.',
            summary: '# Projeto `face85`\n- 20 referências'
        });
        assert.ok(out.includes('Mapeamento semântico'));
        assert.ok(out.includes('20 referências'));
    });

    it('omite o template_doc quando não foi carregado', () => {
        const out = renderProjectContext({ description: 'X', summary: 'Y' });
        assert.ok(!out.includes('Semântica do template'));
    });

    it('inclui o template_doc quando carregado, com precedência explícita', () => {
        const out = renderProjectContext({
            description: 'X',
            templateDoc: '# Template `face85`\n### `aspect` — ORDERED'
        });
        assert.ok(out.includes('Semântica do template deste projeto'));
        assert.ok(out.includes('não os de um exemplo'));
        assert.ok(out.includes('`aspect` — ORDERED'));
    });

    it('devolve undefined quando não há contexto', () => {
        assert.strictEqual(renderProjectContext(undefined), undefined);
        assert.strictEqual(renderProjectContext({}), undefined);
    });
});

describe('ProjectContext — aviso de snapshot velho', () => {
    // Este bloco confere o texto do prompt em português (projeto pt).
    before(() => setPromptLanguage('pt'));
    after(() => setPromptLanguage('en'));
    it('não avisa para grafo recente', () => {
        assert.strictEqual(describeStaleness(new Date().toISOString()), undefined);
    });

    it('avisa para grafo de mais de 90 dias', () => {
        const velho = new Date(Date.now() - 200 * 86400000).toISOString();
        const aviso = describeStaleness(velho);
        assert.ok(aviso && aviso.includes('200 dias'));
        assert.ok(aviso.includes('snapshot'));
    });

    it('ignora data ausente ou inválida em vez de quebrar', () => {
        assert.strictEqual(describeStaleness(undefined), undefined);
        assert.strictEqual(describeStaleness('não é uma data'), undefined);
    });
});

describe('ProjectContext — leitura do banco', () => {
    afterEach(() => {
        vscode.lm.tools = [];
        vscode.lm.invokeTool = async () => ({ content: [] });
    });

    it('lê o vértice e devolve o registro', async () => {
        const { tools } = fakeQueryTool({
            records: [{ description: 'D', summary: 'S', generatedAt: '2026-08-23T00:00:00Z' }]
        });
        const ctx = await readProjectContext(tools, 'face85', {});
        assert.strictEqual(ctx.description, 'D');
        assert.strictEqual(ctx.summary, 'S');
    });

    it('pede o template_doc só quando full=true', async () => {
        const payload = { records: [{ description: 'D' }] };

        const barato = fakeQueryTool(payload);
        await readProjectContext(barato.tools, 'face85', {});
        assert.ok(!barato.calls[0].input.query.includes('template_doc'));

        const caro = fakeQueryTool(payload);
        await readProjectContext(caro.tools, 'face85', {}, { full: true });
        assert.ok(caro.calls[0].input.query.includes('template_doc'));
    });

    it('degrada em silêncio quando o banco não tem o vértice', async () => {
        // Grafo gerado por synesis-graph anterior a 0.8.0: consulta válida,
        // zero linhas. Não é erro — o chat segue com o schema.
        const { tools } = fakeQueryTool({ records: [] });
        assert.strictEqual(await readProjectContext(tools, 'face85', {}), undefined);
    });

    it('degrada em silêncio quando a consulta falha', async () => {
        const { tools } = fakeQueryTool({}, { fail: true });
        assert.strictEqual(await readProjectContext(tools, 'face85', {}), undefined);
    });

    it('não consulta sem banco selecionado', async () => {
        const { tools, calls } = fakeQueryTool({ records: [{}] });
        assert.strictEqual(await readProjectContext(tools, undefined, {}), undefined);
        assert.strictEqual(calls.length, 0);
    });

    it('não consulta quando não há ferramenta de query', async () => {
        assert.strictEqual(await readProjectContext([], 'face85', {}), undefined);
    });

    it('ignora ferramenta `_query` de outro servidor MCP', async () => {
        // `gitnexus_query` termina em `_query` e está ativo neste próprio
        // repositório. Uma versão anterior casava só pelo sufixo e, como
        // `.find()` devolve o PRIMEIRO que casar, mandaria uma consulta Cypher
        // do ArcadeDB para o servidor errado. Os chamadores de hoje passam a
        // lista já filtrada, mas a função é exportada — a proteção tem de estar
        // aqui, não na disciplina de quem chama.
        const { calls } = fakeQueryTool({ records: [{ description: 'D' }] });

        const alheia = [{ name: 'gitnexus_query' }];
        assert.strictEqual(await readProjectContext(alheia, 'face85', {}), undefined);
        assert.strictEqual(calls.length, 0, 'não pode invocar ferramenta de outro servidor');

        // Com a do ArcadeDB presente, escolhe a certa mesmo vindo depois.
        const misturada = [{ name: 'gitnexus_query' }, { name: 'mcp_arcadedb-face_query' }];
        const ctx = await readProjectContext(misturada, 'face85', {});
        assert.strictEqual(ctx.description, 'D');
        assert.strictEqual(calls[0].name, 'mcp_arcadedb-face_query');
    });
});

describe('Saudação — apresenta o projeto em vez de exemplos genéricos', () => {
    function fakeStream() {
        const markdown = [];
        const buttons = [];
        return {
            stream: { markdown: (m) => markdown.push(m), button: (c) => buttons.push(c.command) },
            text: () => markdown.join(''),
            buttons
        };
    }

    /** Responde ProjectContext e tópicos conforme a query recebida. */
    /**
     * Grafo falso.
     *
     * `schema` é servido de verdade porque a saudação passou a derivar dele a
     * taxonomia e as métricas deste projeto (Etapa 2) — antes fixava `Topic`,
     * `GROUPED_BY` e PageRank, que são o template do face85 e não invariantes
     * do Synesis.
     */
    function fakeGraph({ context = null, topics = [], schema = DEFAULT_SCHEMA } = {}) {
        vscode.lm.invokeTool = async (name, options) => {
            if (String(name).endsWith('_get_schema')) {
                return { content: [new vscode.LanguageModelTextPart(JSON.stringify(schema))] };
            }
            const isContext = options.input.query.includes('ProjectContext');
            const records = isContext ? (context ? [context] : []) : topics.map((n) => ({ name: n }));
            return { content: [new vscode.LanguageModelTextPart(JSON.stringify({ records }))] };
        };
        return [{ name: 'mcp_arcadedb-face_query' }, { name: 'mcp_arcadedb-face_get_schema' }];
    }

    /** Schema no formato do face85: conceito `Chain`, taxonomia `Topic`. */
    const DEFAULT_SCHEMA = {
        types: [
            {
                name: 'Chain',
                category: 'vertex',
                properties: [{ name: 'name' }, { name: 'pagerank' }]
            },
            { name: 'Item', category: 'vertex', properties: [{ name: 'citation' }] },
            { name: 'Source', category: 'vertex', properties: [{ name: 'bibtex' }] },
            { name: 'Topic', category: 'vertex', properties: [{ name: 'name' }] },
            { name: 'GROUPED_BY', category: 'edge', properties: [] },
            { name: 'MENTIONS', category: 'edge', properties: [] }
        ]
    };

    const CONTEXT = {
        description: 'Mapeamento semântico da produção científica.',
        projectName: 'face85',
        conceptLabel: 'Chain',
        sourceCount: 20,
        itemCount: 174,
        conceptCount: 210,
        generatedAt: new Date().toISOString()
    };

    afterEach(() => {
        vscode.lm.tools = [];
        vscode.lm.invokeTool = async () => ({ content: [] });
    });

    it('mostra nome, objetivo e escala do corpus', async () => {
        const f = fakeStream();
        const tools = fakeGraph({ context: CONTEXT, topics: ['Gestão'] });
        await renderWelcome(f.stream, tools, 'face85', {});
        const text = f.text();
        assert.ok(text.includes('face85'));
        assert.ok(text.includes('Mapeamento semântico'));
        assert.ok(text.includes('210'), 'deve dizer quantos conceitos há');
        assert.ok(text.includes('174'));
    });

    it('ancora as sugestões nos tópicos reais do corpus', async () => {
        // "Liste os conceitos de Gestão" vale mais que "de um tópico": o
        // pesquisador reconhece o próprio corpus.
        const f = fakeStream();
        const tools = fakeGraph({ context: CONTEXT, topics: ['Gestão', 'Economia'] });
        const sug = await renderWelcome(f.stream, tools, 'face85', {});
        assert.ok(f.text().includes('Gestão'));
        assert.ok(sug.some((s) => s.prompt.includes('Gestão')));
        assert.ok(sug.some((s) => s.prompt.includes('Economia')));
    });

    it('usa o rótulo de conceito deste projeto nas sugestões', async () => {
        const f = fakeStream();
        const tools = fakeGraph({ context: { ...CONTEXT, conceptLabel: 'Code' }, topics: [] });
        const sug = await renderWelcome(f.stream, tools, 'outro', {});
        assert.ok(sug.some((s) => s.prompt.includes('Code')));
        assert.ok(!sug.some((s) => s.prompt.includes('Chain')));
    });

    it('serve um projeto com outro template: conceito Code, taxonomia Dimension', async () => {
        // Critério de aceite da Etapa 2. Antes, a saudação consultava
        // `GROUPED_BY`/`Topic` e caía no catch aqui, perdendo as sugestões sem
        // dizer por quê; e sugeria PageRank mesmo sem métrica no grafo.
        const f = fakeStream();
        const tools = fakeGraph({
            context: { ...CONTEXT, conceptLabel: 'Code' },
            topics: ['Governança'],
            schema: {
                types: [
                    { name: 'Code', category: 'vertex', properties: [{ name: 'name' }] },
                    { name: 'Item', category: 'vertex', properties: [] },
                    { name: 'Source', category: 'vertex', properties: [] },
                    { name: 'Dimension', category: 'vertex', properties: [{ name: 'name' }] },
                    { name: 'BELONGS_TO', category: 'edge', properties: [] }
                ]
            }
        });
        const sug = await renderWelcome(f.stream, tools, 'outro', {});

        // A taxonomia real aparece nomeada pelo rótulo do template.
        assert.ok(f.text().includes('Dimension'));
        assert.ok(f.text().includes('Governança'));
        assert.ok(sug.some((s) => s.prompt.includes('Governança')));
        // Sem métricas no schema, nenhuma sugestão promete PageRank.
        assert.ok(!sug.some((s) => /pagerank/i.test(s.prompt)));
    });

    it('sem banco selecionado, diz o que fazer e oferece o comando', async () => {
        const f = fakeStream();
        const sug = await renderWelcome(f.stream, [], undefined, {});
        assert.ok(f.text().includes('Select Chat Graph Database'));
        assert.deepStrictEqual(f.buttons, ['synesis.chat.selectDatabase']);
        assert.deepStrictEqual(sug, []);
    });

    it('grafo sem ProjectContext explica como obtê-lo, e segue útil', async () => {
        // Gerado por synesis-graph anterior a 0.8.0.
        const f = fakeStream();
        const tools = fakeGraph({ context: null });
        const sug = await renderWelcome(f.stream, tools, 'antigo', {});
        assert.ok(f.text().includes('0.8.0'));
        assert.ok(sug.length > 0, 'ainda deve sugerir perguntas');
    });

    it('avisa quando o snapshot está velho', async () => {
        const f = fakeStream();
        const velho = new Date(Date.now() - 200 * 86400000).toISOString();
        const tools = fakeGraph({ context: { ...CONTEXT, generatedAt: velho } });
        await renderWelcome(f.stream, tools, 'face85', {});
        assert.ok(f.text().includes('200 days'));
    });
});

describe('Diagnóstico — distinguir falta de contexto de falta de permissão', () => {
    /**
     * O ArcadeDB devolve recusa como TEXTO CRU com HTTP 200 e `isError: true`,
     * mas `LanguageModelToolResult` só expõe `content` — o sinal de erro não
     * chega à extensão. Sem reconhecer o texto, o `JSON.parse` falhava e tudo
     * virava "grafo sem contexto", mandando o pesquisador re-exportar um projeto
     * que já estava correto. Observado ao vivo com `face85_reader` tentando ler
     * o banco `social_acceptance`.
     */

    it('reconhece recusa de acesso e aponta a credencial', () => {
        const msg = describeAccessFailure(
            "User 'face85_reader' is not authorized to access database 'social_acceptance'",
            'social_acceptance'
        );
        // Aponta o COMANDO, não o arquivo: desde a Fase 4.6 a credencial é
        // configurada na extensão e a senha vive em `context.secrets`, então
        // mandar editar o `mcp.json` à mão seria orientação errada.
        assert.ok(msg.includes('Synesis: Settings'), 'deve apontar o comando');
        assert.ok(!/re-?export/i.test(msg), 'NÃO deve mandar re-exportar: não resolve permissão');
    });

    it('reconhece banco inexistente', () => {
        const msg = describeAccessFailure(
            "Database 'x' does not exist. Available databases: [face85].",
            'x'
        );
        assert.ok(msg.includes('does not exist'));
        assert.ok(msg.includes('Select Chat Graph Database'));
    });

    it('não confunde resposta legítima com erro', () => {
        assert.strictEqual(describeAccessFailure('{"records":[]}', 'face85'), undefined);
        assert.strictEqual(describeAccessFailure(undefined, 'face85'), undefined);
    });

    it('a recusa não vira contexto para o modelo', () => {
        // É diagnóstico para o pesquisador; numa pergunta comum o erro já
        // aparece na resposta da própria ferramenta.
        assert.strictEqual(renderProjectContext({ accessFailure: 'sem acesso' }), undefined);
    });
});

/**
 * Agnosticismo entre projetos (Etapa 2).
 *
 * Cada projeto Synesis declara no seu `.synt` o rótulo do conceito e as
 * taxonomias. O chat precisa derivá-los do schema real — um vocabulário fixo
 * serve a um projeto e engana todos os outros.
 *
 * Estes testes são o critério de aceite da etapa: um projeto sem `Topic` no
 * template ainda recebe saudação e sugestões coerentes.
 */
describe('Agnosticismo — taxonomia derivada do schema', () => {
    const { findTaxonomyLabel, taxonomyEdgePattern } = require('../../src/chat/chatParticipant');

    /** Projeto com outro template: conceito `Code`, taxonomia `Dimension`. */
    const OUTRO_PROJETO = {
        vertices: [
            { name: 'Code', properties: [{ name: 'name' }] },
            { name: 'Item', properties: [] },
            { name: 'Source', properties: [] },
            { name: 'ProjectContext', properties: [] },
            { name: 'Dimension', properties: [{ name: 'name' }] }
        ],
        edges: [{ name: 'BELONGS_TO' }, { name: 'MENTIONS' }]
    };

    it('acha a taxonomia de um projeto que não tem Topic', () => {
        // O defeito corrigido: a consulta fixava `Topic`/`GROUPED_BY`, então um
        // projeto sem `topic` no template caía no catch e perdia as sugestões —
        // em silêncio.
        assert.strictEqual(findTaxonomyLabel(OUTRO_PROJETO, 'Code'), 'Dimension');
    });

    it('não confunde o conceito nem os invariantes com taxonomia', () => {
        // `Item`, `Source` e `ProjectContext` existem em todo projeto Synesis;
        // o conceito é o que a pergunta já navega.
        const label = findTaxonomyLabel(OUTRO_PROJETO, 'Code');
        assert.ok(!['Code', 'Item', 'Source', 'ProjectContext'].includes(label));
    });

    it('devolve undefined quando o projeto não declara taxonomia alguma', () => {
        const semTaxonomia = {
            vertices: [{ name: 'Chain' }, { name: 'Item' }, { name: 'Source' }],
            edges: []
        };
        assert.strictEqual(findTaxonomyLabel(semTaxonomia, 'Chain'), undefined);
        assert.strictEqual(findTaxonomyLabel(undefined, 'Chain'), undefined);
    });

    it('usa a aresta que o schema declara, não a do face85', () => {
        assert.strictEqual(taxonomyEdgePattern(OUTRO_PROJETO, 'Dimension'), '-[:BELONGS_TO]->');
    });

    it('reconhece a aresta HAS_<CAMPO> gerada para campos sem mapeamento', () => {
        const comCampoLivre = {
            vertices: [{ name: 'Metodologia' }],
            edges: [{ name: 'HAS_METODOLOGIA' }]
        };
        assert.strictEqual(
            taxonomyEdgePattern(comCampoLivre, 'Metodologia'),
            '-[:HAS_METODOLOGIA]->'
        );
    });

    it('cai para aresta livre quando não dá para decidir pelo schema', () => {
        // Mais lento que nomear, e é exatamente o que se quer quando não se
        // sabe o nome: melhor uma consulta ampla que uma consulta errada.
        assert.strictEqual(taxonomyEdgePattern({ vertices: [], edges: [] }, 'Qualquer'), '-->');
    });
});

describe('Agnosticismo — sugestões condicionais', () => {
    const { availableMetrics, buildSuggestedQuestions } = require('../../src/chat/chatParticipant');

    it('detecta as métricas que o grafo realmente tem', () => {
        assert.deepStrictEqual(
            availableMetrics([{ name: 'Chain', properties: [{ name: 'name' }, { name: 'degree' }] }]),
            ['degree']
        );
        assert.deepStrictEqual(availableMetrics([]), []);
    });

    it('não sugere PageRank em grafo que não o calculou', () => {
        // O defeito: a sugestão era incondicional, então um grafo Neo4j ou um
        // export sem métricas entregava ao pesquisador uma pergunta que falha.
        const sug = buildSuggestedQuestions({ conceptLabel: 'Chain' }, { values: [] }, []);
        assert.ok(!sug.some((s) => /pagerank/i.test(s.prompt)));
    });

    it('sugere a métrica de centralidade que existe, quando existe', () => {
        const comDegree = buildSuggestedQuestions({ conceptLabel: 'Chain' }, { values: [] }, ['degree']);
        assert.ok(comDegree.some((s) => s.prompt.includes('degree')));
    });

    it('nomeia a taxonomia pelo rótulo do template, não por "tópico"', () => {
        // "do dimension X" num projeto com `Dimension`; chamar tudo de tópico
        // seria o vocabulário de um projeto imposto aos outros.
        const sug = buildSuggestedQuestions(
            { conceptLabel: 'Code' },
            { label: 'Dimension', values: ['Governança', 'Risco'] },
            []
        );
        assert.ok(sug.some((s) => s.prompt.includes('dimension Governança')));
    });

    it('mantém a sugestão de template mesmo sem taxonomia e sem métricas', () => {
        // O projeto mais pobre possível ainda recebe uma saudação útil.
        const sug = buildSuggestedQuestions(undefined, {}, []);
        assert.ok(sug.length > 0);
        assert.ok(sug.some((s) => /template/i.test(s.prompt)));
    });
});

describe('ProjectContext — capacidade lexical no prompt (Etapa 6)', () => {
    it('injeta a seção de busca lexical quando o grafo a declara', () => {
        const out = renderProjectContext({
            conceptLabel: 'Chain',
            fulltextConceptFields: 'search_name,ontology_description',
            fulltextItemFields: 'citation',
            fulltextAnalyzer: 'org.apache.lucene.analysis.br.BrazilianAnalyzer'
        });

        assert.match(out, /SEARCH_INDEX/);
        assert.match(out, /Chain\[search_name, ontology_description\]/);
    });

    it('omite a seção em grafo que não declara índice', () => {
        const out = renderProjectContext({ description: 'x', conceptLabel: 'Chain' });
        assert.ok(!/SEARCH_INDEX/.test(out || ''));
    });
});
