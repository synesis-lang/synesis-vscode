/**
 * openAiCompatibleModelProvider.js - VSCode LanguageModelChatProvider for any
 * OpenAI-compatible chat/completions endpoint. Used for OpenAI itself and for
 * OpenRouter (same request/response shape, different base URL and model IDs).
 *
 * Format confirmed working end-to-end (tool_calls with real ArcadeDB MCP
 * tools) via curl against https://openrouter.ai/api/v1/chat/completions in
 * this same investigation series, including free-tier models.
 */

const vscode = require('vscode');

function toOpenAiMessages(messages, systemPrompt) {
    const openAiMessages = [];
    // No formato OpenAI o prompt de sistema é a primeira mensagem, com papel
    // `system` — não um `user` extra empilhado antes do prompt real.
    if (systemPrompt) {
        openAiMessages.push({ role: 'system', content: systemPrompt });
    }
    for (const message of messages) {
        const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
        const textParts = [];
        const toolCalls = [];
        const toolResults = [];
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                // Partes de texto vazias são descartadas: provedores rejeitam
                // conteúdo vazio, e uma parte em branco não informa nada.
                if (part.value && part.value.trim()) {
                    textParts.push(part.value);
                }
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push({
                    id: part.callId,
                    type: 'function',
                    function: { name: part.name, arguments: JSON.stringify(part.input) }
                });
            } else if (part instanceof vscode.LanguageModelToolResultPart) {
                toolResults.push(part);
            }
        }

        if (toolResults.length > 0) {
            for (const result of toolResults) {
                const text = (result.content || [])
                    .filter((p) => p instanceof vscode.LanguageModelTextPart)
                    .map((p) => p.value)
                    .join('\n');
                openAiMessages.push({ role: 'tool', tool_call_id: result.callId, content: text });
            }
            continue;
        }

        const entry = { role };
        if (textParts.length > 0) {
            entry.content = textParts.join('\n');
        }
        if (toolCalls.length > 0) {
            entry.tool_calls = toolCalls;
            entry.content = entry.content || null;
        }
        if (entry.content !== undefined || entry.tool_calls) {
            openAiMessages.push(entry);
        }
    }
    return openAiMessages;
}

function toOpenAiTools(tools) {
    if (!tools || tools.length === 0) {
        return undefined;
    }
    return tools.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema || { type: 'object', properties: {} }
        }
    }));
}

class OpenAiCompatibleModelProvider {
    /**
     * @param {object} config
     * @param {string} config.vendorLabel human label, e.g. "OpenAI" / "OpenRouter"
     * @param {string} config.baseUrl e.g. "https://api.openai.com/v1" or "https://openrouter.ai/api/v1"
     * @param {Array<{id:string,name:string,maxInputTokens:number,maxOutputTokens:number}>} config.models
     * @param {() => Promise<string|undefined>} config.getApiKey
     */
    /**
     * `discoverModels` é opcional: quando presente, é ela que decide a lista, e
     * `models` passa a ser o fallback de quando a descoberta falha (rede fora,
     * chave inválida, formato inesperado). Sem ela o provider se comporta como
     * antes — lista fixa —, que é o que mantém os testes existentes válidos.
     */
    constructor({ vendorLabel, baseUrl, models, getApiKey, discoverModels }) {
        this.vendorLabel = vendorLabel;
        this.baseUrl = baseUrl;
        this.models = models;
        this.getApiKey = getApiKey;
        this.discoverModels = discoverModels;

        // **Sem este evento o seletor não atualiza.**
        //
        // `provideLanguageModelChatInformation` é consultado quando o VSCode
        // decide, não a cada abertura do seletor: o editor guarda a lista e só
        // volta a perguntar quando o provider AVISA que ela mudou. Sem o evento,
        // salvar um modelo novo no painel não produzia efeito nenhum até
        // recarregar a janela — o sintoma observado com o OpenRouter.
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
        // Sem chave o provedor não responde, então não deve povoar o seletor:
        // um modelo que aparece e falha só ao ser usado é pior que um ausente.
        // (O registry já documentava este contrato, mas nada o implementava.)
        if (!(await this.getApiKey())) {
            return [];
        }
        let models = this.models;
        if (this.discoverModels) {
            try {
                const discovered = await this.discoverModels();
                if (Array.isArray(discovered) && discovered.length > 0) {
                    models = discovered;
                }
            } catch (error) {
                // Catálogo indisponível não pode esvaziar o seletor: cair na
                // lista fixa mantém o chat utilizável.
                console.warn(
                    `Synesis Chat: catálogo ${this.vendorLabel} indisponível, usando a lista fixa.`,
                    error && error.message
                );
            }
        }
        return models.map((m) => ({
            id: m.id,
            name: m.name,
            tooltip: `${this.vendorLabel} API direta.`,
            family: this.vendorLabel.toLowerCase(),
            maxInputTokens: m.maxInputTokens,
            maxOutputTokens: m.maxOutputTokens,
            version: '1.0.0',
            // Declarado pelo catálogo quando ele informa (o OpenRouter publica
            // `supported_parameters`). Antes era `true` fixo para todo modelo —
            // uma promessa que ninguém verificava, e o chat inteiro depende
            // dela: sem tool-calling o modelo responde sem consultar o banco.
            capabilities: { toolCalling: m.toolCalling !== false, imageInput: false }
        }));
    }

    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new Error(`Synesis Chat: configure a API key da ${this.vendorLabel} (comando "Synesis: Configurar Provedor de IA").`);
        }

        const body = {
            model: model.id,
            messages: toOpenAiMessages(messages, options.modelOptions && options.modelOptions.system),
            tools: toOpenAiTools(options.tools),
            stream: false
        };

        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());

        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`${this.vendorLabel} API error ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();
        const message = data.choices && data.choices[0] && data.choices[0].message;
        if (!message) {
            return;
        }

        if (message.content) {
            progress.report(new vscode.LanguageModelTextPart(message.content));
        }
        for (const call of message.tool_calls || []) {
            let args = {};
            try {
                args = JSON.parse(call.function.arguments || '{}');
            } catch {
                // modelo devolveu JSON malformado — repassa vazio em vez de derrubar a resposta inteira
            }
            progress.report(new vscode.LanguageModelToolCallPart(call.id, call.function.name, args));
        }
    }

    async provideTokenCount(_model, text, _token) {
        const asString = typeof text === 'string' ? text : JSON.stringify(text.content);
        return Math.ceil(asString.length / 4);
    }
}

module.exports = {
    OpenAiCompatibleModelProvider,
    // Exportados para teste unitário.
    toOpenAiMessages,
    toOpenAiTools
};
