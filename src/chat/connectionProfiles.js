/**
 * connectionProfiles.js - Conexões nomeadas, uma ativa por projeto.
 *
 * Substitui o par `synesisExplorer.chat.arcadedb.{uri,user}` + uma senha no
 * cofre, que modelava **um** caso: ArcadeDB, sobre TCP, alcançado por um
 * servidor MCP declarado à mão em `.vscode/mcp.json`. O ecossistema real usa
 * quatro combinações — Neo4j local e AuraDB, ArcadeDB embedded, TCP local e
 * remoto — e o desenho antigo não tinha onde guardar as outras três.
 *
 * Três decisões que este módulo fixa:
 *
 * 1. **O backend é um campo, não uma suposição.** O chat identificava as
 *    ferramentas do banco procurando a string `'arcade'` no nome do servidor
 *    MCP. Isso é uma heurística sobre um rótulo que o usuário escolhe, e ela
 *    exclui o Neo4j por construção. Aqui o tipo é declarado.
 *
 * 2. **Perfis nomeados, e o ativo é por workspace.** Um pesquisador alterna
 *    entre o corpus local e o remoto no mesmo dia; guardar uma credencial só
 *    significaria redigitá-la a cada troca. `workspaceState` para o ativo, pelo
 *    mesmo motivo de `databaseSelection`: projetos diferentes olham bancos
 *    diferentes, e herdar a escolha de outro projeto é pior que não ter escolha.
 *
 * 3. **Segredo nunca sai do cofre, e nunca entra num arquivo.** Os campos não
 *    secretos vão para `globalState`; a senha vai para `context.secrets`, cuja
 *    chave deriva do id do perfil. A extensão **não escreve mais `mcp.json`** —
 *    escrever era o que duplicava a credencial em Basic64 dentro do workspace e,
 *    pior, criava um servidor `arcadedb` ao lado de um `arcadedb-face85` já
 *    existente, em vez de atualizá-lo.
 *
 * O vocabulário acompanha de propósito o `synesis_graph/config.py`
 * (`BACKEND_NEO4J`, `BACKEND_ARCADEDB`, `BACKEND_ARCADEDB_EMBEDDED`): é o mesmo
 * conceito nos dois lados, e nomes divergentes fariam o pesquisador traduzir
 * mentalmente entre a extensão e o pipeline que gerou o grafo.
 */

const PROFILES_KEY = 'synesis.chat.connectionProfiles';
const ACTIVE_PROFILE_KEY = 'synesis.chat.activeConnectionProfile';

/** Prefixo da chave de segredo. O sufixo é o id do perfil. */
const SECRET_PREFIX = 'synesis.connection.';

const BACKEND_ARCADEDB = 'arcadedb';
const BACKEND_ARCADEDB_EMBEDDED = 'arcadedb-embedded';
const BACKEND_NEO4J = 'neo4j';

/**
 * O que cada backend pede, declarado uma vez.
 *
 * O painel desenha os campos a partir daqui, e a validação lê daqui — assim um
 * backend novo não exige tocar em três lugares, e nenhum campo pode aparecer no
 * formulário sem alguém validá-lo.
 *
 * `secret: true` marca o que vai para o cofre. É o único bit que separa o que
 * pode ser persistido em claro do que não pode, então ele fica no modelo, não
 * espalhado por quem grava.
 */
