/**
 * connectionStatus.js - O que já está configurado, e o que falta.
 *
 * Existe por causa de um defeito de diagnóstico, não de configuração. Os avisos
 * do chat perguntavam "há ferramenta MCP viva?" e, quando não havia, ofereciam
 * *configurar a conexão* — a mesma frase para causas diferentes. Um pesquisador
 * que tinha acabado de configurar tudo recebia o mesmo pedido de novo, o que
 * lia como "não salvou" quando o problema era outro (servidor fora do ar,
 * `mcp.json` ausente, MCP ainda não iniciado).
 *
 * A distinção que este módulo introduz: **credencial salva** e **ferramentas
 * vivas** são dois estados independentes. Só o par diz qual é o passo seguinte,
 * e cada combinação tem um passo DIFERENTE. Nenhuma mensagem daqui pede o que
 * já foi feito.
 */

const vscode = require('vscode');
const { readConnection } = require('./connectionSettings');
const {
    listProfiles,
    getProfile,
    getActiveProfileId,
    secretKey,
    describeProfileGap
} = require('./connectionProfiles');

/**
 * Estado da configuração do chat.
 *
 * `hasTools` é passado por quem chama, e não lido aqui, porque o chamador já o
 * calculou com o filtro que lhe interessa (`selectArcadeDbTools`) e porque ler
 * `vscode.lm.tools` uma segunda vez poderia dar outra resposta no meio de um
 * turno.
 */
async function readConnectionStatus(context, hasTools) {
    const base = {
        hasTools: Boolean(hasTools),
        hasWorkspace: Boolean(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length)
    };

    // Perfis primeiro: são o modelo atual. O caminho antigo abaixo é fallback
    // para quem ainda não migrou, não um segundo lugar de verdade.
    const profile = getProfile(context, getActiveProfileId(context));
    if (profile) {
        const hasPassword = Boolean(await context.secrets.get(secretKey(profile.id)));
        return {
            ...base,
            profile,
            hasCredentials: !describeProfileGap(profile, hasPassword),
            gap: describeProfileGap(profile, hasPassword),
            uri: profile.uri || profile.dbPath,
            user: profile.user
        };
    }

    // Há perfis cadastrados, mas nenhum ativo neste workspace: é um estado
    // próprio, e o passo que ele pede — escolher — não é o mesmo de "configure".
    if (listProfiles(context).length > 0) {
        return { ...base, hasCredentials: false, hasProfiles: true };
    }

    // Configuração da versão anterior, ainda no par setting+cofre. Continua
    // valendo para não quebrar quem já tinha o chat funcionando.
    const legacy = await readConnection(context);
    return {
        ...base,
        hasCredentials: Boolean(legacy),
        legacy: Boolean(legacy),
        uri: legacy && legacy.uri,
        user: legacy && legacy.user
    };
}

/**
 * A mensagem e o botão para o estado atual.
 *
 * Devolve `undefined` quando não há o que dizer — configurado e funcionando.
 * Cada ramo nomeia a causa provável e oferece a ação que corresponde a ELA:
 * um servidor no ar não se resolve regravando credencial, e uma credencial
 * ausente não se resolve reiniciando servidor.
 */
function describeNextStep(status) {
    if (status.hasTools) {
        return undefined;
    }

    // Perfil ativo existe mas está incompleto: a mensagem nomeia o que falta
    // (`gap`), em vez de mandar refazer tudo.
    if (status.gap) {
        return {
            message: `${status.gap} Open the settings page to complete it.`,
            command: 'synesis.openSettings',
            title: 'Open settings'
        };
    }

    if (status.hasProfiles) {
        return {
            message:
                'There are registered connections, but none is marked as active in this project. ' +
                'Choose which database this project queries.',
            command: 'synesis.openSettings',
            title: 'Choose connection'
        };
    }

    if (!status.hasCredentials) {
        return {
            message:
                'No database connection has been configured yet. ' +
                'The settings page gathers server, user, password and database in a single screen.',
            command: 'synesis.openSettings',
            title: 'Open settings'
        };
    }

    if (!status.hasWorkspace) {
        return {
            message:
                `The credential for **${status.uri}** is saved, but no folder is open — ` +
                'VSCode only loads MCP servers from an open workspace. Open the project folder.',
            command: 'vscode.openFolder',
            title: 'Open folder'
        };
    }

    // Credencial salva, workspace aberto, e ainda assim nenhuma ferramenta.
    // Já não é configuração — é o servidor que não respondeu. Dizer isso é o
    // que evita o pedido repetido de "configurar a conexão" a quem já
    // configurou. O botão leva ao teste de conexão, que informa a causa real
    // em vez de mandar refazer o formulário no escuro.
    return {
        message:
            `The connection to **${status.uri}** (user \`${status.user}\`) is saved, but the server ` +
            'did not respond.\n\n' +
            'The likely cause is not the configuration: the server may be down or ' +
            'unreachable from this machine. Use **Test connection** on the ' +
            'settings page to see the exact reason.',
        command: 'synesis.openSettings',
        title: 'Test connection'
    };
}

module.exports = {
    readConnectionStatus,
    describeNextStep
};
