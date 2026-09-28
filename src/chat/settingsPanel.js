/**
 * settingsPanel.js - A página de configuração do Synesis.
 *
 * Existe porque a API de `configuration` do VSCode **não tem tipo "senha"**: ela
 * só renderiza o que sabe gravar em `settings.json` — string, boolean, number,
 * enum — e `settings.json` é texto puro, sincroniza entre máquinas e é legível
 * por outras extensões. Uma senha ali é um vazamento à espera, e este
 * ecossistema já pagou dois.
 *
 * A consequência era a interface que o pesquisador descreveu como "confusa e
 * arcaica": a página nativa mostrava servidor e usuário, e senha e API keys
 * viviam em `InputBox` disparados por comando — o mesmo processo replicado em
 * dois lugares, sem que nenhum deles fosse completo. Toda extensão que precisa
 * de credencial resolve isso do mesmo jeito, e é o que se faz aqui: uma webview
 * própria, onde o segredo é um CAMPO como qualquer outro, gravado via
 * `SecretStorage` (cofre do SO) em vez de setting.
 *
 * Regra que o painel nunca quebra: **a senha vai para o webview apenas como o
 * fato de existir**, jamais como valor. O campo chega vazio com o rótulo
 * "configurada"; salvar sem tocá-lo preserva a que está guardada.
 */

const vscode = require('vscode');
const {
    listBackends,
    backendSpec,
    listProfiles,
    getProfile,
    saveProfile,
    deleteProfile,
    getActiveProfileId,
    setActiveProfile,
    secretKey,
    newProfileId,
    validateProfile,
    describeProfileGap
} = require('./connectionProfiles');

const VIEW_TYPE = 'synesis.settings';

/** Painel único: reabrir traz o existente para a frente em vez de duplicar. */
let currentPanel;

/**
 * O estado que o webview recebe.
 *
 * `hasPassword` no lugar da senha é a decisão central deste módulo. O webview
 * roda num contexto isolado mas ainda assim é HTML: mandar o segredo para lá o
 * exporia ao DevTools do editor e a qualquer erro de escopo no script. O painel
 * precisa saber apenas se existe senha, para decidir entre "configurada" e
 * "não configurada".
 */
async function buildState(context) {
    const profiles = listProfiles(context);
    const activeId = getActiveProfileId(context);

    const withStatus = [];
    for (const profile of profiles) {
        const hasPassword = Boolean(await context.secrets.get(secretKey(profile.id)));
        withStatus.push({
            ...profile,
            hasPassword,
            gap: describeProfileGap(profile, hasPassword)
        });
    }

    const providers = [];
    for (const provider of PROVIDER_SPECS) {
        providers.push({
            ...provider,
            hasKey: Boolean(await context.secrets.get(provider.secret)),
            // Só o OpenRouter tem lista declarada: os outros três descobrem os
            // modelos pela própria API. Ver `models` abaixo.
            models: provider.id === 'openrouter' ? readOpenRouterModels() : undefined
        });
    }

    return {
        profiles: withStatus,
        activeId,
        backends: listBackends().map((b) => ({
            id: b.id,
            label: b.label,
            hint: b.hint,
            // `validate` é função e não sobrevive à serialização — o webview faz
            // a validação amigável, e `validateProfile` refaz a real no salvamento.
            fields: b.fields.map((f) => ({
                name: f.name,
                label: f.label,
                placeholder: f.placeholder,
                default: f.default,
                hint: f.hint,
                secret: Boolean(f.secret),
                optional: Boolean(f.optional)
            }))
        })),
        providers
    };
}

/**
 * Os provedores de IA, no mesmo painel.
 *
 * Duplicado de `providerRegistry` de propósito reduzido: aqui só interessa o
 * par (id, chave de cofre) e o rótulo. Importar o registry inteiro traria os
 * catálogos de modelos e as classes de provider para um módulo de interface.
 */
const PROVIDER_SPECS = [
    { id: 'anthropic', label: 'Anthropic (Claude)', secret: 'synesis.apiKey.anthropic', hint: 'sk-ant-…' },
    { id: 'openai', label: 'OpenAI (GPT)', secret: 'synesis.apiKey.openai', hint: 'sk-…' },
    { id: 'gemini', label: 'Google Gemini', secret: 'synesis.apiKey.gemini', hint: 'AIza…' },
    {
        id: 'openrouter',
        label: 'OpenRouter (inclui modelos gratuitos)',
        secret: 'synesis.apiKey.openrouter',
        hint: 'sk-or-v1-…'
    }
];