const BACKENDS = {
    [BACKEND_ARCADEDB]: {
        id: BACKEND_ARCADEDB,
        label: 'ArcadeDB (servidor)',
        hint: 'Servidor ArcadeDB local ou remoto, alcançado por HTTP.',
        // O chat conversa pelo MCP que o próprio ArcadeDB serve — não é preciso
        // declarar servidor nenhum em `mcp.json`.
        transport: 'http',
        fields: [
            {
                name: 'uri',
                label: 'Endereço do servidor',
                placeholder: 'http://localhost:2480',
                default: 'http://localhost:2480',
                // A porta 2480 serve o Studio e a API HTTP. Um `bolt://` aqui é
                // erro comum de quem vem do Neo4j, e falharia mais tarde e com
                // mensagem pior.
                validate: (v) =>
                    /^https?:\/\/.+/.test(v || '')
                        ? null
                        : 'Informe uma URL http(s) — o ArcadeDB usa HTTP, não bolt://.'
            },
            {
                name: 'user',
                label: 'Usuário',
                placeholder: 'root',
                default: 'root',
                hint: 'Prefira um usuário só de leitura: o chat não escreve no grafo.',
                validate: (v) => (v && v.trim() ? null : 'Informe o usuário.')
            },
            {
                name: 'password',
                label: 'Senha',
                secret: true,
                validate: (v) => (v ? null : 'Informe a senha.')
            },
            {
                name: 'database',
                label: 'Banco',
                hint: 'Deixe em branco para escolher na lista depois de testar a conexão.',
                optional: true
            }
        ]
    },
    [BACKEND_ARCADEDB_EMBEDDED]: {
        id: BACKEND_ARCADEDB_EMBEDDED,
        label: 'ArcadeDB (embutido, sem servidor)',
        hint: 'O banco é uma pasta no disco. Não exige servidor no ar nem Java instalado.',
        transport: 'embedded',
        fields: [
            {
                name: 'dbPath',
                label: 'Pasta raiz do servidor',
                placeholder: 'D:\\ArcadeDB',
                // ⚠️ Raiz do servidor, não a pasta do banco: o ArcadeDB procura
                // os bancos em `<raiz>/databases/<nome>`. Apontar direto para a
                // pasta do banco produz a pior falha possível — tudo inicia,
                // nada erra, e o corpus simplesmente não aparece. A regra é a
                // mesma de `ArcadeDBEmbeddedConfig.database_dir` no
                // synesis-graph; os dois lados têm de concordar.
                hint: 'A pasta que CONTÉM `databases/` — não a pasta do banco em si.',
                validate: (v) => (v && v.trim() ? null : 'Informe a pasta raiz.')
            },
            {
                name: 'database',
                label: 'Banco',
                hint: 'Nome da pasta sob `databases/`.',
                optional: true
            }
        ]
    },
    [BACKEND_NEO4J]: {
        id: BACKEND_NEO4J,
        label: 'Neo4j (local ou AuraDB)',
        hint: 'Conexão Bolt. AuraDB usa `neo4j+s://`.',
        transport: 'bolt',
        fields: [
            {
                name: 'uri',
                label: 'Endereço do servidor',
                placeholder: 'bolt://127.0.0.1:7687',
                default: 'bolt://127.0.0.1:7687',
                hint: 'AuraDB: `neo4j+s://<id>.databases.neo4j.io`',
                validate: (v) =>
                    /^(bolt|neo4j)(\+s|\+ssc)?:\/\/.+/.test(v || '')
                        ? null
                        : 'Informe uma URI bolt:// ou neo4j+s:// (AuraDB).'
            },
            {
                name: 'user',
                label: 'Usuário',
                placeholder: 'neo4j',
                default: 'neo4j',
                validate: (v) => (v && v.trim() ? null : 'Informe o usuário.')
            },
            {
                name: 'password',
                label: 'Senha',
                secret: true,
                validate: (v) => (v ? null : 'Informe a senha.')
            },
            {
                name: 'database',
                label: 'Banco',
                placeholder: 'neo4j',
                default: 'neo4j',
                optional: true
            }
        ]
    }
};

/** Os backends na ordem em que o painel os oferece. */
function listBackends() {
    return [BACKENDS[BACKEND_ARCADEDB], BACKENDS[BACKEND_ARCADEDB_EMBEDDED], BACKENDS[BACKEND_NEO4J]];
}

function backendSpec(backendId) {
    return BACKENDS[backendId];
}

/** A chave de cofre de um perfil. Deriva do id, que é imutável. */
function secretKey(profileId) {
    return `${SECRET_PREFIX}${profileId}`;
}

/**
 * Id estável e independente do nome.
 *
 * Renomear um perfil não pode invalidar a senha guardada, e dois perfis podem
 * legitimamente ter o mesmo rótulo ("local") apontando para bancos diferentes —
 * derivar o id do nome quebraria os dois casos.
 */
