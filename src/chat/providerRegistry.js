/**
 * providerRegistry.js - Central registration of AI providers for the
 * @synesis chat participant. Lets the researcher pick Anthropic, OpenAI,
 * Google Gemini, or OpenRouter, each with its own API key stored via
 * VSCode's SecretStorage (encrypted by the OS, never synced between
 * machines) instead of a plaintext setting.
 */

const vscode = require('vscode');
const { AnthropicModelProvider } = require('./providers/anthropicModelProvider');
const { OpenAiCompatibleModelProvider } = require('./providers/openAiCompatibleModelProvider');
const { GeminiModelProvider } = require('./providers/geminiModelProvider');
const {
    CatalogCache,
    fetchAnthropicModels,
    fetchGeminiModels,
    fetchOpenAiModels,
    fetchOpenRouterModels
} = require('./modelCatalog');

const SECRET_KEYS = {
    anthropic: 'synesis.apiKey.anthropic',
    openai: 'synesis.apiKey.openai',
    gemini: 'synesis.apiKey.gemini',
    openrouter: 'synesis.apiKey.openrouter'
};

const PROVIDERS = [
    {
        id: 'anthropic',
        vendor: 'synesis-anthropic',
        label: 'Anthropic (Claude)',
        keyHint: 'sk-ant-...',
        validate: (v) => v.startsWith('sk-ant-')
    },
    {
        id: 'openai',
        vendor: 'synesis-openai',
        label: 'OpenAI (GPT)',
        keyHint: 'sk-...',
        validate: (v) => v.startsWith('sk-') && !v.startsWith('sk-ant-') && !v.startsWith('sk-or-')
    },
    {
        id: 'gemini',
        vendor: 'synesis-gemini',
        label: 'Google Gemini',
        keyHint: 'AIza...',
        validate: (v) => v.length > 10
    },
    {
        id: 'openrouter',
        vendor: 'synesis-openrouter',
        label: 'OpenRouter (multi-modelo, inclui opções gratuitas)',
        keyHint: 'sk-or-v1-...',
        validate: (v) => v.startsWith('sk-or-')
    }
];

