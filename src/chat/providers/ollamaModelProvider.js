/**
 * ollamaModelProvider.js - VSCode LanguageModelChatProvider para modelos locais
 * servidos pelo Ollama (na própria máquina ou num servidor da rede).
 *
 * **Por que a API nativa (`/api/chat`) e não a compatível com OpenAI (`/v1`).**
 * O Ollama só aloca o contexto que `options.num_ctx` pede; sem ele usa um padrão
 * pequeno e CORTA o prompt em silêncio. A API `/v1` não aceita `num_ctx`. O
 * prompt do chat carrega schema, sondagem e regras de contagem — perder o começo
 * dele produz respostas erradas sem nenhum erro visível. A nativa aceita.
 *
 * Formato confirmado contra Ollama 0.34.4 (qwen3.5, gemma4, Mistral Small 3.2):
 * `tool_calls[].function.arguments` chega como OBJETO (não string JSON); o
 * resultado volta como `{role:'tool', tool_name, content}`; o raciocínio dos
 * modelos que pensam vem em `message.thinking`, separado do `content`.
 *
 * Sem API key: o provedor aparece no seletor quando há endereço configurado E o
 * servidor responde com ao menos um modelo.
 */

const vscode = require('vscode');
const { toOpenAiTools } = require('./openAiCompatibleModelProvider');
const { normalizeOllamaUrl } = require('../modelCatalog');

/**
 * Mensagens do VSCode → formato nativo do Ollama.
 *
 * O resultado de ferramenta precisa do NOME da ferramenta (`tool_name`), mas o
 * VSCode entrega só o `callId`. O nome é recuperado das chamadas que o próprio
 * assistente fez antes, na mesma conversa.
 */
function toOllamaMessages(messages, systemPrompt) {
    const out = [];
    if (systemPrompt) {
        out.push({ role: 'system', content: systemPrompt });
    }
    const toolNames = new Map();
    for (const message of messages) {
        const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
        const textParts = [];
        const toolCalls = [];
        const toolResults = [];
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                if (part.value && part.value.trim()) {
                    textParts.push(part.value);
                }
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                toolNames.set(part.callId, part.name);
                toolCalls.push({
                    id: part.callId,
                    function: { name: part.name, arguments: part.input || {} }
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
                const entry = { role: 'tool', content: text };
                const name = toolNames.get(result.callId);
                if (name) {
                    entry.tool_name = name;
                }
                out.push(entry);
            }
            continue;
        }

        if (textParts.length === 0 && toolCalls.length === 0) {
            continue;
        }
        const entry = { role, content: textParts.join('\n') };
        if (toolCalls.length > 0) {
            entry.tool_calls = toolCalls;
        }
        out.push(entry);
    }
    return out;
}

/** Argumentos de uma chamada: objeto no Ollama atual, string JSON em versões antigas. */
function parseArguments(raw) {
    if (raw && typeof raw === 'object') {
        return raw;
    }
    try {
        return JSON.parse(raw || '{}');
    } catch {
        // JSON malformado — repassa vazio em vez de derrubar a resposta inteira.
        return {};
    }
}

class OllamaModelProvider {
    /**
     * @param {object} config
     * @param {() => string} config.getBaseUrl endereço do servidor (vazio = desligado)
     * @param {() => Promise<Array<{id,name,maxInputTokens,maxOutputTokens,toolCalling}>>} config.discoverModels
     * @param {typeof fetch} [config.fetchImpl]
     */
    constructor({ getBaseUrl, discoverModels, fetchImpl = fetch }) {
        this.getBaseUrl = () => normalizeOllamaUrl(getBaseUrl());
        this.discoverModels = discoverModels;
        this.fetchImpl = fetchImpl;
        this._onDidChange = new vscode.EventEmitter();
        this.onDidChangeLanguageModelChatInformation = this._onDidChange.event;
    }

    refresh() {
        this._onDidChange.fire();
    }

    dispose() {
        this._onDidChange.dispose();
    }

    async provideLanguageModelChatInformation(_options, _token) {
        const baseUrl = this.getBaseUrl();
        if (!baseUrl) {
            return [];
        }
        let models;
        try {
            models = await this.discoverModels();
        } catch (error) {
            // Não há lista fixa possível: os modelos são os que o pesquisador
            // instalou. Servidor fora do ar = provedor ausente do seletor.
            console.warn(`Synesis Chat: Ollama indisponível em ${baseUrl}.`, error && error.message);
            return [];
        }
        return (models || []).map((m) => ({
            id: m.id,
            name: m.name,
            tooltip: `Ollama em ${baseUrl} — contexto pedido: ${m.maxInputTokens + m.maxOutputTokens} tokens.`,
            family: 'ollama',
            maxInputTokens: m.maxInputTokens,
            maxOutputTokens: m.maxOutputTokens,
            version: '1.0.0',
            capabilities: { toolCalling: m.toolCalling !== false, imageInput: false }
        }));
    }

    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
        const baseUrl = this.getBaseUrl();
        if (!baseUrl) {
            throw new Error('Synesis Chat: configure o endereço do Ollama na página de configuração do Synesis.');
        }

        const body = {
            model: model.id,
            messages: toOllamaMessages(messages, options.modelOptions && options.modelOptions.system),
            tools: toOpenAiTools(options.tools),
            stream: false,
            // A janela anunciada ao VSCode (entrada + saída) é exatamente a que se
            // pede ao servidor: o que o seletor promete é o que o Ollama aloca.
            options: {
                num_ctx: model.maxInputTokens + model.maxOutputTokens,
                num_predict: model.maxOutputTokens
            }
        };

        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());

        let response;
        try {
            response = await this.fetchImpl(`${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal
            });
        } catch (error) {
            if (error && error.name === 'AbortError') {
                throw error;
            }
            throw new Error(`Ollama em ${baseUrl} não pôde ser alcançado: ${error && error.message}`, { cause: error });
        }

        if (!response.ok) {
            throw new Error(`Ollama API error ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();
        const message = data && data.message;
        if (!message) {
            return;
        }

        if (message.content) {
            progress.report(new vscode.LanguageModelTextPart(message.content));
        }
        (message.tool_calls || []).forEach((call, index) => {
            const fn = call && call.function;
            if (!fn || !fn.name) {
                return;
            }
            // Versões antigas do Ollama não mandam `id`; o VSCode exige um para
            // casar a chamada com o resultado.
            const callId = call.id || `ollama_${Date.now()}_${index}`;
            progress.report(new vscode.LanguageModelToolCallPart(callId, fn.name, parseArguments(fn.arguments)));
        });
    }

    async provideTokenCount(_model, text, _token) {
        const asString = typeof text === 'string' ? text : JSON.stringify(text.content);
        return Math.ceil(asString.length / 4);
    }
}

module.exports = {
    OllamaModelProvider,
    // Exportados para teste unitário.
    toOllamaMessages,
    parseArguments
};
