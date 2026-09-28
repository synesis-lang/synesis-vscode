/**
 * geminiModelProvider.js - VSCode LanguageModelChatProvider backed by the
 * Google Gemini API directly (generativelanguage.googleapis.com).
 *
 * Distinct request/response shape from Anthropic and OpenAI-compatible
 * providers: `contents[].parts[]` instead of `messages[].content`, and
 * `functionCall`/`functionResponse` parts instead of a `tool_calls` array.
 */

const vscode = require('vscode');

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const MODELS = [
    { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash (Synesis)', maxInputTokens: 1000000, maxOutputTokens: 8192 },
    { id: 'gemini-3.0-pro', name: 'Gemini 3.0 Pro (Synesis)', maxInputTokens: 1000000, maxOutputTokens: 8192 }
];

/**
 * O Gemini não devolve um ID por chamada de ferramenta — o `functionResponse`
 * casa com o `functionCall` apenas pelo NOME da função. Usar o nome cru como
 * `callId` fazia duas chamadas a `query` na mesma rodada (comportamento normal
 * do modelo) virarem resultados indistinguíveis.
 *
 * Geramos então um callId sintético `nome#índice`, único dentro da rodada, e
 * desfazemos o sufixo na volta para o Gemini, que só entende o nome puro.
 */
const CALL_ID_SEPARATOR = '#';

function makeCallId(name, index) {
    return `${name}${CALL_ID_SEPARATOR}${index}`;
}

/** Extrai o nome real da função a partir do callId sintético. */
function callIdToFunctionName(callId) {
    const separatorIndex = String(callId).lastIndexOf(CALL_ID_SEPARATOR);
    return separatorIndex === -1 ? String(callId) : String(callId).slice(0, separatorIndex);
}

function toGeminiContents(messages) {
    const contents = [];
    for (const message of messages) {
        const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'model' : 'user';
        const parts = [];
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                // Partes de texto vazias são descartadas: provedores rejeitam
                // conteúdo vazio, e uma parte em branco não informa nada.
                if (part.value && part.value.trim()) {
                    parts.push({ text: part.value });
                }
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                parts.push({ functionCall: { name: part.name, args: part.input } });
            } else if (part instanceof vscode.LanguageModelToolResultPart) {
                const text = (part.content || [])
                    .filter((p) => p instanceof vscode.LanguageModelTextPart)
                    .map((p) => p.value)
                    .join('\n');
                parts.push({
                    functionResponse: { name: callIdToFunctionName(part.callId), response: { content: text } }
                });
            }
        }
        if (parts.length > 0) {
            contents.push({ role, parts });
        }
    }
    return contents;
}

function toGeminiTools(tools) {
    if (!tools || tools.length === 0) {
        return undefined;
    }
    return [
        {
            functionDeclarations: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema || { type: 'object', properties: {} }
            }))
        }
    ];
}

class GeminiModelProvider {
    /** `discoverModels` opcional; sem ela vale a lista fixa `MODELS`. */
    constructor(getApiKey, discoverModels) {
        this.getApiKey = getApiKey;
        this.discoverModels = discoverModels;
        // Sem este evento o seletor nao atualiza: o VSCode guarda a lista de
        // modelos e so volta a perguntar quando o provider avisa que ela mudou.
        this._onDidChange = new vscode.EventEmitter();
        this.onDidChangeLanguageModelChatInformation = this._onDidChange.event;
    }

    /** Avisa o editor que a lista mudou, para ele reconsultar os modelos. */
    refresh() {
        this._onDidChange.fire();
    }

    dispose() {
        this._onDidChange.dispose();
    }

    async provideLanguageModelChatInformation(_options, _token) {
        // Sem chave o provedor nao responde: nao deve povoar o seletor com
        // modelos que falhariam so na hora do uso.
        if (!(await this.getApiKey())) {
            return [];
        }
        let models = MODELS;
        if (this.discoverModels) {
            try {
                const discovered = await this.discoverModels();
                if (Array.isArray(discovered) && discovered.length > 0) {
                    models = discovered;
                }
            } catch (error) {
                console.warn(
                    'Synesis Chat: catálogo Gemini indisponível, usando a lista fixa.',
                    error && error.message
                );
            }
        }
        return models.map((m) => ({
            id: m.id,
            name: m.name,
            tooltip: 'Google Gemini API direta.',
            family: 'gemini',
            maxInputTokens: m.maxInputTokens,
            maxOutputTokens: m.maxOutputTokens,
            version: '1.0.0',
            capabilities: { toolCalling: m.toolCalling !== false, imageInput: false }
        }));
    }

    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new Error('Synesis Chat: configure a API key do Google Gemini (comando "Synesis: Configuração").');
        }

        const body = {
            contents: toGeminiContents(messages),
            tools: toGeminiTools(options.tools)
        };

        // No Gemini o prompt de sistema é `systemInstruction`, um campo de
        // topo com o mesmo shape de `contents[]` — não uma mensagem `user`.
        const system = options.modelOptions && options.modelOptions.system;
        if (system) {
            body.systemInstruction = { parts: [{ text: system }] };
        }

        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());

        const url = `${GEMINI_API_BASE}/${model.id}:generateContent`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`Gemini API error ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();
        const candidate = data.candidates && data.candidates[0];
        const parts = (candidate && candidate.content && candidate.content.parts) || [];

        let callIndex = 0;
        for (const part of parts) {
            if (part.text) {
                progress.report(new vscode.LanguageModelTextPart(part.text));
            } else if (part.functionCall) {
                // callId sintético `nome#índice`: o Gemini não fornece um, e o
                // nome puro colidiria entre duas chamadas à mesma ferramenta.
                progress.report(
                    new vscode.LanguageModelToolCallPart(
                        makeCallId(part.functionCall.name, callIndex),
                        part.functionCall.name,
                        part.functionCall.args || {}
                    )
                );
                callIndex += 1;
            }
        }
    }

    async provideTokenCount(_model, text, _token) {
        const asString = typeof text === 'string' ? text : JSON.stringify(text.content);
        return Math.ceil(asString.length / 4);
    }
}

module.exports = {
    GeminiModelProvider,
    // Exportados para teste unitário.
    toGeminiContents,
    toGeminiTools,
    makeCallId,
    callIdToFunctionName
};
