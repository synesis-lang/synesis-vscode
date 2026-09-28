/**
 * Qual modelo respondeu este turno.
 *
 * **O defeito observado.** O pesquisador trocou de modelo no meio da sessão
 * (LiquidAI LFM2.5-2.6B → Nemotron Nano 9B) e o relatório do turno seguinte —
 * aberto pelo botão abaixo da resposta do Nemotron — continuou nomeando o
 * LiquidAI.
 *
 * A causa está no contrato da API: `ChatRequest.model` é *"the model that is
 * currently selected in the UI"*, e a documentação adverte **"don't hold onto
 * this past the lifetime of the request"** (`vscode.d.ts`, `ChatRequest.model`).
 * O trace era montado no início do turno, antes das leituras de prefetch, e
 * guardava o que estava selecionado naquele instante.
 *
 * Numa campanha que mede "qual o menor modelo que dá conta", atribuir o turno ao
 * modelo errado é o pior defeito possível: as consultas, as rodadas e o
 * resultado vão todos para a conta de quem não os produziu.
 */

require('../helpers/vscodeMock').install();

const assert = require('assert');
const { createTurnTrace, captureModel, flattenModel } = require('../../src/chat/turnTrace');
const { renderTurnReport } = require('../../src/chat/auditTrail');

const LFM = {
    id: 'liquid/lfm-2.5-2.6b:free',
    name: 'LiquidAI: LFM2.5-2.6B (free)',
    vendor: 'synesis-openrouter',
    family: 'openrouter',
    version: '1.0.0'
};

const NEMOTRON = {
    id: 'nvidia/nemotron-nano-9b-v2:free',
    name: 'Nemotron Nano 9B',
    vendor: 'synesis-openrouter',
    family: 'openrouter',
    version: '1.0.0'
};

function traceCom(modelo) {
    return createTurnTrace({ turnId: 't1', question: 'ficha', database: 'db', model: modelo });
}

describe('Modelo do turno — troca no meio da sessão', () => {
    it('a reconfirmação sobrescreve o modelo lido no início do turno', () => {
        // O cenário exato: `request.model` ficou no LFM, mas quem responde é o
        // Nemotron.
        const trace = traceCom(LFM);

        captureModel(trace, NEMOTRON);

        assert.strictEqual(trace.model.id, NEMOTRON.id);
        assert.strictEqual(trace.model.name, NEMOTRON.name);
    });

    it('um objeto sem `id` não apaga o que já estava registrado', () => {
        // Melhor manter a identidade conhecida do que trocá-la por uma parcial.
        const trace = traceCom(NEMOTRON);

        captureModel(trace, { name: 'parcial' });
        captureModel(trace, undefined);

        assert.strictEqual(trace.model.id, NEMOTRON.id);
    });

    it('não quebra sem trace', () => {
        assert.doesNotThrow(() => captureModel(undefined, NEMOTRON));
    });

    it('guarda apenas strings — o objeto do modelo não sobrevive ao turno', () => {
        // A API adverte para não segurar o `LanguageModelChat`; o trace fica com
        // cinco campos achatados.
        const flat = flattenModel(NEMOTRON);

        assert.deepStrictEqual(Object.keys(flat).sort(), [
            'family',
            'id',
            'name',
            'vendor',
            'version'
        ]);
        for (const valor of Object.values(flat)) {
            assert.strictEqual(typeof valor, 'string');
        }
    });
});

describe('Relatório do turno — identificação do modelo', () => {
    it('nomeia o modelo que efetivamente respondeu', () => {
        const trace = traceCom(LFM);
        captureModel(trace, NEMOTRON);

        const relatorio = renderTurnReport(trace);

        assert.match(relatorio, /Nemotron Nano 9B/);
        assert.ok(!/LFM2\.5/.test(relatorio), 'o modelo anterior não deve aparecer');
    });

    it('mostra o id, que identifica sem ambiguidade', () => {
        // O nome de exibição vem do catálogo e pode repetir entre provedores; o
        // id é o que serve para comparar turnos numa campanha.
        const relatorio = renderTurnReport(traceCom(NEMOTRON));

        assert.match(relatorio, /nvidia\/nemotron-nano-9b-v2:free/);
    });

    it('não publica a `version`, que é constante do nosso código', () => {
        // Os três providers declaram `'1.0.0'` fixo para todo modelo. Publicar
        // isso como "versão" dava ares de dado a uma constante nossa.
        const relatorio = renderTurnReport(traceCom(NEMOTRON));

        assert.ok(!/vers[ãa]o 1\.0\.0/.test(relatorio));
    });

    it('não repete o id quando ele é o próprio nome', () => {
        const semNome = { id: 'modelo-x', vendor: 'v' };
        const relatorio = renderTurnReport(
            createTurnTrace({ turnId: 't', question: 'q', database: 'db', model: semNome })
        );

        assert.strictEqual((relatorio.match(/modelo-x/g) || []).length, 1);
    });
});
