'use strict';

/**
 * Testes do modelo de conexões nomeadas.
 *
 * O desenho anterior guardava UMA conexão, de UM backend (ArcadeDB sobre TCP),
 * alcançada por um `mcp.json` escrito à mão. O ecossistema real usa quatro
 * combinações — Neo4j local e AuraDB, ArcadeDB embedded, TCP local e remoto — e
 * a extensão não tinha onde guardar as outras três.
 *
 * As invariantes que este arquivo protege são as que, quebradas, vazam segredo
 * ou fazem o pesquisador perder trabalho:
 *
 * 1. **Segredo nunca é persistido em claro.** `globalState` é armazenamento
 *    comum; só `secrets` é o cofre. Um `password` que escorregue para o objeto
 *    do perfil seria gravado legível — a mesma classe de vazamento que este
 *    ecossistema já pagou duas vezes (chave da Anthropic em `settings.json`,
 *    senha do Neo4j no histórico do git).
 * 2. **Renomear não invalida a senha.** O id é estável e independente do nome.
 * 3. **Trocar de backend não deixa campo órfão** de um tipo dentro de outro.
 */

require('../helpers/vscodeMock').install();

const assert = require('assert');
const {
    BACKEND_ARCADEDB,
    BACKEND_ARCADEDB_EMBEDDED,
    BACKEND_NEO4J,
    listBackends,
    backendSpec,
    secretKey,
    listProfiles,
    getProfile,
    saveProfile,
    sanitizeProfile,
    deleteProfile,
    getActiveProfileId,
    setActiveProfile,
    readActiveConnection,
    describeProfileGap,
    validateProfile
} = require('../../src/chat/connectionProfiles');

function fakeContext() {
    const secrets = new Map();
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
            get: async (k) => secrets.get(k),
            store: async (k, v) => secrets.set(k, v),
            delete: async (k) => secrets.delete(k)
        },
        globalState: memento(global),
        workspaceState: memento(workspace),
        _secrets: secrets,
        _global: global
    };
}

describe('Backends suportados', () => {
    it('cobre as combinações que o ecossistema usa', () => {
        const ids = listBackends().map((b) => b.id);
        assert.ok(ids.includes(BACKEND_ARCADEDB), 'ArcadeDB servidor (local ou remoto)');
        assert.ok(ids.includes(BACKEND_ARCADEDB_EMBEDDED), 'ArcadeDB embutido');
        assert.ok(ids.includes(BACKEND_NEO4J), 'Neo4j local e AuraDB');
    });

    it('o Neo4j aceita bolt:// e a URI da AuraDB', () => {
        const uri = backendSpec(BACKEND_NEO4J).fields.find((f) => f.name === 'uri');
        assert.strictEqual(uri.validate('bolt://127.0.0.1:7687'), null);
        assert.strictEqual(uri.validate('neo4j+s://abc123.databases.neo4j.io'), null);
        assert.ok(uri.validate('http://localhost:7474'), 'HTTP não é endpoint Bolt');
    });

    it('o ArcadeDB recusa bolt:// com mensagem que explica', () => {
        // Erro previsível de quem vem do Neo4j: o ArcadeDB fala HTTP na 2480.
        const uri = backendSpec(BACKEND_ARCADEDB).fields.find((f) => f.name === 'uri');
        const message = uri.validate('bolt://localhost:2480');
        assert.ok(message && /http/i.test(message));
    });

    it('o modo embutido pede pasta, não credencial', () => {
        const fields = backendSpec(BACKEND_ARCADEDB_EMBEDDED).fields.map((f) => f.name);
        assert.ok(fields.includes('dbPath'));
        assert.ok(!fields.includes('password'), 'não há a quem autenticar num banco em processo');
    });
});