const OPENROUTER_MODELS = [
    { id: 'google/gemini-3.7-flash', name: 'Gemini 3.7 Flash (OpenRouter)', maxInputTokens: 1000000, maxOutputTokens: 8192 },
    { id: 'openai/gpt-oss-20b:free', name: 'GPT-OSS 20B — grátis (OpenRouter)', maxInputTokens: 131072, maxOutputTokens: 8192 },
    { id: 'nvidia/nemotron-nano-9b-v2:free', name: 'Nemotron Nano 9B — grátis (OpenRouter)', maxInputTokens: 128000, maxOutputTokens: 8192 },
    { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5 (via OpenRouter)', maxInputTokens: 200000, maxOutputTokens: 8192 }
];

const OPENAI_MODELS = [
    { id: 'gpt-5.1', name: 'GPT-5.1 (Synesis)', maxInputTokens: 400000, maxOutputTokens: 16384 },
    { id: 'gpt-5.1-mini', name: 'GPT-5.1 Mini (Synesis)', maxInputTokens: 400000, maxOutputTokens: 16384 }
];

function getApiKeyGetter(context, providerId) {
    return () => context.secrets.get(SECRET_KEYS[providerId]);
}

/**
 * Modelos do OpenRouter que o pesquisador declarou testar.
 *
 * Campo LIVRE, e não lista descoberta, porque o catálogo tem 424 modelos
 * (verificado) — despejá-los no seletor do VSCode o tornaria inutilizável. Aqui
 * o pesquisador nomeia o que quer, e os metadados vêm do catálogo público.
 *
 * Lido a cada consulta ao seletor, não na ativação: acrescentar um modelo à
 * campanha não deve exigir recarregar a janela.
 */
function readOpenRouterModelIds() {
    const raw = vscode.workspace.getConfiguration('synesisExplorer.chat').get('openRouterModels');
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.map((id) => String(id || '').trim()).filter(Boolean);
}

/**
 * A descoberta está ligada?
 *
 * Desligá-la devolve as listas fixas — a saída para quem está sem rede, atrás
 * de proxy, ou quer o seletor estável durante uma campanha de medição.
 */
function discoveryEnabled() {
    const value = vscode.workspace
        .getConfiguration('synesisExplorer.chat')
        .get('discoverModels');
    return value !== false;
}

/**
 * Cache dos catálogos, compartilhado por todos os provedores.
 *
 * O seletor de modelo do VSCode chama `provideLanguageModelChatInformation`
 * toda vez que é aberto; sem cache, cada abertura viraria uma ida à rede por
 * provedor configurado.
 */
const catalogCache = new CatalogCache();

/**
 * Fábrica da função de descoberta de um provedor.
 *
 * Devolve `undefined` quando a descoberta está desligada — e aí o provider usa
 * a lista fixa, que é o comportamento anterior.
 */
function buildDiscovery(providerId, getApiKey) {
    if (providerId === 'openrouter') {
        // Sem chave: o catálogo do OpenRouter é público, então a descoberta
        // funciona mesmo antes de configurar a chave — o modelo só não responde.
        return () => {
            // A setting é lida A CADA consulta, não na construção do provider:
            // desligar a descoberta (ou mudar a lista) deve valer na próxima
            // abertura do seletor, sem recarregar a janela.
            if (!discoveryEnabled()) {
                return Promise.resolve([]);
            }
            const ids = readOpenRouterModelIds();
            if (ids.length === 0) {
                return Promise.resolve([]);
            }
            // A chave do cache inclui os ids: mudar a lista no settings deve
            // valer na próxima abertura do seletor, não daqui a 30 minutos.
            return catalogCache.resolve(`openrouter:${ids.join(',')}`, () =>
                fetchOpenRouterModels(ids)
            );
        };
    }
    const fetchers = {
        anthropic: fetchAnthropicModels,
        openai: fetchOpenAiModels,
        gemini: fetchGeminiModels
    };
    const fetcher = fetchers[providerId];
    if (!fetcher) {
        return undefined;
    }
    return async () => {
        if (!discoveryEnabled()) {
            return [];
        }
        const apiKey = await getApiKey();
        if (!apiKey) {
            // Sem chave o provedor já fica invisível no seletor; devolver vazio
            // faz o provider manter a lista fixa sem tentar a rede.
            return [];
        }
        return catalogCache.resolve(providerId, () => fetcher(apiKey));
    };
}

function buildProvider(context, providerId) {
    const getApiKey = getApiKeyGetter(context, providerId);
    const discoverModels = buildDiscovery(providerId, getApiKey);
    switch (providerId) {
        case 'anthropic':
            return new AnthropicModelProvider(getApiKey, discoverModels);
        case 'openai':
            return new OpenAiCompatibleModelProvider({
                vendorLabel: 'OpenAI',
                baseUrl: 'https://api.openai.com/v1',
                models: OPENAI_MODELS,
                getApiKey,
                discoverModels
            });
        case 'openrouter':
            return new OpenAiCompatibleModelProvider({
                vendorLabel: 'OpenRouter',
                baseUrl: 'https://openrouter.ai/api/v1',
                models: OPENROUTER_MODELS,
                getApiKey,
                discoverModels
            });
        case 'gemini':
            return new GeminiModelProvider(getApiKey, discoverModels);
        default:
            throw new Error(`Provedor desconhecido: ${providerId}`);
    }
}

/** Registra um LanguageModelChatProvider por provedor — cada um só aparece no
 * seletor nativo se tiver API key configurada (provideLanguageModelChatInformation
 * devolve lista vazia quando a chave não existe, então o provedor "existe" mas
 * fica invisível até o pesquisador configurar). */
function registerAllProviders(context) {
    const disposables = [];
    const instances = [];
    for (const provider of PROVIDERS) {
        const instance = buildProvider(context, provider.id);
        instances.push(instance);
        disposables.push(vscode.lm.registerLanguageModelChatProvider(provider.vendor, instance));
    }

    /**
     * Faz o editor reconsultar os modelos de todos os provedores.
     *
     * O VSCode guarda a lista devolvida por
     * `provideLanguageModelChatInformation` e só volta a perguntar quando o
     * provider dispara `onDidChangeLanguageModelChatInformation`. Sem esta
     * chamada, salvar um modelo do OpenRouter no painel não tinha efeito
     * nenhum até recarregar a janela — o defeito observado.
     */
    const refreshAll = () => {
        // O catálogo também precisa ser relido: a lista de ids mudou, e a
        // entrada em cache é de outra lista.
        catalogCache.invalidate();
        for (const instance of instances) {
            if (typeof instance.refresh === 'function') {
                instance.refresh();
            }
        }
    };

    // Mudança pelo `settings.json` (ou por outra janela) vale tanto quanto a
    // feita no painel: quem edita o JSON à mão espera o mesmo resultado.
    disposables.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (
                event.affectsConfiguration('synesisExplorer.chat.openRouterModels') ||
                event.affectsConfiguration('synesisExplorer.chat.discoverModels')
            ) {
                refreshAll();
            }
        })
    );

    disposables.refreshProviders = refreshAll;
    return disposables;
}

// As chaves de API são gravadas e removidas pela página de configuração
// (settingsPanel.js). Os comandos de QuickPick/InputBox que faziam isso saíram
// na 0.14.0, e com eles a setting `preferredProvider`, que só ordenava o menu
// de um deles — ver CHANGELOG, "um só caminho de configuração".

module.exports = {
    registerAllProviders,
    PROVIDERS,
    SECRET_KEYS
};
