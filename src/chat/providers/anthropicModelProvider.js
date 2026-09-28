/**
 * anthropicModelProvider.js - VSCode LanguageModelChatProvider backed by the
 * Anthropic API directly (no OpenRouter, no Copilot subscription required).
 */

const vscode = require('vscode');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const MODELS = [
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 (Synesis)', maxInputTokens: 200000, maxOutputTokens: 8192 },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5 (Synesis)', maxInputTokens: 200000, maxOutputTokens: 8192 }
];

function toAnthropicMessages(messages) {
    const anthropicMessages = [];
    for (const message of messages) {
        const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
        const content = [];
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                // Bloco de texto vazio é rejeitado pela API ("text content
                // blocks must be non-empty"), então nem chega a ser enviado.
                if (part.value && part.value.trim()) {
                    content.push({ type: 'text', text: part.value });
                }
            } else if (part instanceof vscode.LanguageModelToolResultPart) {
                content.push({
                    type: 'tool_result',
                    tool_use_id: part.callId,
                    content: (part.content || [])
                        .filter((p) => p instanceof vscode.LanguageModelTextPart)
                        .map((p) => ({ type: 'text', text: p.value }))
                });
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                content.push({ type: 'tool_use', id: part.callId, name: part.name, input: part.input });
            }
        }
        if (content.length > 0) {
            anthropicMessages.push({ role, content });
        }
    }
    return anthropicMessages;
}

function toAnthropicTools(tools) {
    if (!tools || tools.length === 0) {
        return undefined;
    }
    return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema || { type: 'object', properties: {} }
    }));
}

class AnthropicModelProvider {
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
                    'Synesis Chat: catálogo Anthropic indisponível, usando a lista fixa.',
                    error && error.message
                );
            }
        }
        return models.map((m) => ({
            id: m.id,
            name: m.name,
            tooltip: 'Anthropic API direta.',
            family: 'claude',
            maxInputTokens: m.maxInputTokens,
            maxOutputTokens: m.maxOutputTokens,
            version: '1.0.0',
            capabilities: { toolCalling: m.toolCalling !== false, imageInput: false }
        }));
    }

    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new Error('Synesis Chat: configure a API key da Anthropic (comando "Synesis: Configuração").');
        }

        const body = {
            model: model.id,
            max_tokens: model.maxOutputTokens || 4096,
            messages: toAnthropicMessages(messages),
            tools: toAnthropicTools(options.tools)
        };

        // Prompt de sistema vai no campo `system` de topo, não como mensagem.
        const system = options.modelOptions && options.modelOptions.system;
        if (system) {
            body.system = system;
        }

        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());

        const response = await fetch(ANTHROPIC_API_URL, {
            method: 'POST',
            headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`Anthropic API error ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();
        for (const block of data.content || []) {
            if (block.type === 'text') {
                progress.report(new vscode.LanguageModelTextPart(block.text));
            } else if (block.type === 'tool_use') {
                progress.report(new vscode.LanguageModelToolCallPart(block.id, block.name, block.input));
            }
        }
    }

    async provideTokenCount(_model, text, _token) {
        const asString = typeof text === 'string' ? text : JSON.stringify(text.content);
        return Math.ceil(asString.length / 4);
    }
}

module.exports = {
    AnthropicModelProvider,
    // Exportados para teste unitário.
    toAnthropicMessages,
    toAnthropicTools
};