describe('Segredo fora do armazenamento comum', () => {
    it('sanitizeProfile descarta qualquer senha que chegue no objeto', () => {
        // A defesa que importa: mesmo que quem chame erre, o objeto persistido
        // não carrega segredo.
        const clean = sanitizeProfile({
            id: 'p1',
            name: 'local',
            backend: BACKEND_ARCADEDB,
            uri: 'http://localhost:2480',
            user: 'root',
            password: 'NAO-DEVE-PERSISTIR'
        });
        assert.strictEqual(clean.password, undefined);
        assert.ok(!JSON.stringify(clean).includes('NAO-DEVE-PERSISTIR'));
    });

    it('salvar grava a senha só no cofre', async () => {
        const ctx = fakeContext();
        await saveProfile(
            ctx,
            { name: 'face85', backend: BACKEND_ARCADEDB, uri: 'http://localhost:2480', user: 'leitor' },
            's3nh4'
        );
        const persisted = JSON.stringify([...ctx._global.values()]);
        assert.ok(!persisted.includes('s3nh4'), 'a senha apareceu no armazenamento comum');

        const profile = listProfiles(ctx)[0];
        assert.strictEqual(ctx._secrets.get(secretKey(profile.id)), 's3nh4');
    });

    it('trocar de backend não deixa campos órfãos do tipo anterior', () => {
        const clean = sanitizeProfile({
            id: 'p1',
            name: 'migrado',
            backend: BACKEND_ARCADEDB_EMBEDDED,
            dbPath: 'D:/ArcadeDB',
            // Sobras do formulário de ArcadeDB servidor.
            uri: 'http://localhost:2480',
            user: 'root'
        });
        assert.strictEqual(clean.dbPath, 'D:/ArcadeDB');
        assert.strictEqual(clean.uri, undefined);
        assert.strictEqual(clean.user, undefined);
    });
});

describe('Ciclo de vida dos perfis', () => {
    it('renomear preserva a senha — o id não deriva do nome', async () => {
        const ctx = fakeContext();
        const saved = await saveProfile(
            ctx,
            { name: 'antigo', backend: BACKEND_ARCADEDB, uri: 'http://h:2480', user: 'u' },
            's3nh4'
        );
        await saveProfile(ctx, { ...saved, name: 'novo nome' }, undefined);

        assert.strictEqual(listProfiles(ctx).length, 1, 'renomear criou um perfil duplicado');
        assert.strictEqual(getProfile(ctx, saved.id).name, 'novo nome');
        assert.strictEqual(ctx._secrets.get(secretKey(saved.id)), 's3nh4');
    });

    it('salvar sem senha preserva a guardada', async () => {
        // É o que permite ao painel mostrar "configurada" sem devolver o valor.
        const ctx = fakeContext();
        const saved = await saveProfile(
            ctx,
            { name: 'x', backend: BACKEND_ARCADEDB, uri: 'http://h:2480', user: 'u' },
            's3nh4'
        );
        await saveProfile(ctx, { ...saved, user: 'outro' }, undefined);
        assert.strictEqual(ctx._secrets.get(secretKey(saved.id)), 's3nh4');
    });

    it('dois perfis podem ter o mesmo nome sem colidir', async () => {
        // "local" apontando para bancos diferentes é legítimo.
        const ctx = fakeContext();
        const a = await saveProfile(ctx, { name: 'local', backend: BACKEND_ARCADEDB, uri: 'http://a:2480', user: 'u' }, 'a');
        const b = await saveProfile(ctx, { name: 'local', backend: BACKEND_NEO4J, uri: 'bolt://b:7687', user: 'u' }, 'b');
        assert.notStrictEqual(a.id, b.id);
        assert.strictEqual(ctx._secrets.get(secretKey(a.id)), 'a');
        assert.strictEqual(ctx._secrets.get(secretKey(b.id)), 'b');
    });

    it('apagar um perfil leva a senha junto', async () => {
        const ctx = fakeContext();
        const saved = await saveProfile(ctx, { name: 'x', backend: BACKEND_ARCADEDB, uri: 'http://h:2480', user: 'u' }, 's3nh4');
        await deleteProfile(ctx, saved.id);
        assert.strictEqual(listProfiles(ctx).length, 0);
        assert.strictEqual(ctx._secrets.get(secretKey(saved.id)), undefined, 'a senha ficou órfã no cofre');
    });

    it('apagar o perfil ativo não deixa o workspace apontando para o vazio', async () => {
        const ctx = fakeContext();
        const a = await saveProfile(ctx, { name: 'a', backend: BACKEND_ARCADEDB, uri: 'http://a:2480', user: 'u' }, 'x');
        const b = await saveProfile(ctx, { name: 'b', backend: BACKEND_ARCADEDB, uri: 'http://b:2480', user: 'u' }, 'y');
        await setActiveProfile(ctx, a.id);
        await deleteProfile(ctx, a.id);
        assert.strictEqual(getActiveProfileId(ctx), b.id);
    });
});

