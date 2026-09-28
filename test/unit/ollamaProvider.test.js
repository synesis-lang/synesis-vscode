/**
 * Provedor Ollama — modelos locais no chat @synesis.
 *
 * Formato confirmado contra um Ollama 0.34.4 real (qwen3.5, gemma4, Mistral
 * Small 3.2): os payloads abaixo copiam o que o servidor devolveu.
 */

require('../helpers/vscodeMock').install();

const assert = require('assert');
const vscode = require('vscode');
const {
    fetchOllamaModels,
    normalizeOllamaUrl,
    ollamaContextLength
} = require('../../src/chat/modelCatalog');
const {
    OllamaModelProvider,
    toOllamaMessages,
    parseArguments
} = require('../../src/chat/providers/ollamaModelProvider');

function jsonResponse(payload, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload) };
}

/** Servidor falso: `/api/tags` e `/api/show` a partir de uma tabela de modelos. */
function fakeServer(models) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        calls.push({ url, init });
        if (url.endsWith('/api/tags')) {
            return jsonResponse({ models: Object.keys(models).map((name) => ({ name })) });
        }
        if (url.endsWith('/api/show')) {
            const { model } = JSON.parse(init.body);
            return models[model] ? jsonResponse(models[model]) : jsonResponse({ error: 'not found' }, 404);
        }
        throw new Error(`rota inesperada: ${url}`);
    };
    return { fetchImpl, calls };
}

const QWEN = { capabilities: ['completion', 'vision', 'tools', 'thinking'], model_info: { 'qwen35.context_length': 262144 } };
const PEQUENO = { capabilities: ['completion'], model_info: { 'llama.context_length': 8192 } };
const EMBED = { capabilities: ['embedding'], model_info: { 'bert.context_length': 512 } };

describe('Endereço do Ollama', () => {
    it('aceita o endereço copiado com /v1 ou /api e barra final', () => {
        // O provider usa a API nativa; o sufixo da API OpenAI-compatível sai.
        assert.strictEqual(normalizeOllamaUrl(' http://localhost:11434/v1/ '), 'http://localhost:11434');
        assert.strictEqual(normalizeOllamaUrl('http://srv:11434/api'), 'http://srv:11434');
        assert.strictEqual(normalizeOllamaUrl(''), '');
        assert.strictEqual(normalizeOllamaUrl(undefined), '');
    });

    it('lê a janela máxima de qualquer arquitetura', () => {
        assert.strictEqual(ollamaContextLength(QWEN), 262144);
        assert.strictEqual(ollamaContextLength({ model_info: {} }), undefined);
        assert.strictEqual(ollamaContextLength(undefined), undefined);
    });
});

