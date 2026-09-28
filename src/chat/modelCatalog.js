/**
 * modelCatalog.js — quais modelos cada provedor oferece, perguntado a ele.
 *
 * **O defeito que corrige.** Os quatro provedores anunciavam listas FIXAS no
 * código: dois modelos da Anthropic, dois da OpenAI, quatro do OpenRouter. Um
 * modelo novo — ou um que o pesquisador queira testar — exigia editar o fonte e
 * reconstruir a extensão. Verificado contra o catálogo real: o OpenRouter
 * publica **424 modelos**. Nenhuma lista fixa acompanha isso.
 *
 * **Duas estratégias, porque os catálogos são de naturezas diferentes.**
 *
 * - Anthropic, OpenAI e Gemini têm catálogo pequeno e enumerável: dá para
 *   perguntar `GET /models` com a chave que já está guardada e mostrar tudo.
 * - O OpenRouter tem centenas de modelos de dezenas de fornecedores. Listar
 *   todos no seletor do VSCode seria inutilizável, então ali o pesquisador
 *   DECLARA o que quer testar (`synesisExplorer.chat.openRouterModels`) e os
 *   metadados vêm do catálogo público.
 *
 * **Por que os metadados vêm do catálogo, e não do settings.** `maxInputTokens`
 * errado faz o VSCode truncar o prompt em silêncio — e o prompt é justamente
 * onde vivem o schema, a sondagem e as regras de contagem. Pedir o número ao
 * pesquisador seria pedir que ele acerte um detalhe que o servidor já sabe:
 * o `liquid/lfm-2.5-2.6b:free` declara 65.536, que ninguém adivinharia.
 *
 * **`toolCalling` deixa de ser promessa.** Os três providers anunciavam
 * `capabilities: { toolCalling: true }` fixo, para todo modelo, sem verificar.
 * O catálogo do OpenRouter declara `supported_parameters`, e `tools` aparece em
 * 358 dos 424 — os outros 66 nunca chamariam ferramenta, e o chat inteiro
 * depende disso. Derivar do catálogo elimina esses candidatos antes do teste,
 * em vez de descobrir um a um que o modelo responde sem consultar o banco.
 *
 * Tudo é best-effort: falha de rede, chave inválida ou formato inesperado caem
 * na lista fixa do provedor, que é o comportamento anterior a este módulo.
 */

/** Catálogo público do OpenRouter — não exige chave. */
const OPENROUTER_CATALOG_URL = 'https://openrouter.ai/api/v1/models';

/**
 * Por quanto tempo o catálogo lido continua válido.
 *
 * Trinta minutos: o catálogo de um provedor muda em escala de semanas, e o
 * seletor de modelo do VSCode pode consultar o provider várias vezes por
 * sessão. Sem cache, cada abertura do seletor viraria uma ida à rede.
 */
const CATALOG_TTL_MS = 30 * 60 * 1000;

/**
 * Teto de saída quando o catálogo não informa.
 *
 * Conservador de propósito: um valor alto demais faz a API recusar a requisição
 * inteira, enquanto um baixo demais só encurta a resposta.
 */
const DEFAULT_MAX_OUTPUT = 4096;

/** Contexto assumido quando o catálogo não informa — o mínimo comum hoje. */
const DEFAULT_MAX_INPUT = 8192;

/**
 * Quanto do contexto declarado se reserva para a resposta.
 *
 * Vários catálogos publicam UM número (`context_length`) que cobre entrada e
 * saída somadas. Anunciar esse total como `maxInputTokens` faria o VSCode
 * encher a janela inteira com o prompt e não sobrar espaço para o modelo
 * responder — a requisição falha, ou a resposta vem truncada.
 */
function splitContext(contextLength, declaredMaxOutput) {
    if (!Number.isFinite(contextLength) || contextLength <= 0) {
        return { maxInputTokens: DEFAULT_MAX_INPUT, maxOutputTokens: DEFAULT_MAX_OUTPUT };
    }
    const maxOutputTokens = Number.isFinite(declaredMaxOutput) && declaredMaxOutput > 0
        ? Math.min(declaredMaxOutput, contextLength)
        : Math.min(DEFAULT_MAX_OUTPUT, Math.floor(contextLength / 4));
    return {
        maxInputTokens: Math.max(1, contextLength - maxOutputTokens),
        maxOutputTokens
    };
}

