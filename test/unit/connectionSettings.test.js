'use strict';

/**
 * Testes da LEITURA da conexão da versão anterior.
 *
 * Este módulo já foi o dono da configuração; hoje sobra a leitura, e ela existe
 * para um fim só: quem já tinha o chat funcionando não pode perdê-lo ao
 * atualizar. `migrateLegacyConnection` importa o que estes testes garantem que
 * ainda é legível. A configuração em si vive em `connectionProfiles.js`.
 *
 * A regra que continua valendo: **a senha nunca vai para setting nem para
 * arquivo do workspace** — só para `context.secrets`. Não é precaução teórica.
 * Dois vazamentos reais já ocorreram neste ecossistema: a chave da Anthropic
 * saiu de um `settings.json` em texto puro para o contexto de outra ferramenta
 * do editor, e a senha do Neo4j ficou no histórico do git do `synesis-graph`
 * (commit `a7d8b9c`), onde segue recuperável apesar do `.gitignore` atual.
 *
 * O chat também não lê o `config.toml` do projeto: aquele arquivo alimenta o
 * `synesis-graph`, que escreve no banco. Consultar o grafo é outro papel, e
 * pode acontecer numa máquina que não tem o projeto — um pesquisador com
 * credenciais recebidas de um supervisor.
 */

require('../helpers/vscodeMock').install();

const assert = require('assert');
const vscode = require('vscode');
const {
    readConnection,
    readConnectionSettings,
    mcpEndpoint,
    basicAuthHeader,
    PASSWORD_SECRET_KEY,
    DEFAULT_URI,
    DEFAULT_USER
} = require('../../src/chat/connectionSettings');

/** `context` falso com o cofre de segredos. */
function fakeContext(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
        secrets: {
            get: async (k) => store.get(k),
            store: async (k, v) => store.set(k, v),
            delete: async (k) => store.delete(k)
        },
        _store: store
    };
}

/** Substitui as settings lidas, devolvendo o restaurador. */
function withSettings(values) {
    const original = vscode.workspace.getConfiguration;
    vscode.workspace.getConfiguration = () => ({
        get: (key) => values[key],
        update: async (key, value) => {
            values[key] = value;
        }
    });
    return () => {
        vscode.workspace.getConfiguration = original;
    };
}

describe('Conexão do banco — configurada no VSCode', () => {
    it('usa defaults de servidor local quando nada foi configurado', () => {
        const restore = withSettings({});
        try {
            const s = readConnectionSettings();
            assert.strictEqual(s.uri, DEFAULT_URI);
            assert.strictEqual(s.user, DEFAULT_USER);
        } finally {
            restore();
        }
    });

    it('sem senha, a conexão é considerada não configurada', async () => {
        const restore = withSettings({ uri: 'http://x:2480', user: 'leitor' });
        try {
            assert.strictEqual(await readConnection(fakeContext()), undefined);
        } finally {
            restore();
        }
    });

    it('com senha, devolve a conexão completa', async () => {
        const restore = withSettings({ uri: 'http://x:2480', user: 'leitor' });
        try {
            const ctx = fakeContext({ [PASSWORD_SECRET_KEY]: 's3nh4' });
            const conn = await readConnection(ctx);
            assert.deepStrictEqual(conn, { uri: 'http://x:2480', user: 'leitor', password: 's3nh4' });
        } finally {
            restore();
        }
    });

    it('a senha vive no cofre, não nas settings', async () => {
        const values = { uri: 'http://x:2480', user: 'leitor' };
        const restore = withSettings(values);
        try {
            const ctx = fakeContext({ [PASSWORD_SECRET_KEY]: 's3nh4' });
            await readConnection(ctx);
            // A asserção que importa: nenhuma setting guarda a senha.
            assert.ok(!Object.values(values).includes('s3nh4'));
            assert.strictEqual(ctx._store.get(PASSWORD_SECRET_KEY), 's3nh4');
        } finally {
            restore();
        }
    });

    it('monta o endpoint MCP a partir da URI base', () => {
        assert.strictEqual(mcpEndpoint('http://host:2480'), 'http://host:2480/api/v1/mcp');
    });

    it('tolera barra final na URI', () => {
        // Digitar "http://host:2480/" é comum e não deve gerar "//api".
        assert.strictEqual(mcpEndpoint('http://host:2480/'), 'http://host:2480/api/v1/mcp');
    });

    it('gera Basic Auth que decodifica de volta ao par informado', () => {
        const header = basicAuthHeader('leitor', 's3nh4');
        assert.ok(header.startsWith('Basic '));
        assert.strictEqual(Buffer.from(header.slice(6), 'base64').toString('utf8'), 'leitor:s3nh4');
    });

    it('codifica senha não-ASCII sem corromper', () => {
        const header = basicAuthHeader('usuário', 'senhaçã');
        assert.strictEqual(Buffer.from(header.slice(6), 'base64').toString('utf8'), 'usuário:senhaçã');
    });
});

describe('Settings do chat — o que é configurável na aba', () => {
    const { readMaxToolRounds } = require('../../src/chat/chatParticipant');

    function withChatSettings(values) {
        const original = vscode.workspace.getConfiguration;
        vscode.workspace.getConfiguration = () => ({ get: (k) => values[k] });
        return () => {
            vscode.workspace.getConfiguration = original;
        };
    }

    it('usa 16 rodadas quando nada foi configurado', () => {
        const restore = withChatSettings({});
        try {
            assert.strictEqual(readMaxToolRounds(), 16);
        } finally {
            restore();
        }
    });

    it('respeita o valor configurado', () => {
        const restore = withChatSettings({ maxToolRounds: 24 });
        try {
            assert.strictEqual(readMaxToolRounds(), 24);
        } finally {
            restore();
        }
    });

    it('limita valores fora da faixa em vez de aceitá-los', () => {
        // O `package.json` declara 4–40, mas um settings.json editado à mão não
        // passa por validação: um `0` desligaria o loop em silêncio.
        let restore = withChatSettings({ maxToolRounds: 0 });
        try {
            assert.strictEqual(readMaxToolRounds(), 4);
        } finally {
            restore();
        }
        restore = withChatSettings({ maxToolRounds: 999 });
        try {
            assert.strictEqual(readMaxToolRounds(), 40);
        } finally {
            restore();
        }
    });

    it('cai no padrão quando o valor não é numérico', () => {
        const restore = withChatSettings({ maxToolRounds: 'muitas' });
        try {
            assert.strictEqual(readMaxToolRounds(), 16);
        } finally {
            restore();
        }
    });
});