describe('Catálogo do Ollama', () => {
    it('anuncia a janela PEDIDA, não a máxima do modelo', async () => {
        // O Ollama só aloca o que `num_ctx` pede. Anunciar 262k faria o VSCode
        // encher um contexto que o servidor não vai alocar.
        const { fetchImpl } = fakeServer({ 'qwen3.5:9b': QWEN });
        const [model] = await fetchOllamaModels('http://srv:11434', { contextLength: 32768, fetchImpl });

        assert.strictEqual(model.maxInputTokens + model.maxOutputTokens, 32768);
        assert.strictEqual(model.toolCalling, true);
        assert.strictEqual(model.name, 'qwen3.5:9b · Ollama');
    });

    it('não pede mais que o máximo do modelo', async () => {
        const { fetchImpl } = fakeServer({ pequeno: PEQUENO });
        const [model] = await fetchOllamaModels('http://srv:11434', { contextLength: 32768, fetchImpl });

        assert.strictEqual(model.maxInputTokens + model.maxOutputTokens, 8192);
        assert.strictEqual(model.toolCalling, false, 'sem "tools" em capabilities');
    });

    it('deixa modelos de embedding fora do seletor', async () => {
        const { fetchImpl } = fakeServer({ 'qwen3.5:9b': QWEN, 'nomic-embed': EMBED });
        const ids = (await fetchOllamaModels('http://srv:11434', { fetchImpl })).map((m) => m.id);

        assert.deepStrictEqual(ids, ['qwen3.5:9b']);
    });

    it('modelo sem detalhes continua disponível, com a janela pedida', async () => {
        // `/api/show` falhou para ele: melhor oferecê-lo que sumir em silêncio.
        const { fetchImpl } = fakeServer({ 'qwen3.5:9b': QWEN });
        const semShow = async (url, init) =>
            url.endsWith('/api/tags') ? jsonResponse({ models: [{ name: 'misterioso' }] }) : fetchImpl(url, init);
        const [model] = await fetchOllamaModels('http://srv:11434', { contextLength: 16384, fetchImpl: semShow });

        assert.strictEqual(model.id, 'misterioso');
        assert.strictEqual(model.maxInputTokens + model.maxOutputTokens, 16384);
        assert.strictEqual(model.toolCalling, true);
    });

    it('servidor fora do ar é erro, não lista vazia', async () => {
        // O provider transforma o erro em "sem modelos"; o painel, em mensagem.
        const fetchImpl = async () => jsonResponse({}, 500);
        await assert.rejects(fetchOllamaModels('http://srv:11434', { fetchImpl }), /Ollama indisponível/);
    });

    it('toda consulta ao servidor tem prazo', async () => {
        // localhost:11434 desta máquina aceita a conexão e nunca responde; sem
        // prazo, o seletor inteiro travaria.
        const { fetchImpl, calls } = fakeServer({ 'qwen3.5:9b': QWEN });
        await fetchOllamaModels('http://srv:11434', { fetchImpl });

        assert.ok(calls.length >= 2);
        for (const call of calls) {
            assert.ok(call.init && call.init.signal, `sem prazo em ${call.url}`);
        }
    });

    it('sem endereço não consulta nada', async () => {
        const { fetchImpl, calls } = fakeServer({ 'qwen3.5:9b': QWEN });
        assert.deepStrictEqual(await fetchOllamaModels('', { fetchImpl }), []);
        assert.strictEqual(calls.length, 0);
    });
});

describe('Mensagens no formato nativo do Ollama', () => {
    const { User, Assistant } = vscode.LanguageModelChatMessageRole;

    it('prompt de sistema vira a primeira mensagem', () => {
        const out = toOllamaMessages([{ role: User, content: [new vscode.LanguageModelTextPart('oi')] }], 'regras');
        assert.deepStrictEqual(out, [
            { role: 'system', content: 'regras' },
            { role: 'user', content: 'oi' }
        ]);
    });

    it('argumentos vão como objeto e o resultado leva o nome da ferramenta', () => {
        // O VSCode entrega só o callId no resultado; o Ollama quer `tool_name`.
        const out = toOllamaMessages([
            { role: User, content: [new vscode.LanguageModelTextPart('quantos itens?')] },
            {
                role: Assistant,
                content: [new vscode.LanguageModelToolCallPart('call_1', 'contar_itens', { rotulo: 'Item' })]
            },
            {
                role: User,
                content: [
                    new vscode.LanguageModelToolResultPart('call_1', [new vscode.LanguageModelTextPart('{"total": 347}')])
                ]
            }
        ]);

        assert.deepStrictEqual(out[1], {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_1', function: { name: 'contar_itens', arguments: { rotulo: 'Item' } } }]
        });
        assert.deepStrictEqual(out[2], { role: 'tool', content: '{"total": 347}', tool_name: 'contar_itens' });
    });

    it('argumentos em string (Ollama antigo) também são lidos', () => {
        assert.deepStrictEqual(parseArguments('{"a":1}'), { a: 1 });
        assert.deepStrictEqual(parseArguments({ a: 1 }), { a: 1 });
        assert.deepStrictEqual(parseArguments('{quebrado'), {});
    });
});