/**
 * Os modelos do OpenRouter que o pesquisador declarou.
 *
 * Diferente das chaves, isto NÃO é segredo — vive em `settings.json`, e o
 * painel é só uma forma melhor de editar a mesma lista. Quem preferir o JSON
 * continua podendo, e as duas vias enxergam o mesmo valor.
 */
function readOpenRouterModels() {
    const raw = vscode.workspace.getConfiguration('synesisExplorer.chat').get('openRouterModels');
    return Array.isArray(raw) ? raw.map((v) => String(v || '').trim()).filter(Boolean) : [];
}

/**
 * Grava a lista de modelos do OpenRouter.
 *
 * Escopo global, e não de workspace: a lista é do pesquisador — os modelos que
 * ele quer testar —, não de um projeto. Gravar por workspace faria a campanha
 * de medição desaparecer ao abrir outra pasta.
 */
async function writeOpenRouterModels(models) {
    await vscode.workspace
        .getConfiguration('synesisExplorer.chat')
        .update('openRouterModels', models, vscode.ConfigurationTarget.Global);
}

/** Abre (ou traz à frente) o painel. */
async function openSettingsPanel(context, { onChanged } = {}) {
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
        currentPanel.webview.postMessage({ type: 'state', state: await buildState(context) });
        return currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Synesis: Configuração', vscode.ViewColumn.One, {
        enableScripts: true,
        // Sem isso o formulário meio preenchido se perde ao trocar de aba, que é
        // justamente quando o pesquisador vai buscar a credencial em outro lugar.
        retainContextWhenHidden: true
    });
    currentPanel = panel;

    panel.webview.html = renderHtml(panel.webview);
    panel.onDidDispose(() => {
        currentPanel = undefined;
    });

    panel.webview.onDidReceiveMessage(async (message) => {
        try {
            await handleMessage(context, panel, message, onChanged);
        } catch (error) {
            panel.webview.postMessage({
                type: 'error',
                message: `Falha inesperada: ${error && error.message ? error.message : error}`
            });
        }
    });

    panel.webview.postMessage({ type: 'state', state: await buildState(context) });
    return panel;
}