function newProfileId() {
    return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Os perfis salvos. Sempre um array, mesmo com estado ausente ou corrompido. */
function listProfiles(context) {
    const stored = context.globalState.get(PROFILES_KEY);
    return Array.isArray(stored) ? stored : [];
}

function getProfile(context, profileId) {
    return listProfiles(context).find((p) => p && p.id === profileId);
}

/**
 * Grava (cria ou atualiza) um perfil e sua senha.
 *
 * `password` é tratado à parte do resto de propósito: `profile` é o objeto que
 * vai para `globalState` e **nunca** pode conter segredo. Separar os dois na
 * assinatura é o que impede o acidente de gravar a senha em claro por descuido
 * de quem chama.
 *
 * `password === undefined` preserva a que já estava — é o que permite ao painel
 * mostrar "configurada" sem devolver o valor e ainda assim salvar o formulário.
 * Uma string vazia é diferente: apaga.
 */
async function saveProfile(context, profile, password) {
    const profiles = listProfiles(context);
    const id = profile.id || newProfileId();
    const clean = sanitizeProfile({ ...profile, id });

    const index = profiles.findIndex((p) => p && p.id === id);
    if (index >= 0) {
        profiles[index] = clean;
    } else {
        profiles.push(clean);
    }
    await context.globalState.update(PROFILES_KEY, profiles);

    if (password !== undefined) {
        if (password === '') {
            await context.secrets.delete(secretKey(id));
        } else {
            await context.secrets.store(secretKey(id), password);
        }
    }
    return clean;
}

/**
 * Remove do objeto tudo que não seja campo declarado do backend.
 *
 * Duas razões. A primeira é segurança: um `password` que chegue por engano
 * dentro de `profile` seria persistido em claro em `globalState`, e essa é
 * exatamente a classe de vazamento que este ecossistema já pagou duas vezes. A
 * segunda é higiene: campos de um backend não vazam para outro quando o
 * pesquisador troca o tipo no formulário.
 */
function sanitizeProfile(profile) {
    const spec = backendSpec(profile.backend);
    const clean = {
        id: profile.id,
        name: typeof profile.name === 'string' ? profile.name.trim() : '',
        backend: profile.backend
    };
    if (!spec) {
        return clean;
    }
    for (const field of spec.fields) {
        if (field.secret) {
            continue;
        }
        const value = profile[field.name];
        if (typeof value === 'string' && value.trim()) {
            clean[field.name] = value.trim();
        }
    }
    return clean;
}

/** Apaga o perfil e a senha correspondente. */
async function deleteProfile(context, profileId) {
    const remaining = listProfiles(context).filter((p) => p && p.id !== profileId);
    await context.globalState.update(PROFILES_KEY, remaining);
    await context.secrets.delete(secretKey(profileId));

    // Um perfil ativo apagado deixaria o workspace apontando para o vazio.
    if (getActiveProfileId(context) === profileId) {
        await setActiveProfile(context, remaining.length ? remaining[0].id : undefined);
    }
}

function getActiveProfileId(context) {
    return context.workspaceState.get(ACTIVE_PROFILE_KEY);
}

function setActiveProfile(context, profileId) {
    return context.workspaceState.update(ACTIVE_PROFILE_KEY, profileId);
}

/**
 * O perfil ativo deste workspace, com a senha resolvida.
 *
 * Devolve `undefined` quando não há perfil ativo, quando o perfil referido já
 * não existe, ou quando falta a senha de um backend que exige senha. As três
 * situações significam "não dá para consultar o banco", e quem chama trata todas
 * do mesmo jeito — mas `describeProfileGap` sabe distingui-las para a mensagem.
 */
async function readActiveConnection(context) {
    const profile = getProfile(context, getActiveProfileId(context));
    if (!profile) {
        return undefined;
    }
    const spec = backendSpec(profile.backend);
    if (!spec) {
        return undefined;
    }

    const needsSecret = spec.fields.some((f) => f.secret);
    if (!needsSecret) {
        return { ...profile, spec };
    }

    const password = await context.secrets.get(secretKey(profile.id));
    if (!password) {
        return undefined;
    }
    return { ...profile, password, spec };
}

/**
 * O que falta para o perfil ficar utilizável, ou `undefined` se nada falta.
 *
 * Existe para que as mensagens nomeiem a lacuna concreta em vez de repetir
 * "configure a conexão" — o pedido genérico que reaparecia mesmo depois de o
 * pesquisador ter configurado tudo, porque olhava para o transporte e não para
 * o que estava salvo.
 */
function describeProfileGap(profile, hasPassword) {
    if (!profile) {
        return 'Nenhuma conexão foi configurada ainda.';
    }
    const spec = backendSpec(profile.backend);
    if (!spec) {
        return `A conexão "${profile.name}" usa um tipo de banco desconhecido (${profile.backend}).`;
    }
    for (const field of spec.fields) {
        if (field.optional) {
            continue;
        }
        if (field.secret) {
            if (!hasPassword) {
                return `Falta a senha da conexão "${profile.name}".`;
            }
            continue;
        }
        if (!profile[field.name]) {
            return `Falta "${field.label}" na conexão "${profile.name}".`;
        }
    }
    return undefined;
}

/** Valida um formulário inteiro. Devolve `{campo: mensagem}`, vazio se OK. */
function validateProfile(profile, { password, hasStoredPassword = false } = {}) {
    const errors = {};
    if (!profile.name || !profile.name.trim()) {
        errors.name = 'Dê um nome a esta conexão.';
    }
    const spec = backendSpec(profile.backend);
    if (!spec) {
        errors.backend = 'Escolha o tipo de banco.';
        return errors;
    }
    for (const field of spec.fields) {
        // O segredo pode legitimamente vir vazio quando já existe um guardado:
        // é assim que o painel mostra "configurada" sem devolver o valor.
        const value = field.secret ? password : profile[field.name];
        if (field.secret && !password && hasStoredPassword) {
            continue;
        }
        if (field.optional && !value) {
            continue;
        }
        const message = field.validate ? field.validate(value) : value ? null : `Informe ${field.label}.`;
        if (message) {
            errors[field.name] = message;
        }
    }
    return errors;
}

/** Rótulo curto para a barra de status. */
function formatProfileLabel(profile, database) {
    if (!profile) {
        return '$(database) Sem conexão';
    }
    const db = database || profile.database;
    return db ? `$(database) ${profile.name} · ${db}` : `$(database) ${profile.name}`;
}

/**
 * Importa a conexão da versão anterior como um perfil, uma única vez.
 *
 * Quem já tinha o chat funcionando não pode perdê-lo ao atualizar. A migração é
 * silenciosa de propósito: pedir confirmação para reconstruir uma configuração
 * que o pesquisador já fez é a mesma pergunta redundante que este trabalho
 * inteiro existe para eliminar.
 *
 * Roda só quando NÃO há perfil nenhum. Depois disso os perfis são a única fonte
 * de verdade, e uma segunda importação só poderia criar duplicata.
 *
 * A senha antiga é copiada, não movida: apagá-la impediria voltar à versão
 * anterior se algo der errado. `forgetLegacyPassword` existe para quando o
 * pesquisador quiser fazer a limpeza.
 */
async function migrateLegacyConnection(context, legacy) {
    if (!legacy || listProfiles(context).length > 0) {
        return undefined;
    }
    const profile = await saveProfile(
        context,
        {
            name: 'Conexão importada',
            backend: BACKEND_ARCADEDB,
            uri: legacy.uri,
            user: legacy.user
        },
        legacy.password
    );
    await setActiveProfile(context, profile.id);
    return profile;
}

module.exports = {
    PROFILES_KEY,
    migrateLegacyConnection,
    ACTIVE_PROFILE_KEY,
    SECRET_PREFIX,
    BACKEND_ARCADEDB,
    BACKEND_ARCADEDB_EMBEDDED,
    BACKEND_NEO4J,
    BACKENDS,
    listBackends,
    backendSpec,
    secretKey,
    newProfileId,
    listProfiles,
    getProfile,
    saveProfile,
    sanitizeProfile,
    deleteProfile,
    getActiveProfileId,
    setActiveProfile,
    readActiveConnection,
    describeProfileGap,
    validateProfile,
    formatProfileLabel
};
