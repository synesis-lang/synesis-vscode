/**
 * databaseSelection.js - Escolha do banco ArcadeDB que o @synesis consulta.
 *
 * O prompt de sistema do participant era fixo e não dizia qual banco usar, o
 * que obrigava o modelo a chamar `list_databases` a cada conversa e a adivinhar
 * quando havia mais de um. Aqui o banco vira estado explícito do workspace.
 *
 * `workspaceState` e não `globalState`: projetos diferentes analisam bancos
 * diferentes, e herdar a escolha de outro projeto ao abrir uma janela nova
 * seria pior do que não ter escolha nenhuma.
 */

const vscode = require('vscode');
const { readConnectionStatus, describeNextStep } = require('./connectionStatus');
const {
    getProfile,
    getActiveProfileId,
    readActiveConnection,
    saveProfile
} = require('./connectionProfiles');
const { createGraphClient } = require('./graphClients');

const SELECTED_DATABASE_KEY = 'synesis.chat.selectedDatabase';
const LIST_DATABASES_TOOL = 'list_databases';

/**
 * Extrai os nomes de banco do resultado de `list_databases`.
 *
 * O MCP do ArcadeDB devolve o payload como TEXTO JSON dentro de uma parte de
 * texto — verificado contra o servidor real (26.7.3): `{"databases":["face85"]}`.
 * Não é um objeto estruturado, daí o JSON.parse.
 *
 * Tolerante de propósito: um servidor que responda em outro formato, ou um
 * texto que não seja JSON, devolve lista vazia em vez de derrubar o comando —
 * quem chama trata a lista vazia com uma mensagem clara.
 */
function parseDatabaseNames(toolResult) {
    const parts = (toolResult && toolResult.content) || [];
    const names = [];

    for (const part of parts) {
        const text = part && typeof part.value === 'string' ? part.value : null;
        if (!text) {
            continue;
        }

        let payload;
        try {
            payload = JSON.parse(text);
        } catch {
            continue;
        }

        // Formato conhecido: { databases: [...] }. Aceita também um array puro,
        // que é o outro shape plausível caso o servidor mude.
        const list = Array.isArray(payload) ? payload : payload && payload.databases;
        if (!Array.isArray(list)) {
            continue;
        }

        for (const entry of list) {
            if (typeof entry === 'string' && entry) {
                names.push(entry);
            } else if (entry && typeof entry.name === 'string' && entry.name) {
                names.push(entry.name);
            }
        }
    }

    // Dedup preservando a ordem em que o servidor listou.
    return [...new Set(names)];
}

/**
 * Banco escolhido para este workspace, ou undefined se ainda não houver.
 *
 * O perfil ativo tem precedência: quando ele nomeia um banco, é esse o banco,
 * porque foi a escolha mais recente e explícita do pesquisador. A chave antiga
 * segue valendo como fallback para quem escolheu banco antes de existirem
 * perfis — migrar em silêncio seria trocar o corpus consultado sem avisar.
 */
function getSelectedDatabase(context) {
    const profile = getProfile(context, getActiveProfileId(context));
    if (profile && profile.database) {
        return profile.database;
    }
    return context.workspaceState.get(SELECTED_DATABASE_KEY);
}

function setSelectedDatabase(context, database) {
    return context.workspaceState.update(SELECTED_DATABASE_KEY, database);
}

/**
 * Compõe o prompt de sistema com a instrução de banco.
 *
 * As duas instruções são mutuamente exclusivas de propósito: ou o modelo sabe
 * qual banco usar, ou é mandado descobrir. O texto base não fala de escolha de
 * banco justamente para que estas duas não se contradigam.
 */
function buildSystemPromptWithDatabase(basePrompt, database) {
    if (!database) {
        return (
            `${basePrompt}\n\n` +
            'Nenhum banco foi selecionado. Chame list_databases primeiro para descobrir ' +
            'os bancos disponíveis, e nunca adivinhe um nome de banco.'
        );
    }
    return (
        `${basePrompt}\n\n` +
        `O banco selecionado para esta conversa é "${database}". Use-o em todas as ` +
        'consultas, sem chamar list_databases nem perguntar ao usuário qual banco usar.'
    );
}

/** Rótulo da status bar. Curto de propósito: divide espaço com o item do LSP. */
function formatStatusBarText(database) {
    return database ? `$(database) ${database}` : '$(database) Sem banco';
}

function formatStatusBarTooltip(database) {
    // "banco de grafos", e não só "banco": o item vizinho é o do LSP, e a
    // distinção entre o corpus e o provedor de IA é o que o pesquisador precisa
    // ter clara — são duas configurações independentes.
    return database
        ? `Synesis: o chat @synesis consulta o banco de grafos "${database}". Clique para trocar.`
        : 'Synesis: nenhum banco de grafos selecionado. Clique para escolher.';
}

