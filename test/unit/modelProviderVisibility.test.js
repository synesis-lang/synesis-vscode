/**
 * Quando um modelo aparece no seletor de chat — e quando não deve aparecer.
 *
 * **O defeito observado.** O pesquisador declarava `liquid/lfm-2.5-2.6b:free` no
 * painel de Configuração, o valor era gravado, e o modelo **não aparecia** no
 * seletor do chat. Recarregar a janela o trazia.
 *
 * A causa é contratual, não de gravação: o VSCode **guarda** a lista devolvida
 * por `provideLanguageModelChatInformation` e só volta a perguntar quando o
 * provider dispara `onDidChangeLanguageModelChatInformation` (verificado em
 * `vscode.d.ts` 1.134, linha 20688). Nenhum dos providers implementava o evento,
 * então nada podia invalidar a lista guardada.
 */

require('../helpers/vscodeMock').install();

const assert = require('assert');
const {
    OpenAiCompatibleModelProvider
} = require('../../src/chat/providers/openAiCompatibleModelProvider');
const { AnthropicModelProvider } = require('../../src/chat/providers/anthropicModelProvider');
const { GeminiModelProvider } = require('../../src/chat/providers/geminiModelProvider');

const UM_MODELO = [{ id: 'padrao', name: 'Padrão', maxInputTokens: 100, maxOutputTokens: 10 }];

function openRouter({ getApiKey = async () => 'sk-or-v1-x', discoverModels } = {}) {
    return new OpenAiCompatibleModelProvider({
        vendorLabel: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        models: UM_MODELO,
        getApiKey,
        discoverModels
    });
}

describe('Aviso de mudança na lista de modelos', () => {
    it('os três providers expõem o evento que o VSCode exige', () => {
        // Sem isto o editor nunca reconsulta, e salvar um modelo no painel não
        // produz efeito até recarregar a janela.
        const key = async () => 'k';
        for (const provider of [
            openRouter(),
            new AnthropicModelProvider(key),
            new GeminiModelProvider(key)
        ]) {
            assert.strictEqual(
                typeof provider.onDidChangeLanguageModelChatInformation,
                'function',
                `${provider.constructor.name} não expõe o evento de mudança`
            );
            assert.strictEqual(typeof provider.refresh, 'function');
        }
    });

    it('`refresh()` notifica quem estiver ouvindo', () => {
        const provider = openRouter();
        let avisos = 0;
        provider.onDidChangeLanguageModelChatInformation(() => {
            avisos += 1;
        });

        provider.refresh();
        provider.refresh();

        assert.strictEqual(avisos, 2);
    });

    it('a lista reflete a nova declaração depois do refresh', async () => {
        // O cenário exato do defeito: o pesquisador acrescenta um modelo e ele
        // precisa aparecer sem recarregar a janela.
        let declarados = [];
        const provider = openRouter({
            discoverModels: async () =>
                declarados.map((id) => ({
                    id,
                    name: id,
                    maxInputTokens: 1000,
                    maxOutputTokens: 100
                }))
        });

        assert.deepStrictEqual(
            (await provider.provideLanguageModelChatInformation({}, {})).map((m) => m.id),
            ['padrao'],
            'sem declaração, valem os modelos padrão'
        );

        declarados = ['liquid/lfm-2.5-2.6b:free'];
        provider.refresh();

        assert.deepStrictEqual(
            (await provider.provideLanguageModelChatInformation({}, {})).map((m) => m.id),
            ['liquid/lfm-2.5-2.6b:free']
        );
    });
});

describe('Chave ausente esconde o provedor', () => {
    it('sem chave, nenhum modelo é oferecido', async () => {
        // Um modelo que aparece no seletor e falha só ao ser usado é pior que um
        // ausente: o erro chega depois da pergunta, não antes.
        const provider = openRouter({ getApiKey: async () => undefined });

        assert.deepStrictEqual(await provider.provideLanguageModelChatInformation({}, {}), []);
    });

    it('vale para os três provedores', async () => {
        const semChave = async () => undefined;
        for (const provider of [
            openRouter({ getApiKey: semChave }),
            new AnthropicModelProvider(semChave),
            new GeminiModelProvider(semChave)
        ]) {
            assert.deepStrictEqual(
                await provider.provideLanguageModelChatInformation({}, {}),
                [],
                `${provider.constructor.name} ofereceu modelo sem chave configurada`
            );
        }
    });

    it('com chave, os modelos voltam', async () => {
        const provider = openRouter({ getApiKey: async () => 'sk-or-v1-x' });
        const models = await provider.provideLanguageModelChatInformation({}, {});

        assert.strictEqual(models.length, 1);
        assert.strictEqual(models[0].id, 'padrao');
    });
});

describe('Descoberta que falha não esvazia o seletor', () => {
    it('catálogo fora do ar mantém a lista fixa', async () => {
        const provider = openRouter({
            discoverModels: async () => {
                throw new Error('rede fora');
            }
        });

        assert.deepStrictEqual(
            (await provider.provideLanguageModelChatInformation({}, {})).map((m) => m.id),
            ['padrao']
        );
    });

    it('lista declarada vazia mantém a lista fixa', async () => {
        // Campo em branco no painel significa "use os padrão", não "nenhum".
        const provider = openRouter({ discoverModels: async () => [] });

        assert.deepStrictEqual(
            (await provider.provideLanguageModelChatInformation({}, {})).map((m) => m.id),
            ['padrao']
        );
    });
});