async function handleMessage(context, panel, message, onChanged) {
    const post = async (extra = {}) => {
        panel.webview.postMessage({ type: 'state', state: await buildState(context), ...extra });
    };

    switch (message && message.type) {
        case 'ready':
            return post();

        case 'saveProfile': {
            const profile = { ...message.profile, id: message.profile.id || newProfileId() };
            const hasStoredPassword = message.profile.id
                ? Boolean(await context.secrets.get(secretKey(message.profile.id)))
                : false;

            const errors = validateProfile(profile, { password: message.password, hasStoredPassword });
            if (Object.keys(errors).length > 0) {
                return panel.webview.postMessage({ type: 'validation', errors, profileId: message.profile.id });
            }

            // `undefined` preserva a senha guardada; string vazia com senha nova
            // não chega aqui (a validação acima exige uma das duas).
            const saved = await saveProfile(context, profile, message.password || undefined);

            // Primeiro perfil vira o ativo sozinho: exigir um segundo clique
            // para "ativar" o único perfil existente é a meia-configuração que
            // este trabalho existe para eliminar.
            if (!getActiveProfileId(context)) {
                await setActiveProfile(context, saved.id);
            }
            if (typeof onChanged === 'function') {
                onChanged();
            }
            return post({ toast: `Conexão "${saved.name}" salva.` });
        }

        case 'deleteProfile': {
            await deleteProfile(context, message.profileId);
            if (typeof onChanged === 'function') {
                onChanged();
            }
            return post({ toast: 'Conexão removida.' });
        }

        case 'activateProfile': {
            await setActiveProfile(context, message.profileId);
            if (typeof onChanged === 'function') {
                onChanged();
            }
            return post();
        }

        case 'testProfile': {
            const profile = getProfile(context, message.profileId);
            if (!profile) {
                return panel.webview.postMessage({
                    type: 'testResult',
                    profileId: message.profileId,
                    ok: false,
                    message: 'Salve a conexão antes de testá-la.'
                });
            }
            const password = await context.secrets.get(secretKey(profile.id));
            const result = await testConnection({ ...profile, password });
            return panel.webview.postMessage({
                type: 'testResult',
                profileId: message.profileId,
                ok: result.ok,
                message: result.message,
                databases: result.databases
            });
        }

        case 'saveApiKey': {
            const spec = PROVIDER_SPECS.find((p) => p.id === message.providerId);
            if (!spec) {
                return undefined;
            }
            if (message.key) {
                await context.secrets.store(spec.secret, message.key);
                return post({ toast: `API key da ${spec.label} salva.` });
            }
            await context.secrets.delete(spec.secret);
            return post({ toast: `API key da ${spec.label} removida.` });
        }

        case 'saveOpenRouterModels': {
            const models = Array.isArray(message.models)
                ? message.models.map((v) => String(v || '').trim()).filter(Boolean)
                : [];
            // Sem duplicata e em ordem estável: a lista é lida a cada abertura
            // do seletor, e um id repetido apareceria duas vezes lá.
            const unique = [...new Set(models)];
            await writeOpenRouterModels(unique);
            return post({
                toast: unique.length
                    ? `${unique.length} modelo(s) do OpenRouter no seletor.`
                    : 'Lista limpa — voltam os modelos padrão do OpenRouter.'
            });
        }

        case 'pickFolder': {
            const picked = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                openLabel: 'Usar esta pasta'
            });
            if (picked && picked[0]) {
                panel.webview.postMessage({
                    type: 'folderPicked',
                    field: message.field,
                    value: picked[0].fsPath
                });
            }
            return undefined;
        }

        default:
            return undefined;
    }
}

/**
 * Testa a conexão de verdade.
 *
 * O ponto do botão é substituir a adivinhação por um fato. Antes, nada no fluxo
 * provava que a credencial funcionava: o pesquisador salvava, o chat dizia que
 * não havia ferramenta do banco, e as duas afirmações não se ligavam.
 *
 * Etapa 1 cobre os dois transportes do ArcadeDB. Neo4j (Bolt) chega na etapa 2 —
 * e diz isso, em vez de reportar uma falha que não aconteceu.
 */
async function testConnection(profile) {
    const spec = backendSpec(profile.backend);
    if (!spec) {
        return { ok: false, message: 'Tipo de banco desconhecido.' };
    }

    if (spec.transport === 'http') {
        return testArcadeDbHttp(profile);
    }
    if (spec.transport === 'embedded') {
        return testArcadeDbEmbedded(profile);
    }
    return {
        ok: false,
        message:
            'O teste de conexão do Neo4j ainda não está disponível nesta versão — ' +
            'a credencial foi salva e será usada assim que o suporte a Bolt entrar.'
    };
}

/**
 * `POST /api/v1/databases` com Basic Auth.
 *
 * Endpoint escolhido por ser o mais barato que exige autenticação: ele prova
 * credencial E disponibilidade numa chamada, e já devolve a lista de bancos que
 * o painel usa para preencher o campo `database`.
 */
