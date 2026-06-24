'use strict';

/**
 * lspMock.js — Fake LspClient para testes de DataService sem Python server.
 *
 * Uso:
 *   const mock = new LspMock();
 *   mock.set('synesis/getCodes', { success: true, codes: [...] });
 *   mock.failWith('synesis/getTemplate', -32601, 'Method Not Found');
 *
 *   const ds = new DataService({ lspClient: mock });
 *   const codes = await ds.getCodes();
 */

class LspMock {
    constructor() {
        this._responses = new Map();  // method → { payload, error }
        this._calls = [];             // log de todas as chamadas
        this._ready = true;
    }

    // --- Control API ---

    /** Registra uma resposta bem-sucedida para um método LSP. */
    set(method, payload) {
        this._responses.set(method, { payload, error: null });
        return this;
    }

    /** Registra um erro para um método LSP (simula rejeição do sendRequest). */
    failWith(method, code, message) {
        const err = new Error(message);
        err.code = code;
        this._responses.set(method, { payload: null, error: err });
        return this;
    }

    /** Simula Method Not Found (código -32601) para um método. */
    methodNotFound(method) {
        return this.failWith(method, -32601, 'Method Not Found');
    }

    /** Controla o retorno de isReady(). */
    setReady(value) {
        this._ready = value;
        return this;
    }

    /** Retorna o log de chamadas (array de { method, params }). */
    calls() {
        return [...this._calls];
    }

    /** Retorna quantas vezes um método foi chamado. */
    callCount(method) {
        return this._calls.filter(c => c.method === method).length;
    }

    /** Limpa log e respostas. */
    reset() {
        this._responses.clear();
        this._calls = [];
        this._ready = true;
        return this;
    }

    // --- LspClient interface (duck-typing com LanguageClient do vscode-languageclient) ---

    isReady() {
        return this._ready;
    }

    async sendRequest(method, params) {
        this._calls.push({ method, params });

        const entry = this._responses.get(method);
        if (!entry) {
            // Resposta padrão: método não configurado → retorna null (sem erro)
            return null;
        }

        if (entry.error) {
            return Promise.reject(entry.error);
        }

        return entry.payload;
    }
}

module.exports = { LspMock };