describe('Conexão ativa e o que falta nela', () => {
    it('sem senha, a conexão ativa não é utilizável', async () => {
        const ctx = fakeContext();
        const saved = await saveProfile(ctx, { name: 'x', backend: BACKEND_ARCADEDB, uri: 'http://h:2480', user: 'u' }, undefined);
        await setActiveProfile(ctx, saved.id);
        assert.strictEqual(await readActiveConnection(ctx), undefined);
    });

    it('o modo embutido é utilizável sem senha alguma', async () => {
        const ctx = fakeContext();
        const saved = await saveProfile(ctx, { name: 'emb', backend: BACKEND_ARCADEDB_EMBEDDED, dbPath: 'D:/ArcadeDB' }, undefined);
        await setActiveProfile(ctx, saved.id);
        const conn = await readActiveConnection(ctx);
        assert.ok(conn, 'exigir senha aqui bloquearia o backend embutido');
        assert.strictEqual(conn.dbPath, 'D:/ArcadeDB');
    });

    it('nomeia a lacuna em vez de dizer "não configurado"', () => {
        const profile = { name: 'face85', backend: BACKEND_ARCADEDB, uri: 'http://h:2480', user: 'u' };
        const gap = describeProfileGap(profile, false);
        assert.ok(gap.includes('senha'));
        assert.ok(gap.includes('face85'), 'a mensagem precisa dizer QUAL conexão');
    });

    it('perfil completo não tem lacuna', () => {
        const profile = { name: 'x', backend: BACKEND_ARCADEDB, uri: 'http://h:2480', user: 'u' };
        assert.strictEqual(describeProfileGap(profile, true), undefined);
    });
});

describe('Migração da configuração anterior', () => {
    const { migrateLegacyConnection } = require('../../src/chat/connectionProfiles');
    const LEGACY = { uri: 'http://host:2480', user: 'leitor', password: 's3nh4' };

    it('importa a conexão antiga como perfil ativo', async () => {
        // Quem já tinha o chat funcionando não pode perdê-lo ao atualizar — e
        // não pode ser instruído a "configurar a conexão" que já configurou.
        const ctx = fakeContext();
        const profile = await migrateLegacyConnection(ctx, LEGACY);

        assert.ok(profile);
        assert.strictEqual(getActiveProfileId(ctx), profile.id);
        assert.strictEqual(profile.uri, 'http://host:2480');
        assert.strictEqual(ctx._secrets.get(secretKey(profile.id)), 's3nh4');
    });

    it('não roda de novo quando já existem perfis', async () => {
        // Uma segunda importação só poderia criar duplicata: depois da primeira,
        // os perfis são a única fonte de verdade.
        const ctx = fakeContext();
        await migrateLegacyConnection(ctx, LEGACY);
        await migrateLegacyConnection(ctx, LEGACY);
        assert.strictEqual(listProfiles(ctx).length, 1);
    });

    it('sem configuração anterior, não inventa perfil', async () => {
        const ctx = fakeContext();
        assert.strictEqual(await migrateLegacyConnection(ctx, undefined), undefined);
        assert.strictEqual(listProfiles(ctx).length, 0);
    });

    it('o perfil importado é utilizável de imediato', async () => {
        // Importar e ainda assim exigir um passo do pesquisador seria a mesma
        // meia-configuração que este trabalho existe para eliminar.
        const ctx = fakeContext();
        await migrateLegacyConnection(ctx, LEGACY);
        const conn = await readActiveConnection(ctx);
        assert.ok(conn);
        assert.strictEqual(conn.password, 's3nh4');
        assert.strictEqual(describeProfileGap(conn, true), undefined);
    });
});

describe('Validação do formulário', () => {
    it('exige nome', () => {
        const errors = validateProfile({ backend: BACKEND_ARCADEDB, uri: 'http://h:2480', user: 'u' }, { password: 'p' });
        assert.ok(errors.name);
    });

    it('aceita senha vazia quando já existe uma guardada', () => {
        const errors = validateProfile(
            { name: 'x', backend: BACKEND_ARCADEDB, uri: 'http://h:2480', user: 'u' },
            { password: '', hasStoredPassword: true }
        );
        assert.deepStrictEqual(errors, {});
    });

    it('exige senha quando não há nenhuma guardada', () => {
        const errors = validateProfile(
            { name: 'x', backend: BACKEND_ARCADEDB, uri: 'http://h:2480', user: 'u' },
            { password: '', hasStoredPassword: false }
        );
        assert.ok(errors.password);
    });

    it('o banco é opcional — escolhido depois de testar', () => {
        const errors = validateProfile(
            { name: 'x', backend: BACKEND_ARCADEDB, uri: 'http://h:2480', user: 'u' },
            { password: 'p' }
        );
        assert.strictEqual(errors.database, undefined);
    });
});