async function testArcadeDbHttp(profile) {
    const base = String(profile.uri || '').replace(/\/+$/, '');
    const token = Buffer.from(`${profile.user}:${profile.password || ''}`).toString('base64');

    let response;
    try {
        response = await fetch(`${base}/api/v1/databases`, {
            method: 'GET',
            headers: { Authorization: `Basic ${token}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(8000)
        });
    } catch (error) {
        // Distinguir "não alcancei" de "recusou" é o que evita mandar o
        // pesquisador reconfigurar credencial quando o servidor está fora do ar.
        const reason = error && error.name === 'TimeoutError' ? 'não respondeu a tempo' : 'não pôde ser alcançado';
        return {
            ok: false,
            message: `O servidor ${base} ${reason}. Verifique se o ArcadeDB está no ar e se o endereço está correto.`
        };
    }

    if (response.status === 401 || response.status === 403) {
        return {
            ok: false,
            message: `O servidor respondeu, mas recusou as credenciais de "${profile.user}". Confira usuário e senha.`
        };
    }
    if (!response.ok) {
        return { ok: false, message: `O servidor respondeu com HTTP ${response.status}.` };
    }

    let databases = [];
    try {
        const payload = await response.json();
        const list = Array.isArray(payload) ? payload : payload && payload.result;
        if (Array.isArray(list)) {
            databases = list.filter((n) => typeof n === 'string');
        }
    } catch {
        // Conectou e autenticou; só não entendi o corpo. Isso não invalida o
        // teste — a lista de bancos é um bônus, não o critério.
        databases = [];
    }

    return {
        ok: true,
        message: databases.length
            ? `Conectado. ${databases.length} banco(s) disponível(is).`
            : 'Conectado e autenticado.',
        databases
    };
}

/** No modo embutido não há rede: o que se verifica é o layout no disco. */
async function testArcadeDbEmbedded(profile) {
    const root = String(profile.dbPath || '').trim();
    if (!root) {
        return { ok: false, message: 'Informe a pasta raiz do servidor.' };
    }

    const databasesUri = vscode.Uri.joinPath(vscode.Uri.file(root), 'databases');
    let entries;
    try {
        entries = await vscode.workspace.fs.readDirectory(databasesUri);
    } catch {
        // A confusão previsível, e a que falha em silêncio no synesis-graph:
        // apontar para a pasta do banco em vez da raiz que a contém.
        return {
            ok: false,
            message:
                `Não encontrei "${root}/databases". Este campo é a pasta RAIZ do servidor — ` +
                'a que contém `databases/`, não a pasta do banco em si.'
        };
    }

    const databases = entries
        .filter(([, kind]) => kind === vscode.FileType.Directory)
        .map(([name]) => name);

    if (databases.length === 0) {
        return { ok: false, message: `A pasta "${root}/databases" existe, mas está vazia.` };
    }
    return { ok: true, message: `${databases.length} banco(s) encontrado(s).`, databases };
}

/** Nonce da CSP: o script inline só executa se casar com o cabeçalho. */
function makeNonce() {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i += 1) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}

function renderHtml(webview) {
    const nonce = makeNonce();
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Synesis: Configuração</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); background: var(--vscode-editor-background);
    padding: 0 24px 48px; margin: 0 auto; max-width: 780px; line-height: 1.5;
  }
  h1 { font-size: 1.5em; font-weight: 600; margin: 24px 0 4px; }
  h2 { font-size: 1.1em; font-weight: 600; margin: 32px 0 8px; padding-top: 20px;
       border-top: 1px solid var(--vscode-panel-border); }
  h2:first-of-type { border-top: none; }
  p.lead { color: var(--vscode-descriptionForeground); margin: 0 0 8px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px;
          padding: 14px 16px; margin: 10px 0; background: var(--vscode-editorWidget-background); }
  .card.active { border-color: var(--vscode-focusBorder); }
  .card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .card-title { font-weight: 600; }
  .badge { font-size: .82em; padding: 1px 7px; border-radius: 10px;
           background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .badge.warn { background: var(--vscode-inputValidation-warningBackground);
                color: var(--vscode-foreground); }
  .badge.ok { background: var(--vscode-testing-iconPassed, #2ea043); color: #fff; }
  .spacer { flex: 1; }
  label { display: block; margin: 12px 0 3px; font-weight: 500; }
  .hint { color: var(--vscode-descriptionForeground); font-size: .9em; margin: 2px 0 0; }
  input, select, textarea {
    width: 100%; box-sizing: border-box; padding: 5px 8px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px;
    font-family: inherit; font-size: inherit;
  }
  input:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  /* Lista de ids em monoespacada: um caractere trocado no id do modelo e o
     tipo de erro que so aparece na hora de usar. */
  textarea { resize: vertical; font-family: var(--vscode-editor-font-family, monospace); }
  .sub-label { margin-top: 12px; font-weight: 600; font-size: .95em; }
  .row { display: flex; gap: 8px; align-items: flex-end; }
  .row > :first-child { flex: 1; }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 5px 14px; border-radius: 3px; cursor: pointer;
    font-family: inherit; font-size: inherit; white-space: nowrap;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground);
                     color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.danger { background: transparent; color: var(--vscode-errorForeground);
                  border: 1px solid var(--vscode-panel-border); }
  .actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
  .error { color: var(--vscode-errorForeground); font-size: .9em; margin-top: 3px; }
  .result { margin-top: 12px; padding: 9px 12px; border-radius: 4px; font-size: .93em; }
  .result.ok { background: var(--vscode-inputValidation-infoBackground);
               border: 1px solid var(--vscode-inputValidation-infoBorder); }
  .result.fail { background: var(--vscode-inputValidation-errorBackground);
                 border: 1px solid var(--vscode-inputValidation-errorBorder); }
  .toast { position: fixed; bottom: 20px; right: 20px; padding: 9px 16px; border-radius: 4px;
           background: var(--vscode-notifications-background, var(--vscode-editorWidget-background));
           border: 1px solid var(--vscode-panel-border); box-shadow: 0 2px 8px rgba(0,0,0,.3); }
  .empty { color: var(--vscode-descriptionForeground); padding: 16px 0; }
  .note { background: var(--vscode-textBlockQuote-background);
          border-left: 3px solid var(--vscode-textBlockQuote-border);
          padding: 9px 14px; margin: 12px 0; font-size: .93em; }
  code { font-family: var(--vscode-editor-font-family); font-size: .93em; }
  /* As duas metades no topo: o pesquisador precisa ver, antes de qualquer
     campo, que banco de grafos e provedor de IA são coisas distintas. Confundir
     os dois leva a procurar o corpus na configuração do modelo. */
  .split { display: flex; gap: 12px; margin: 16px 0 8px; flex-wrap: wrap; }
  .split-item { flex: 1 1 300px; display: flex; gap: 11px; align-items: flex-start;
                border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px 14px;
                background: var(--vscode-editorWidget-background); }
  .split-icon { font-size: 1.5em; line-height: 1.1; }
  .split-item p.hint { margin: 3px 0 0; }
  .section-tag { font-weight: 400; font-size: .78em; color: var(--vscode-descriptionForeground);
                 border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 1px 8px;
                 vertical-align: middle; margin-left: 6px; }
</style>
</head>
<body>
  <h1>Configuração do Synesis</h1>
  <p class="lead">
    O chat <code>@synesis</code> combina <strong>duas coisas independentes</strong>. Configure as duas.
  </p>

  <div class="split">
    <div class="split-item">
      <div class="split-icon">🗄️</div>
      <div>
        <strong>1. Banco de grafos</strong>
        <p class="hint">Onde <em>o seu corpus</em> está — o grafo gerado pelo <code>synesis-graph</code>.
        É de lá que saem os trechos e as referências que sustentam cada resposta.</p>
      </div>
    </div>
    <div class="split-item">
      <div class="split-icon">🤖</div>
      <div>
        <strong>2. Provedor de IA</strong>
        <p class="hint">Qual modelo <em>lê e redige</em>. Não guarda o seu corpus e não substitui o banco:
        sem uma conexão de grafo, o chat se recusa a responder sobre os dados.</p>
      </div>
    </div>
  </div>

  <h2>🗄️ Bancos de grafos <span class="section-tag">o seu corpus</span></h2>
  <p class="lead">
    Cadastre quantos quiser — local, remoto, de projetos diferentes — e marque qual vale neste projeto.
    Suporta <strong>ArcadeDB</strong> (servidor ou embutido) e <strong>Neo4j</strong> (local ou AuraDB).
  </p>
  <div id="profiles"></div>
  <div class="actions"><button id="add">Nova conexão de banco</button></div>

  <h2>🤖 Provedores de IA <span class="section-tag">o modelo que conversa</span></h2>
  <p class="lead">
    Cada provedor só aparece no seletor de modelo da caixa de chat depois que a chave é salva.
    Você escolhe o modelo ali, a cada conversa.
  </p>
  <div id="providers"></div>

  <div class="note">
    Senhas de banco e chaves de API ficam no <strong>cofre criptografado do sistema operacional</strong>,
    nunca em <code>settings.json</code> — que é texto puro, sincroniza entre máquinas e é legível por outras
    extensões. Por isso os campos aparecem em branco com o rótulo “configurada”: o valor guardado nunca é
    devolvido à tela.
  </div>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  let state = { profiles: [], backends: [], providers: [] };
  let editing = null;      // id em edição, ou '__new__'
  let errors = {};
  let results = {};        // profileId -> resultado do teste

  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) node.setAttribute(k, v);
    });
    (Array.isArray(children) ? children : [children]).forEach((c) => c && node.appendChild(c));
    return node;
  };

  function backendById(id) {
    return state.backends.find((b) => b.id === id) || state.backends[0];
  }

  function renderForm(profile) {
    const isNew = !profile.id;
    const backend = backendById(profile.backend);
    const form = el('div');

    form.appendChild(el('label', { text: 'Nome desta conexão', for: 'f-name' }));
    form.appendChild(el('input', {
      id: 'f-name', value: profile.name || '', placeholder: 'ex.: face85 local'
    }));
    if (errors.name) form.appendChild(el('p', { class: 'error', text: errors.name }));

    form.appendChild(el('label', { text: 'Tipo de banco', for: 'f-backend' }));
    const select = el('select', { id: 'f-backend' });
    state.backends.forEach((b) => {
      const opt = el('option', { value: b.id, text: b.label });
      if (b.id === backend.id) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => {
      // Preserva o que o pesquisador já digitou ao trocar de tipo: campos com o
      // mesmo nome (user, database) sobrevivem, o resto some com o backend.
      const draft = collect(profile);
      draft.backend = select.value;
      draft.__password = document.getElementById('f-password')
        ? document.getElementById('f-password').value : '';
      editingDraft = draft;
      render();
    });
    form.appendChild(select);
    form.appendChild(el('p', { class: 'hint', text: backend.hint || '' }));

    backend.fields.forEach((field) => {
      const id = 'f-' + field.name;
      form.appendChild(el('label', { text: field.label + (field.optional ? ' (opcional)' : ''), for: id }));

      const stored = profile.hasPassword && field.secret;
      const input = el('input', {
        id,
        type: field.secret ? 'password' : 'text',
        value: field.secret ? '' : (profile[field.name] || field.default || ''),
        placeholder: stored ? 'configurada — digite para substituir' : (field.placeholder || '')
      });

      if (field.name === 'dbPath') {
        const browse = el('button', { class: 'secondary', text: 'Procurar…',
          onclick: () => vscode.postMessage({ type: 'pickFolder', field: id }) });
        form.appendChild(el('div', { class: 'row' }, [input, browse]));
      } else if (field.name === 'database') {
        // Depois de um teste bem-sucedido a lista de bancos é conhecida, e
        // digitar o nome à mão vira fonte de erro — um banco inexistente só
        // falha na primeira pergunta, longe daqui.
        const found = (results[profile.id] || {}).databases;
        if (found && found.length) {
          const list = el('datalist', { id: 'dl-' + field.name });
          found.forEach((name) => list.appendChild(el('option', { value: name })));
          input.setAttribute('list', 'dl-' + field.name);
          form.appendChild(el('div', {}, [input, list]));
          form.appendChild(el('p', { class: 'hint',
            text: 'Disponíveis: ' + found.join(', ') }));
        } else {
          form.appendChild(input);
        }
      } else {
        form.appendChild(input);
      }

      if (field.hint) form.appendChild(el('p', { class: 'hint', text: field.hint }));
      if (errors[field.name]) form.appendChild(el('p', { class: 'error', text: errors[field.name] }));
    });

    const actions = el('div', { class: 'actions' });
    actions.appendChild(el('button', { text: 'Salvar', onclick: () => save(profile) }));
    if (!isNew) {
      actions.appendChild(el('button', {
        class: 'secondary', text: 'Testar conexão',
        onclick: () => { results[profile.id] = { pending: true }; render();
                         vscode.postMessage({ type: 'testProfile', profileId: profile.id }); }
      }));
    }
    actions.appendChild(el('button', {
      class: 'secondary', text: 'Cancelar',
      onclick: () => { editing = null; editingDraft = null; errors = {}; render(); }
    }));
    if (!isNew) {
      actions.appendChild(el('button', {
        class: 'danger', text: 'Remover',
        onclick: () => { editing = null; editingDraft = null;
                         vscode.postMessage({ type: 'deleteProfile', profileId: profile.id }); }
      }));
    }
    form.appendChild(actions);

    const result = results[profile.id];
    if (result) {
      form.appendChild(el('div', {
        class: 'result ' + (result.pending ? '' : result.ok ? 'ok' : 'fail'),
        text: result.pending ? 'Testando…' : result.message
      }));
    }
    return form;
  }

  function collect(profile) {
    const backend = backendById(
      document.getElementById('f-backend') ? document.getElementById('f-backend').value : profile.backend
    );
    const out = { id: profile.id, backend: backend.id };
    const nameEl = document.getElementById('f-name');
    out.name = nameEl ? nameEl.value : profile.name;
    backend.fields.forEach((field) => {
      if (field.secret) return;
      const input = document.getElementById('f-' + field.name);
      if (input) out[field.name] = input.value;
    });
    return out;
  }

  function save(profile) {
    const draft = collect(profile);
    const passwordEl = document.getElementById('f-password');
    vscode.postMessage({
      type: 'saveProfile',
      profile: draft,
      password: passwordEl ? passwordEl.value : undefined
    });
  }

  let editingDraft = null;

  function renderProfiles() {
    const root = document.getElementById('profiles');
    root.textContent = '';

    if (editing === '__new__') {
      const draft = editingDraft || { name: '', backend: state.backends[0] && state.backends[0].id };
      root.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-head' }, [el('span', { class: 'card-title', text: 'Nova conexão' })]),
        renderForm(draft)
      ]));
    }

    if (state.profiles.length === 0 && editing !== '__new__') {
      root.appendChild(el('p', { class: 'empty', text: 'Nenhuma conexão configurada ainda.' }));
    }

    state.profiles.forEach((profile) => {
      const isActive = profile.id === state.activeId;
      const card = el('div', { class: 'card' + (isActive ? ' active' : '') });
      const head = el('div', { class: 'card-head' }, [
        el('span', { class: 'card-title', text: profile.name || '(sem nome)' })
      ]);
      const backend = backendById(profile.backend);
      head.appendChild(el('span', { class: 'badge', text: backend ? backend.label : profile.backend }));
      if (isActive) head.appendChild(el('span', { class: 'badge ok', text: 'ativa neste projeto' }));
      if (profile.gap) head.appendChild(el('span', { class: 'badge warn', text: 'incompleta' }));
      head.appendChild(el('span', { class: 'spacer' }));

      if (editing !== profile.id) {
        if (!isActive) {
          head.appendChild(el('button', {
            class: 'secondary', text: 'Usar neste projeto',
            onclick: () => vscode.postMessage({ type: 'activateProfile', profileId: profile.id })
          }));
        }
        head.appendChild(el('button', {
          class: 'secondary', text: 'Editar',
          onclick: () => { editing = profile.id; editingDraft = null; errors = {}; render(); }
        }));
      }
      card.appendChild(head);

      if (profile.gap) card.appendChild(el('p', { class: 'hint', text: profile.gap }));

      if (editing === profile.id) {
        card.appendChild(renderForm(editingDraft && editingDraft.id === profile.id ? editingDraft : profile));
      } else {
        const summary = profile.uri || profile.dbPath || '';
        if (summary) card.appendChild(el('p', { class: 'hint', text: summary +
          (profile.database ? '  ·  banco: ' + profile.database : '') }));
        const result = results[profile.id];
        if (result && !result.pending) {
          card.appendChild(el('div', { class: 'result ' + (result.ok ? 'ok' : 'fail'), text: result.message }));
        }
      }
      root.appendChild(card);
    });
  }

  function renderProviders() {
    const root = document.getElementById('providers');
    root.textContent = '';
    state.providers.forEach((provider) => {
      const card = el('div', { class: 'card' });
      const head = el('div', { class: 'card-head' }, [
        el('span', { class: 'card-title', text: provider.label })
      ]);
      head.appendChild(el('span', {
        class: 'badge ' + (provider.hasKey ? 'ok' : ''),
        text: provider.hasKey ? 'configurada' : 'não configurada'
      }));
      card.appendChild(head);

      const input = el('input', {
        id: 'k-' + provider.id, type: 'password',
        placeholder: provider.hasKey ? 'configurada — digite para substituir' : provider.hint
      });
      const saveBtn = el('button', { text: 'Salvar', onclick: () => {
        vscode.postMessage({ type: 'saveApiKey', providerId: provider.id, key: input.value });
        input.value = '';
      }});
      card.appendChild(el('div', { class: 'row' }, [input, saveBtn]));

      if (provider.hasKey) {
        card.appendChild(el('div', { class: 'actions' }, [
          el('button', { class: 'danger', text: 'Remover chave', onclick: () =>
            vscode.postMessage({ type: 'saveApiKey', providerId: provider.id, key: '' }) })
        ]));
      }

      // Modelos do OpenRouter: campo livre, no próprio card do provedor.
      //
      // O catálogo tem centenas de modelos, então não há lista a descobrir —
      // quem escolhe é o pesquisador. Fica aqui, e não numa sequência de
      // caixas de diálogo, porque cadastrar três modelos por popup encadeado é
      // exatamente o atrito que este painel existe para eliminar.
      if (provider.models) {
        card.appendChild(el('div', { class: 'sub-label', text: 'Modelos no seletor de chat' }));
        card.appendChild(el('p', { class: 'hint', text:
          'Um id por linha (ex.: liquid/lfm-2.5-2.6b:free). Nome, janela de contexto e ' +
          'suporte a ferramentas vêm do catálogo do OpenRouter. Em branco, valem os modelos padrão.' }));

        const box = el('textarea', {
          id: 'or-models',
          rows: '4',
          spellcheck: 'false',
          placeholder: 'liquid/lfm-2.5-2.6b:free\\nqwen/qwen3-4b:free'
        });
        // Conteudo inicial via textContent, nao .value: o elemento ainda nao esta
        // no documento, e um <textarea> fora do DOM nem sempre honra a propriedade
        // .value em todos os motores. textContent e o filho de texto que o HTML
        // define, e vale antes e depois da insercao.
        box.textContent = provider.models.join('\\n');
        card.appendChild(box);
        card.appendChild(el('div', { class: 'actions' }, [
          el('button', { text: 'Salvar modelos', onclick: () =>
            vscode.postMessage({
              type: 'saveOpenRouterModels',
              models: box.value.split('\\n')
            }) })
        ]));
      }
      root.appendChild(card);
    });
  }

  /**
   * Um erro dentro de renderProviders deixava a tela pela metade em silencio:
   * o cartao ficava sem os campos que vinham depois da excecao, e nada dizia por
   * que. Mostrar a falha no proprio painel troca "o campo nao funciona" por uma
   * mensagem que nomeia a causa.
   */
  function render() {
    try { renderProfiles(); } catch (e) { showRenderError('perfis', e); }
    try { renderProviders(); } catch (e) { showRenderError('provedores', e); }
  }

  function showRenderError(secao, err) {
    const root = document.getElementById(secao === 'perfis' ? 'profiles' : 'providers');
    const box = el('div', { class: 'card' });
    box.appendChild(el('div', { class: 'card-title', text: 'Falha ao desenhar ' + secao }));
    box.appendChild(el('p', { class: 'hint', text: String((err && err.message) || err) }));
    root.appendChild(box);
  }

  document.getElementById('add').addEventListener('click', () => {
    editing = '__new__'; editingDraft = null; errors = {}; render();
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'state') {
      state = msg.state;
      if (msg.toast) {
        editing = null; editingDraft = null; errors = {};
        const toast = el('div', { class: 'toast', text: msg.toast });
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 2600);
      }
      render();
    } else if (msg.type === 'validation') {
      errors = msg.errors;
      render();
    } else if (msg.type === 'testResult') {
      results[msg.profileId] = { ok: msg.ok, message: msg.message, databases: msg.databases };
      render();
    } else if (msg.type === 'folderPicked') {
      const input = document.getElementById(msg.field);
      if (input) input.value = msg.value;
    } else if (msg.type === 'error') {
      const toast = el('div', { class: 'toast', text: msg.message });
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 4000);
    }
  });

  vscode.postMessage({ type: 'ready' });
}());
</script>
</body>
</html>`;
}

module.exports = {
    VIEW_TYPE,
    PROVIDER_SPECS,
    openSettingsPanel,
    buildState,
    testConnection,
    testArcadeDbHttp,
    testArcadeDbEmbedded
};