/**
 * Comando "Synesis: Selecionar Banco de Grafos do Chat".
 *
 * A lista vem do servidor real, não de constante no código: se o pesquisador
 * criar um banco novo, ele aparece aqui sem precisar de release.
 *
 * Com perfil ativo, pergunta ao servidor do perfil diretamente. Sem perfil,
 * cai no caminho MCP anterior — que continua valendo para quem ainda não
 * migrou, e some quando não houver mais o que migrar.
 */
async function selectDatabaseCommand(context, onChanged) {
    const connection = await readActiveConnection(context);
    if (connection) {
        const client = createGraphClient(connection);
        if (client) {
            let databases;
            try {
                databases = await client.listDatabases();
            } catch (error) {
                // A mensagem do cliente já distingue "fora do ar" de "credencial
                // recusada"; repeti-la é melhor que um genérico "falhou".
                vscode.window.showErrorMessage(`Synesis: ${error.message || error}`);
                return undefined;
            }
            return pickAndStore(context, databases, onChanged);
        }
    }

    try {
        await vscode.commands.executeCommand('workbench.mcp.startServer', '*', { waitForLiveTools: true });
    } catch (error) {
        console.warn('Synesis Chat: falha ao iniciar servidores MCP', error);
    }

    // Casa pelo sufixo, não por igualdade: o VSCode mangla o nome de
    // ferramentas MCP para `mcp_<servidor>_<ferramenta>`. Ver a explicação
    // completa em `matchesArcadeDbTool`, em chatParticipant.js.
    const listTool = (vscode.lm.tools || []).find(
        (tool) =>
            tool &&
            typeof tool.name === 'string' &&
            (tool.name === LIST_DATABASES_TOOL || tool.name.endsWith(`_${LIST_DATABASES_TOOL}`))
    );
    if (!listTool) {
        // Mesma razão do aviso no chat: oferecer "configurar conexão" a quem já
        // configurou é o que fazia o pedido parecer não ter fim. `describeNextStep`
        // separa credencial ausente de servidor que não respondeu, e cada caso
        // ganha o botão que de fato o resolve.
        const next = describeNextStep(await readConnectionStatus(context, false));
        if (!next) {
            return undefined;
        }
        // Sem markdown: `showWarningMessage` mostra os asteriscos e as crases
        // cruas. A mensagem é a mesma; só o realce sai.
        const plain = next.message.replace(/\*\*/g, '').replace(/`/g, '');
        const choice = await vscode.window.showWarningMessage(`Synesis: ${plain}`, next.title);
        if (choice === next.title) {
            await vscode.commands.executeCommand(next.command);
        }
        return undefined;
    }

    let databases;
    try {
        const result = await vscode.lm.invokeTool(listTool.name, { input: {} });
        databases = parseDatabaseNames(result);
    } catch (error) {
        vscode.window.showErrorMessage(`Synesis: falha ao listar bancos — ${error.message || error}`);
        return undefined;
    }

    return pickAndStore(context, databases, onChanged);
}

/** A escolha em si, comum aos dois caminhos. */
async function pickAndStore(context, databases, onChanged) {
    if (!databases || databases.length === 0) {
        vscode.window.showWarningMessage('Synesis: o servidor não devolveu nenhum banco de grafos.');
        return undefined;
    }

    const current = getSelectedDatabase(context);
    const picked = await vscode.window.showQuickPick(
        databases.map((name) => ({
            label: name,
            description: name === current ? '(atual)' : undefined
        })),
        { placeHolder: 'Qual banco de grafos o @synesis deve consultar?' }
    );

    if (!picked) {
        return undefined;
    }

    // Grava no perfil ativo quando há um: é ele a fonte de verdade, e deixar a
    // escolha só na chave antiga faria o painel mostrar um banco e o chat
    // consultar outro.
    const profileId = getActiveProfileId(context);
    const profile = getProfile(context, profileId);
    if (profile) {
        await saveProfile(context, { ...profile, database: picked.label }, undefined);
    }
    await setSelectedDatabase(context, picked.label);

    if (typeof onChanged === 'function') {
        onChanged(picked.label);
    }
    return picked.label;
}

module.exports = {
    SELECTED_DATABASE_KEY,
    LIST_DATABASES_TOOL,
    parseDatabaseNames,
    getSelectedDatabase,
    setSelectedDatabase,
    buildSystemPromptWithDatabase,
    formatStatusBarText,
    formatStatusBarTooltip,
    selectDatabaseCommand,
    pickAndStore
};
