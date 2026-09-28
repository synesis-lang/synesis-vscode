/**
 * Descoberta de modelos.
 *
 * As listas eram fixas no código: 2 modelos da Anthropic, 2 da OpenAI, 4 do
 * OpenRouter. Verificado contra o catálogo real, o OpenRouter publica **424**
 * modelos — nenhuma lista fixa acompanha isso, e testar um modelo novo exigia
 * editar o fonte e reconstruir a extensão.
 */

const assert = require('assert');
const {
    CatalogCache,
    declaresToolCalling,
    fetchAnthropicModels,
    fetchGeminiModels,
    fetchOpenAiModels,
    fetchOpenRouterModels,
    fromOpenRouterEntry,
    splitContext,
    DEFAULT_MAX_INPUT,
    DEFAULT_MAX_OUTPUT
} = require('../../src/chat/modelCatalog');

/** `fetch` de mentira: devolve o payload dado, sem rede. */
function fakeFetch(payload, { ok = true, status = 200 } = {}) {
    return async () => ({ ok, status, json: async () => payload });
}

describe('Janela de contexto', () => {
    it('reserva espaço para a resposta dentro do contexto declarado', () => {
        // Vários catálogos publicam UM número cobrindo entrada e saída. Anunciar
        // o total como maxInputTokens encheria a janela e não sobraria espaço
        // para responder.
        const { maxInputTokens, maxOutputTokens } = splitContext(65536);

        assert.ok(maxInputTokens + maxOutputTokens <= 65536);
        assert.ok(maxOutputTokens > 0, 'sem espaço de saída a requisição falha');
    });

    it('cai no padrão quando o catálogo não informa', () => {
        assert.deepStrictEqual(splitContext(0), {
            maxInputTokens: DEFAULT_MAX_INPUT,
            maxOutputTokens: DEFAULT_MAX_OUTPUT
        });
        assert.deepStrictEqual(splitContext(undefined), {
            maxInputTokens: DEFAULT_MAX_INPUT,
            maxOutputTokens: DEFAULT_MAX_OUTPUT
        });
    });

    it('respeita o teto de saída que o catálogo declara', () => {
        const { maxOutputTokens } = splitContext(200000, 64000);
        assert.strictEqual(maxOutputTokens, 64000);
    });
});

describe('Tool-calling declarado pelo catálogo', () => {
    it('reconhece quem declara `tools`', () => {
        assert.strictEqual(declaresToolCalling({ supported_parameters: ['tools', 'temperature'] }), true);
    });

    it('reconhece quem NÃO declara — 66 dos 424 do catálogo real', () => {
        // Esses nunca chamariam ferramenta, e o chat inteiro depende disso.
        assert.strictEqual(declaresToolCalling({ supported_parameters: ['temperature'] }), false);
    });

    it('dá o benefício da dúvida quando o metadado falta', () => {
        // Ausência de informação não é ausência de suporte: barrar por metadado
        // incompleto seria pior do que deixar o teste decidir.
        assert.strictEqual(declaresToolCalling({}), true);
        assert.strictEqual(declaresToolCalling({ supported_parameters: null }), true);
    });
});

describe('OpenRouter — campo livre', () => {
    const CATALOGO = {
        data: [
            {
                id: 'liquid/lfm-2.5-2.6b:free',
                name: 'LiquidAI: LFM2.5-2.6B (free)',
                context_length: 65536,
                supported_parameters: ['tools', 'temperature']
            },
            {
                id: 'sem/ferramenta:free',
                name: 'Sem Ferramenta',
                context_length: 8192,
                supported_parameters: ['temperature']
            }
        ]
    };

    it('devolve só o que o pesquisador declarou, na ordem dele', async () => {
        // A ordem é a da campanha de teste, não a do catálogo.
        const models = await fetchOpenRouterModels(
            ['sem/ferramenta:free', 'liquid/lfm-2.5-2.6b:free'],
            { fetchImpl: fakeFetch(CATALOGO) }
        );

        assert.deepStrictEqual(models.map((m) => m.id), [
            'sem/ferramenta:free',
            'liquid/lfm-2.5-2.6b:free'
        ]);
    });

    it('traz limites e tool-calling do catálogo, não do settings', async () => {
        // `maxInputTokens` errado faz o VSCode truncar o prompt em silêncio — e
        // é lá que vivem o schema, a sondagem e as regras de contagem.
        const [m] = await fetchOpenRouterModels(['liquid/lfm-2.5-2.6b:free'], {
            fetchImpl: fakeFetch(CATALOGO)
        });

        assert.ok(m.maxInputTokens > 8192, 'o limite real do modelo deve prevalecer');
        assert.strictEqual(m.toolCalling, true);
    });

    it('marca quem não suporta ferramenta', async () => {
        const [m] = await fetchOpenRouterModels(['sem/ferramenta:free'], {
            fetchImpl: fakeFetch(CATALOGO)
        });

        assert.strictEqual(m.toolCalling, false);
    });

    it('não engole id desconhecido — erro do servidor é melhor que sumiço', async () => {
        const [m] = await fetchOpenRouterModels(['nao/existe'], { fetchImpl: fakeFetch(CATALOGO) });

        assert.strictEqual(m.id, 'nao/existe');
        assert.strictEqual(m.maxInputTokens, DEFAULT_MAX_INPUT);
    });

    it('sobrevive ao catálogo fora do ar', async () => {
        const models = await fetchOpenRouterModels(['liquid/lfm-2.5-2.6b:free'], {
            fetchImpl: async () => {
                throw new Error('rede fora');
            }
        });

        assert.strictEqual(models.length, 1, 'o id declarado continua utilizável');
    });

    it('lista vazia não vira consulta de rede', async () => {
        let chamou = false;
        const models = await fetchOpenRouterModels([], {
            fetchImpl: async () => {
                chamou = true;
                return { ok: true, json: async () => ({ data: [] }) };
            }
        });

        assert.deepStrictEqual(models, []);
        assert.strictEqual(chamou, false);
    });

    it('não duplica o rótulo do fornecedor no nome', () => {
        // "LFM2.5-2.6B (free) (OpenRouter)" era o que saía antes.
        const m = fromOpenRouterEntry(CATALOGO.data[0]);
        assert.ok(!/\(free\) \(OpenRouter\)/.test(m.name));
    });
});