/**
 * O catálogo do OpenRouter declara `tools` em `supported_parameters`?
 *
 * Ausência do campo NÃO é ausência de suporte — é ausência de informação. Nesse
 * caso vale o benefício da dúvida: barrar um modelo por metadado incompleto
 * seria pior do que deixá-lo falhar no teste, que é o que a campanha faz de
 * qualquer forma.
 */
function declaresToolCalling(entry) {
    const params = entry && entry.supported_parameters;
    if (!Array.isArray(params)) {
        return true;
    }
    return params.includes('tools');
}

/** Uma entrada do catálogo do OpenRouter → a forma que os providers usam. */
function fromOpenRouterEntry(entry) {
    const { maxInputTokens, maxOutputTokens } = splitContext(
        Number(entry.context_length),
        entry.top_provider && Number(entry.top_provider.max_completion_tokens)
    );
    // O catálogo já rotula o fornecedor ("Anthropic: Claude Haiku 4.5") e a
    // gratuidade ("(free)"); acrescentar "(OpenRouter)" a esse nome produzia
    // "LFM2.5-2.6B (free) (OpenRouter)". O sufixo só entra quando o nome não
    // deixa claro de onde o modelo vem.
    const rawName = entry.name || entry.id;
    return {
        id: entry.id,
        name: /openrouter/i.test(rawName) ? rawName : `${rawName} · OpenRouter`,
        maxInputTokens,
        maxOutputTokens,
        toolCalling: declaresToolCalling(entry)
    };
}

/**
 * Lê o catálogo público do OpenRouter e devolve só os ids pedidos.
 *
 * A ORDEM segue a do pesquisador, não a do catálogo: ele declarou os modelos na
 * ordem em que pretende testá-los.
 *
 * Um id que não existe no catálogo ainda assim é devolvido, com metadados
 * padrão — digitar errado deve produzir um erro do servidor ao usar (que nomeia
 * o problema), não o desaparecimento silencioso do modelo do seletor.
 */
async function fetchOpenRouterModels(ids, { fetchImpl = fetch } = {}) {
    const wanted = (ids || []).map((id) => String(id || '').trim()).filter(Boolean);
    if (wanted.length === 0) {
        return [];
    }
    let byId = new Map();
    try {
        const response = await fetchImpl(OPENROUTER_CATALOG_URL);
        if (response && response.ok) {
            const payload = await response.json();
            for (const entry of (payload && payload.data) || []) {
                if (entry && entry.id) {
                    byId.set(entry.id, entry);
                }
            }
        }
    } catch {
        // Sem catálogo: os ids seguem valendo, com metadados padrão.
        byId = new Map();
    }
    return wanted.map((id) =>
        byId.has(id)
            ? fromOpenRouterEntry(byId.get(id))
            : {
                  id,
                  name: `${id} (OpenRouter)`,
                  maxInputTokens: DEFAULT_MAX_INPUT,
                  maxOutputTokens: DEFAULT_MAX_OUTPUT,
                  toolCalling: true
              }
    );
}

/**
 * Modelos da Anthropic, pela API.
 *
 * `GET /v1/models` devolve `{data:[{id,display_name}]}`. O catálogo não publica
 * janela de contexto, então vale o patamar dos modelos atuais da família.
 */
async function fetchAnthropicModels(apiKey, { fetchImpl = fetch } = {}) {
    const response = await fetchImpl('https://api.anthropic.com/v1/models?limit=100', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    });
    if (!response || !response.ok) {
        throw new Error(`catálogo Anthropic indisponível (HTTP ${response && response.status})`);
    }
    const payload = await response.json();
    return ((payload && payload.data) || [])
        .filter((m) => m && m.id)
        .map((m) => ({
            id: m.id,
            name: `${m.display_name || m.id} (Synesis)`,
            maxInputTokens: 200000,
            maxOutputTokens: 8192,
            toolCalling: true
        }));
}

