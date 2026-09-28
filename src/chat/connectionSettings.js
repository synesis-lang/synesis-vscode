/**
 * connectionSettings.js - Leitura da conexão da versão ANTERIOR.
 *
 * Este módulo já foi o dono da configuração de conexão: um par de settings
 * (`synesisExplorer.chat.arcadedb.{uri,user}`) mais uma senha no cofre, três
 * `InputBox` encadeados para preenchê-los, e um `.vscode/mcp.json` escrito a
 * partir disso. Esse desenho modelava um caso só — ArcadeDB, sobre TCP, via
 * MCP — e foi substituído por `connectionProfiles.js`, que trata o backend como
 * campo e guarda várias conexões nomeadas.
 *
 * O que sobrou aqui é **só leitura, e só para migração**: quem já tinha o chat
 * funcionando não pode perdê-lo ao atualizar. `connectionStatus` consulta esta
 * função quando não há perfil algum, e o painel oferece importar o que
 * encontrar. Quando não houver mais o que migrar, o arquivo sai.
 *
 * As settings correspondentes CONTINUAM declaradas no `package.json`, marcadas
 * como legado (`deprecationMessage`), e isso é deliberado: é a declaração com
 * `"scope": "machine"` que faz o VSCode ignorar o valor vindo do `settings.json`
 * de um workspace. Sem ela, um workspace não confiável poderia gravar a URI e a
 * migração — que importa sem perguntar — redirecionaria a conexão, com a senha
 * do cofre, para outro host. Só saem junto com este arquivo.
 */

const vscode = require('vscode');

const SECTION = 'synesisExplorer.chat.arcadedb';
const PASSWORD_SECRET_KEY = 'synesis.arcadedb.password';
const DEFAULT_URI = 'http://localhost:2480';
const DEFAULT_USER = 'root';

/** URI e usuário gravados pela versão anterior. */
function readConnectionSettings() {
    const config = vscode.workspace.getConfiguration(SECTION);
    return {
        uri: (config.get('uri') || DEFAULT_URI).trim(),
        user: (config.get('user') || DEFAULT_USER).trim()
    };
}

function getPassword(context) {
    return context.secrets.get(PASSWORD_SECRET_KEY);
}

/**
 * A conexão antiga completa, ou `undefined` se não houver.
 *
 * A ausência da senha é o sinal de "não havia configuração": URI e usuário têm
 * default que serve a um servidor local, então só ela distingue um estado do
 * outro.
 */
async function readConnection(context) {
    const password = await getPassword(context);
    if (!password) {
        return undefined;
    }
    return { ...readConnectionSettings(), password };
}

/** Endpoint MCP a partir da URI base. Usado ao migrar. */
function mcpEndpoint(uri) {
    return `${String(uri || DEFAULT_URI).replace(/\/+$/, '')}/api/v1/mcp`;
}

/** Header Basic. Mantido para os testes de migração. */
function basicAuthHeader(user, password) {
    const token = Buffer.from(`${user}:${password || ''}`).toString('base64');
    return `Basic ${token}`;
}

/** Apaga a senha antiga, depois de migrada. */
async function forgetLegacyPassword(context) {
    await context.secrets.delete(PASSWORD_SECRET_KEY);
}

module.exports = {
    SECTION,
    PASSWORD_SECRET_KEY,
    DEFAULT_URI,
    DEFAULT_USER,
    readConnectionSettings,
    readConnection,
    getPassword,
    mcpEndpoint,
    basicAuthHeader,
    forgetLegacyPassword
};
