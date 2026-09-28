'use strict';

/**
 * Testes do diagnóstico de conexão.
 *
 * O defeito que originou este arquivo é de DIAGNÓSTICO, não de configuração: o
 * chat perguntava "há ferramenta MCP viva?" e, quando não havia, oferecia
 * *configurar a conexão* — a mesma frase para causas diferentes. Quem acabara
 * de configurar recebia o pedido de novo, o que lia como "não salvou" quando o
 * problema era outro.
 *
 * A regra que estes testes fixam: **cada estado diz algo diferente, e nenhum
 * pede o que já foi feito.** Vários estados podem levar à mesma página; o que
 * não pode repetir-se é o texto, porque é ele que orienta o pesquisador.
 *
 * Os testes do fluxo de salvamento em `InputBox` saíram junto com o fluxo: a
 * configuração agora vive no painel, e os testes que a cobrem são os de
 * `connectionProfiles.test.js`.
 */

require('../helpers/vscodeMock').install();

const assert = require('assert');
const vscode = require('vscode');
const { describeNextStep, readConnectionStatus } = require('../../src/chat/connectionStatus');
const { PASSWORD_SECRET_KEY } = require('../../src/chat/connectionSettings');

function fakeContext(initial = {}) {
    const store = new Map(Object.entries(initial));
    const global = new Map();
    const workspace = new Map();
    const memento = (map) => ({
        get: (k, fallback) => (map.has(k) ? map.get(k) : fallback),
        update: async (k, v) => {
            if (v === undefined) {
                map.delete(k);
            } else {
                map.set(k, v);
            }
        }
    });
    return {
        secrets: {
            get: async (k) => store.get(k),
            store: async (k, v) => store.set(k, v),
            delete: async (k) => store.delete(k)
        },
        globalState: memento(global),
        workspaceState: memento(workspace),
        _store: store,
        _global: global,
        _workspace: workspace
    };
}

/** Instala settings e workspace, devolvendo o restaurador. */
function withEnvironment({ settings = {}, folders = null } = {}) {
    const originalConfig = vscode.workspace.getConfiguration;
    const originalFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.getConfiguration = () => ({
        get: (key) => settings[key],
        update: async (key, value) => {
            settings[key] = value;
        }
    });
    vscode.workspace.workspaceFolders = folders;
    return () => {
        vscode.workspace.getConfiguration = originalConfig;
        vscode.workspace.workspaceFolders = originalFolders;
    };
}

const FOLDER = [{ name: 'projeto', uri: { fsPath: '/w/projeto', scheme: 'file' } }];

describe('Diagnóstico: qual é o passo seguinte', () => {
    it('com ferramentas vivas, não há nada a pedir', () => {
        assert.strictEqual(describeNextStep({ hasTools: true, hasCredentials: false }), undefined);
    });

    it('sem credencial, leva à página de configuração', () => {
        const next = describeNextStep({ hasTools: false, hasCredentials: false, hasWorkspace: true });
        assert.strictEqual(next.command, 'synesis.openSettings');
    });

    it('perfil ativo incompleto nomeia o que falta, sem mandar refazer tudo', () => {
        const next = describeNextStep({
            hasTools: false,
            hasCredentials: false,
            hasWorkspace: true,
            gap: 'Falta a senha da conexão "face85 local".'
        });
        assert.ok(next.message.includes('Falta a senha'));
        assert.ok(next.message.includes('face85 local'));
    });

    it('perfis cadastrados mas nenhum ativo é um estado próprio', () => {
        const next = describeNextStep({
            hasTools: false,
            hasCredentials: false,
            hasWorkspace: true,
            hasProfiles: true
        });
        assert.ok(/nenhuma está marcada como ativa/i.test(next.message));
    });

    it('credencial salva e nada respondendo: NÃO pede configurar de novo', () => {
        // A asserção central do arquivo. Este é exatamente o estado do
        // pesquisador que configurou tudo e continuava vendo "configure a
        // conexão": o passo oferecido tem de ser outro.
        const next = describeNextStep({
            hasTools: false,
            hasCredentials: true,
            hasWorkspace: true,
            uri: 'http://host:2480',
            user: 'leitor'
        });
        assert.notStrictEqual(next.command, 'synesis.chat.configureConnection');
        // O botão leva ao teste de conexão, que informa a causa real, em vez de
        // reabrir o formulário que o pesquisador já preencheu corretamente.
        assert.strictEqual(next.title, 'Testar conexão');
    });

    it('nomeia a causa provável em vez de repetir o pedido genérico', () => {
        const next = describeNextStep({
            hasTools: false,
            hasCredentials: true,
            hasWorkspace: true,
            uri: 'http://host:2480',
            user: 'leitor'
        });
        // Precisa dizer que o problema NÃO é a configuração, e mostrar o
        // endereço concreto para o pesquisador poder conferir o servidor.
        assert.ok(/não é a configuração/i.test(next.message));
        assert.ok(next.message.includes('http://host:2480'));
    });

    it('sem pasta aberta, o passo é abrir a pasta — não reconfigurar', () => {
        const next = describeNextStep({
            hasTools: false,
            hasCredentials: true,
            hasWorkspace: false,
            uri: 'http://host:2480'
        });
        assert.ok(/pasta/i.test(next.message));
        assert.notStrictEqual(next.command, 'synesis.chat.configureConnection');
    });

    it('cada estado sem ferramenta diz algo diferente', () => {
        // O defeito original era uma mensagem só para causas distintas. Vários
        // estados podem legitimamente levar à mesma página — o que não pode
        // repetir-se é o TEXTO, porque é ele que diz ao pesquisador o que fazer.
        const messages = [
            describeNextStep({ hasTools: false, hasCredentials: false, hasWorkspace: true }),
            describeNextStep({ hasTools: false, hasCredentials: false, hasWorkspace: true, hasProfiles: true }),
            describeNextStep({ hasTools: false, hasCredentials: false, hasWorkspace: true, gap: 'Falta a senha.' }),
            describeNextStep({ hasTools: false, hasCredentials: true, hasWorkspace: false, uri: 'u' }),
            describeNextStep({ hasTools: false, hasCredentials: true, hasWorkspace: true, uri: 'u', user: 'r' })
        ].map((n) => n.message);
        assert.strictEqual(new Set(messages).size, messages.length);
    });
});

describe('Leitura do estado a partir do que está salvo', () => {
    it('sem senha no cofre, o estado é "sem credencial"', async () => {
        const restore = withEnvironment({ settings: { uri: 'http://x:2480' }, folders: FOLDER });
        try {
            const status = await readConnectionStatus(fakeContext(), false);
            assert.strictEqual(status.hasCredentials, false);
            assert.strictEqual(status.hasWorkspace, true);
        } finally {
            restore();
        }
    });

    it('com senha no cofre, o estado é "credencial salva"', async () => {
        const restore = withEnvironment({
            settings: { uri: 'http://x:2480', user: 'leitor' },
            folders: FOLDER
        });
        try {
            const ctx = fakeContext({ [PASSWORD_SECRET_KEY]: 's3nh4' });
            const status = await readConnectionStatus(ctx, false);
            assert.strictEqual(status.hasCredentials, true);
            assert.strictEqual(status.uri, 'http://x:2480');
        } finally {
            restore();
        }
    });
});