/**
 * Modelos da OpenAI, pela API.
 *
 * `GET /v1/models` lista TUDO na conta — embeddings, TTS, transcrição, imagem.
 * Nenhum desses conversa, e oferecê-los no seletor de chat produziria erro só
 * na hora de usar. O filtro é por prefixo de família de chat, que é o que a
 * própria OpenAI usa para nomear (`gpt-*`, `o1`/`o3`/`o4`), descartando os
 * sufixos que denunciam outra modalidade.
 */
const OPENAI_NON_CHAT = /embedding|whisper|tts|audio|image|dall-e|moderation|realtime|transcribe|search|codex/i;

async function fetchOpenAiModels(apiKey, { fetchImpl = fetch } = {}) {
    const response = await fetchImpl('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!response || !response.ok) {
        throw new Error(`catálogo OpenAI indisponível (HTTP ${response && response.status})`);
    }
    const payload = await response.json();
    return ((payload && payload.data) || [])
        .filter((m) => m && m.id)
        .filter((m) => /^(gpt-|o\d)/i.test(m.id) && !OPENAI_NON_CHAT.test(m.id))
        .map((m) => ({
            id: m.id,
            name: `${m.id} (Synesis)`,
            maxInputTokens: 128000,
            maxOutputTokens: 16384,
            toolCalling: true
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Modelos do Gemini, pela API.
 *
 * O catálogo publica `inputTokenLimit`/`outputTokenLimit` por modelo — os
 * únicos números confiáveis dos três — e `supportedGenerationMethods`, que diz
 * quais servem para conversa.
 */
async function fetchGeminiModels(apiKey, { fetchImpl = fetch } = {}) {
    const response = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200`
    );
    if (!response || !response.ok) {
        throw new Error(`catálogo Gemini indisponível (HTTP ${response && response.status})`);
    }
    const payload = await response.json();
    return ((payload && payload.models) || [])
        .filter((m) => m && m.name)
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => ({
            // `models/gemini-2.5-flash` → `gemini-2.5-flash`
            id: String(m.name).replace(/^models\//, ''),
            name: `${m.displayName || m.name} (Synesis)`,
            maxInputTokens: Number(m.inputTokenLimit) || DEFAULT_MAX_INPUT,
            maxOutputTokens: Number(m.outputTokenLimit) || DEFAULT_MAX_OUTPUT,
            toolCalling: true
        }));
}

/**
 * Quanto esperar pelo servidor Ollama ao montar o seletor.
 *
 * Curto de propósito: a consulta roda toda vez que o seletor é aberto, e um
 * endereço que não responde (medido: `localhost:11434` desta máquina aceita a
 * conexão e nunca responde) travaria o seletor inteiro — de todos os provedores.
 */
const OLLAMA_PROBE_TIMEOUT_MS = 3000;

/** Janela pedida ao Ollama quando a setting não informa. */
const OLLAMA_DEFAULT_CONTEXT = 32768;

/**
 * Normaliza o endereço do Ollama para a raiz do servidor.
 *
 * Quem copia o endereço da documentação do Ollama costuma trazer `/v1` (a API
 * compatível com OpenAI) ou `/api`. O provider usa a API NATIVA, então os dois
 * sufixos saem — ver `OllamaModelProvider` para o porquê.
 */
function normalizeOllamaUrl(raw) {
    let url = String(raw || '').trim().replace(/\/+$/, '');
    url = url.replace(/\/(v1|api)$/i, '');
    return url;
}

/** O contexto informado pelo `/api/show` (`<arquitetura>.context_length`). */
function ollamaContextLength(show) {
    const info = (show && show.model_info) || {};
    for (const [key, value] of Object.entries(info)) {
        if (key.endsWith('.context_length') && Number.isFinite(Number(value))) {
            return Number(value);
        }
    }
    return undefined;
}

/**
 * Modelos instalados num servidor Ollama.
 *
 * `GET /api/tags` lista os modelos; `POST /api/show` diz, por modelo, o que ele
 * faz (`capabilities`) e a janela máxima que suporta.
 *
 * **A janela anunciada é a que será PEDIDA, não a máxima do modelo.** O Ollama
 * só aloca o contexto que `num_ctx` pede, e sem ele usa um padrão pequeno e
 * corta o prompt em silêncio — justamente onde vivem o schema e as regras do
 * chat. Anunciar a máxima (262.144 no qwen3.5) faria o VSCode encher um contexto
 * que o servidor não vai alocar, ou esgotar a VRAM se alocasse. Por isso vale o
 * MENOR entre a máxima do modelo e `contextLength` (setting do pesquisador).
 *
 * Modelos só de embedding (`capabilities` sem `completion`) não conversam e
 * ficam fora do seletor.
 */
async function fetchOllamaModels(
    baseUrl,
    { contextLength = OLLAMA_DEFAULT_CONTEXT, fetchImpl = fetch, timeoutMs = OLLAMA_PROBE_TIMEOUT_MS } = {}
) {
    const root = normalizeOllamaUrl(baseUrl);
    if (!root) {
        return [];
    }
    const requested = Number.isFinite(contextLength) && contextLength > 0 ? contextLength : OLLAMA_DEFAULT_CONTEXT;

    const response = await fetchImpl(`${root}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response || !response.ok) {
        throw new Error(`Ollama indisponível em ${root} (HTTP ${response && response.status})`);
    }
    const payload = await response.json();
    const names = ((payload && payload.models) || [])
        .map((m) => m && (m.name || m.model))
        .filter(Boolean);

    const described = await Promise.all(
        names.map(async (name) => {
            try {
                const show = await fetchImpl(`${root}/api/show`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ model: name }),
                    signal: AbortSignal.timeout(timeoutMs)
                });
                return { name, show: show && show.ok ? await show.json() : undefined };
            } catch {
                // Sem detalhes o modelo continua disponível, com a janela pedida.
                return { name, show: undefined };
            }
        })
    );

    return described
        .filter(({ show }) => {
            const caps = show && show.capabilities;
            return !Array.isArray(caps) || caps.includes('completion');
        })
        .map(({ name, show }) => {
            const caps = show && show.capabilities;
            const modelMax = ollamaContextLength(show);
            const contextWindow = modelMax ? Math.min(modelMax, requested) : requested;
            return {
                id: name,
                name: `${name} · Ollama`,
                ...splitContext(contextWindow),
                // Ausência de `capabilities` é ausência de informação (servidor
                // antigo), não de suporte — mesmo critério do OpenRouter.
                toolCalling: Array.isArray(caps) ? caps.includes('tools') : true
            };
        });
}