describe('OllamaModelProvider', () => {
    const MODELO = { id: 'qwen3.5:9b', name: 'qwen3.5:9b · Ollama', maxInputTokens: 28672, maxOutputTokens: 4096, toolCalling: true };

    function provider({ url = 'http://srv:11434', discoverModels = async () => [MODELO], fetchImpl } = {}) {
        return new OllamaModelProvider({ getBaseUrl: () => url, discoverModels, fetchImpl });
    }

    it('sem endereço, fica fora do seletor sem consultar nada', async () => {
        let consultou = false;
        const p = provider({ url: '', discoverModels: async () => { consultou = true; return [MODELO]; } });

        assert.deepStrictEqual(await p.provideLanguageModelChatInformation({}, {}), []);
        assert.strictEqual(consultou, false);
    });

    it('servidor fora do ar esconde o provedor em vez de quebrar o seletor', async () => {
        const p = provider({ discoverModels: async () => { throw new Error('ECONNREFUSED'); } });
        assert.deepStrictEqual(await p.provideLanguageModelChatInformation({}, {}), []);
    });

    it('expõe o evento de mudança que o VSCode exige', () => {
        const p = provider();
        let avisos = 0;
        p.onDidChangeLanguageModelChatInformation(() => { avisos += 1; });
        p.refresh();
        assert.strictEqual(avisos, 1);
    });

    it('pede ao servidor exatamente a janela anunciada, pela API nativa', async () => {
        let enviado;
        const fetchImpl = async (url, init) => {
            enviado = { url, body: JSON.parse(init.body) };
            return jsonResponse({
                message: {
                    role: 'assistant',
                    content: '',
                    thinking: 'raciocínio que não deve vazar',
                    tool_calls: [{ id: 'call_mgo0z224', function: { index: 0, name: 'contar_itens', arguments: { rotulo: 'grafo' } } }]
                },
                done_reason: 'stop'
            });
        };
        const p = provider({ fetchImpl });
        const reported = [];
        await p.provideLanguageModelChatResponse(
            MODELO,
            [{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('quantos?')] }],
            { modelOptions: { system: 'regras' }, tools: [{ name: 'contar_itens', description: 'conta', inputSchema: { type: 'object' } }] },
            { report: (part) => reported.push(part) },
            { onCancellationRequested: () => {} }
        );

        assert.strictEqual(enviado.url, 'http://srv:11434/api/chat');
        assert.deepStrictEqual(enviado.body.options, { num_ctx: 32768, num_predict: 4096 });
        assert.strictEqual(enviado.body.stream, false);
        assert.strictEqual(enviado.body.tools[0].function.name, 'contar_itens');

        // Só a chamada de ferramenta chega ao chat: `content` vazio e o
        // raciocínio (campo à parte) não viram texto.
        assert.strictEqual(reported.length, 1);
        assert.ok(reported[0] instanceof vscode.LanguageModelToolCallPart);
        assert.strictEqual(reported[0].callId, 'call_mgo0z224');
        assert.deepStrictEqual(reported[0].input, { rotulo: 'grafo' });
    });

    it('chamada sem id (Ollama antigo) ganha um id', async () => {
        const fetchImpl = async () =>
            jsonResponse({ message: { content: 'ok', tool_calls: [{ function: { name: 'f', arguments: '{}' } }] } });
        const reported = [];
        await provider({ fetchImpl }).provideLanguageModelChatResponse(
            MODELO, [], {}, { report: (part) => reported.push(part) }, { onCancellationRequested: () => {} }
        );

        assert.strictEqual(reported[0].value, 'ok');
        assert.ok(reported[1].callId, 'sem id o VSCode não casa chamada e resultado');
    });

    it('erro HTTP do servidor vira erro legível', async () => {
        const fetchImpl = async () => jsonResponse({ error: 'model not found' }, 404);
        await assert.rejects(
            provider({ fetchImpl }).provideLanguageModelChatResponse(MODELO, [], {}, { report() {} }, { onCancellationRequested: () => {} }),
            /Ollama API error 404/
        );
    });
});