describe('Catálogos com chave', () => {
    it('Anthropic: usa o nome de exibição do catálogo', async () => {
        const models = await fetchAnthropicModels('sk-ant-x', {
            fetchImpl: fakeFetch({
                data: [{ id: 'claude-opus-5', display_name: 'Claude Opus 5' }]
            })
        });

        assert.strictEqual(models[0].id, 'claude-opus-5');
        assert.match(models[0].name, /Claude Opus 5/);
    });

    it('OpenAI: descarta o que não conversa', async () => {
        // `GET /v1/models` lista embeddings, TTS, transcrição e imagem — nenhum
        // serve ao chat, e oferecê-los produziria erro só na hora de usar.
        const models = await fetchOpenAiModels('sk-x', {
            fetchImpl: fakeFetch({
                data: [
                    { id: 'gpt-5.1' },
                    { id: 'text-embedding-3-large' },
                    { id: 'whisper-1' },
                    { id: 'dall-e-3' },
                    { id: 'o3-mini' }
                ]
            })
        });

        assert.deepStrictEqual(models.map((m) => m.id), ['gpt-5.1', 'o3-mini']);
    });

    it('Gemini: usa os limites reais e só o que gera conteúdo', async () => {
        const models = await fetchGeminiModels('AIza-x', {
            fetchImpl: fakeFetch({
                models: [
                    {
                        name: 'models/gemini-2.5-flash',
                        displayName: 'Gemini 2.5 Flash',
                        inputTokenLimit: 1048576,
                        outputTokenLimit: 65536,
                        supportedGenerationMethods: ['generateContent']
                    },
                    {
                        name: 'models/text-embedding-004',
                        supportedGenerationMethods: ['embedContent']
                    }
                ]
            })
        });

        assert.strictEqual(models.length, 1);
        assert.strictEqual(models[0].id, 'gemini-2.5-flash', 'o prefixo `models/` sai do id');
        assert.strictEqual(models[0].maxInputTokens, 1048576);
    });

    it('erro HTTP vira exceção, para o provider cair na lista fixa', async () => {
        await assert.rejects(
            () => fetchAnthropicModels('sk-ant-x', { fetchImpl: fakeFetch({}, { ok: false, status: 401 }) }),
            /401/
        );
    });
});

describe('CatalogCache', () => {
    it('não repete a consulta dentro do TTL', async () => {
        const cache = new CatalogCache();
        let chamadas = 0;
        const produce = async () => {
            chamadas += 1;
            return [{ id: 'x' }];
        };

        await cache.resolve('anthropic', produce);
        await cache.resolve('anthropic', produce);

        assert.strictEqual(chamadas, 1);
    });

    it('não congela lista vazia — chave ainda por configurar', async () => {
        // Congelar o vazio por 30 min deixaria o seletor vazio mesmo depois de o
        // pesquisador configurar a chave.
        const cache = new CatalogCache();
        let chamadas = 0;
        const produce = async () => {
            chamadas += 1;
            return [];
        };

        await cache.resolve('openai', produce);
        await cache.resolve('openai', produce);

        assert.strictEqual(chamadas, 2);
    });

    it('expira pelo TTL', async () => {
        let clock = 0;
        const cache = new CatalogCache({ ttlMs: 100, now: () => clock });
        let chamadas = 0;
        const produce = async () => {
            chamadas += 1;
            return [{ id: 'x' }];
        };

        await cache.resolve('k', produce);
        clock = 101;
        await cache.resolve('k', produce);

        assert.strictEqual(chamadas, 2);
    });
});