/**
 * Cache de catálogo por provedor, com TTL.
 *
 * O seletor do VSCode chama `provideLanguageModelChatInformation` sempre que é
 * aberto; sem cache, cada abertura viraria uma ida à rede.
 */
class CatalogCache {
    constructor({ ttlMs = CATALOG_TTL_MS, now = () => Date.now() } = {}) {
        this._ttlMs = ttlMs;
        this._now = now;
        this._entries = new Map();
    }

    async resolve(key, produce) {
        const hit = this._entries.get(key);
        if (hit && this._now() < hit.expiresAt) {
            return hit.value;
        }
        const value = await produce();
        // Lista vazia não é cacheada: costuma significar chave ainda não
        // configurada ou rede fora, e congelar isso por 30 min faria o seletor
        // ficar vazio mesmo depois de o pesquisador corrigir.
        if (Array.isArray(value) && value.length > 0) {
            this._entries.set(key, { value, expiresAt: this._now() + this._ttlMs });
        }
        return value;
    }

    invalidate(key) {
        if (key === undefined) {
            this._entries.clear();
            return;
        }
        this._entries.delete(key);
    }
}

module.exports = {
    CatalogCache,
    declaresToolCalling,
    fetchAnthropicModels,
    fetchGeminiModels,
    fetchOpenAiModels,
    fetchOllamaModels,
    fetchOpenRouterModels,
    fromOpenRouterEntry,
    normalizeOllamaUrl,
    ollamaContextLength,
    splitContext,
    CATALOG_TTL_MS,
    DEFAULT_MAX_INPUT,
    DEFAULT_MAX_OUTPUT,
    OLLAMA_DEFAULT_CONTEXT,
    OLLAMA_PROBE_TIMEOUT_MS,
    OPENROUTER_CATALOG_URL
};
