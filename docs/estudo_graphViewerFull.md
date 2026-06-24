# Estudo de Viabilidade — `graphViewerFull.js` no Synesis-Explorer (v2)

**Data:** 2026-05-01
**Escopo:** Incorporar a visualização interativa atual (`graph.html.tmpl`) — com vis-network, Modo Ontologia/Evidência, abas de agrupamento, arestas bidirecionais, sidebar, dark/light, resize, degree slider, PNG export — como painel nativo do Synesis-Explorer para VSCode.
**Contexto:** Substitui o estudo anterior (2026-04-30), incorporando todas as funcionalidades adicionadas desde então.

---

## 1. Estado Atual da Visualização

A visualização gerada por `synesis2neo4j/templates/graph.html.tmpl` (via `synesis2graph.py --backend html`) tem o seguinte inventário completo de funcionalidades:

### 1.1 Constantes JSON injetadas em tempo de geração

| Constante | Tipo | Conteúdo |
|---|---|---|
| `RAW_NODES` | Array | `{id, label, color, size, font, community, extra{}}` por conceito |
| `RAW_EDGES` | Array | `{from, to, dashes, width, color, arrows, relations[], bidirectional}` |
| `ALL_GROUPINGS` | Object | `{[campo]: {title, legend[], value_to_color, value_to_cid}}` para cada `graph_field` |
| `ACTIVE_GROUPING` | String | Campo de agrupamento padrão (ex.: `"topic"`) |
| `EVIDENCE_DATA` | Object | `{[nodeId]: [{src, type, text, note}]}` |
| `EV_MENTION_EDGES` | Array | Arestas individuais de evidência (chain edges) |
| `HYPEREDGES_JSON` | Array | Polígonos de hyperedges (gerado, não desenhado por ora) |
| `STATS_TEXT` | String | Rodapé: `N nodes · M edges · K communities · X hidden` |

### 1.2 Funcionalidades de UI

| Funcionalidade | Status |
|---|---|
| Grafo vis-network (nós/arestas) | ✅ |
| Modo Ontologia (arestas agrupadas por par) | ✅ |
| Modo Evidência (arestas individuais por chain instance) | ✅ |
| Abas de agrupamento (`topic`, `aspect`, `dimension`, `confidence`) | ✅ **NOVO desde v1** |
| Arestas bidirecionais (`↔`) com indicador visual no painel | ✅ **NOVO desde v1** |
| Sidebar: search, node info, edge info, evidence table | ✅ |
| Legenda clicável (toggle visibilidade por grupo) | ✅ |
| Dark/light toggle via CSS variables | ✅ |
| Degree slider (filtro por conexões mínimas) | ✅ |
| Resize handle (arrastar borda sidebar) | ✅ |
| HUD: zoom+, zoom−, fit, lock physics, PNG export | ✅ |
| Hyperedges canvas (`afterDrawing`) | ⚠️ Gerado, não ativado |

### 1.3 Dependência externa única: vis-network CDN

```html
<script src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
```

Incompatível com CSP do VSCode webview. Solução: bundlar localmente em `media/`.

---

## 2. O Que Mudou Desde o Estudo v1

| Adição | Impacto na integração |
|---|---|
| `ALL_GROUPINGS_JSON` + abas de agrupamento | Payload levemente maior; lógica 100% no JS inline do template |
| `ACTIVE_GROUPING` placeholder | Um `str.replace` adicional no `_patchHtml`; trivial |
| Arestas bidirecionais | Apenas dado em `RAW_EDGES`; sem impacto na extensão |
| Badge `↔ bidirecional` | CSS inline; sem impacto |
| `#legend-inner` scrollável | CSS interno; sem impacto |
| `isNodeVisible` lê DataSet | JS interno; sem impacto |

**Conclusão:** Todas as adições residem no JS/CSS embutido no template. A extensão continua sendo um executor de subprocess + exibidor do HTML resultante — nenhuma nova lógica de negócio precisa ser implementada na extensão para suportar as novas funcionalidades.

---

## 3. Arquitetura Recomendada: Opção C + fallback D (reafirmada)

```
graphViewerFull.js
│
├── Ao abrir:
│   ├── graph.html já existe no workspace?
│   │   ├── SIM → exibe imediatamente (Opção D, fallback rápido)
│   │   └── NÃO → executa synesis2graph.py em background + progress notification
│
├── Ao salvar .syn/.syno/.synp/.synt → reexecuta (debounce 1 s)
│   └── Exibe HTML anterior enquanto regenera em background
│
└── WebviewPanel
    ├── HTML lido do arquivo gerado
    ├── CDN vis-network → vis-network.min.js local (patch CSP)
    ├── Nonce injetado em todos os <script> inline
    ├── acquireVsCodeApi() injetado via patch
    ├── postMessage listener adicionado via patch (theme + PNG)
    └── postMessage { command: 'setTheme', dark: bool } ao abrir
```

**Por que manter Opção C:**
- Zero duplicação de lógica de negócio
- `coderService.js` já implementa o padrão `execFile` com progress, cancellation e env — template direto para `_generate()`
- O template evolui de forma independente; a extensão apenas consome
- Custo de manutenção mínimo

---

## 4. Restrições Técnicas e Soluções

### 4.1 CSP — Substituição do CDN

```javascript
// No _patchHtml(html, webview, nonce):
html = html.replace(
    'src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"',
    `src="${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'vis-network.min.js'))}"`
);
// Injetar nonce em todos os <script> inline
html = html.replace(/<script>/g, `<script nonce="${nonce}">`);
// Injetar CSP meta tag no <head>
html = html.replace('<head>', `<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' vscode-resource:; style-src 'unsafe-inline'; img-src data: blob: vscode-resource:;">`);
```

### 4.2 PNG Export — `<a>.click()` falha em webviews

Patch no `_patchHtml` — substituir o `a.click()` final de `exportPNG()`:

```javascript
// Antes do patch: a.click();
// Após o patch:
window._vscode.postMessage({ command: 'savePNG', dataUrl: a.href, filename: a.download });
```

Na extensão (`_setupMessageHandling`):
```javascript
panel.webview.onDidReceiveMessage(async msg => {
    if (msg.command === 'savePNG') {
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(workspaceRoot, msg.filename)),
            filters: { 'PNG Image': ['png'] }
        });
        if (uri) {
            const buf = Buffer.from(msg.dataUrl.split(',')[1], 'base64');
            await vscode.workspace.fs.writeFile(uri, buf);
        }
    }
});
```

### 4.3 acquireVsCodeApi() — injetar via patch

```javascript
// Adicionado como primeira linha dentro do primeiro <script nonce="..."> inline:
const _vscode = acquireVsCodeApi();
```

### 4.4 Theme Sync — postMessage listener

Adicionado via patch ao final do HTML (antes de `</body>`):
```javascript
window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.command === 'setTheme') {
        const wantDark = msg.dark;
        if (wantDark !== !_isLight) toggleTheme();
    }
});
```

Disparado em dois momentos na extensão:
1. Imediatamente ao criar o painel (`_syncTheme()`)
2. Via `vscode.window.onDidChangeActiveColorTheme` listener

### 4.5 WebviewPanel — opções

```javascript
vscode.window.createWebviewPanel('graphViewerFull', 'Synesis Graph', column, {
    enableScripts: true,
    retainContextWhenHidden: true,   // preserva estado do grafo ao trocar abas
    localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, 'media'),
        vscode.Uri.file(workspaceRoot),
    ]
});
```

---

## 5. Componentes a Criar / Modificar

### 5.1 NOVO: `src/viewers/graphViewerFull.js`

Modelo direto: `coderService.js` (subprocess) + `graphViewer.js` (WebviewPanel).

| Método | Responsabilidade |
|---|---|
| `constructor(dataService, extensionUri, workspaceRoot)` | Setup inicial |
| `show()` | Abre/foca painel; exibe HTML existente ou dispara geração |
| `isVisible()` | Retorna `true` se painel aberto e visível |
| `scheduleRefresh(projectPath)` | Debounce 1 s → `_generate()` |
| `_generate(projectPath)` | `execFile` de `synesis2graph.py`; progress; cancellation |
| `_findProjectPath()` | `WorkspaceScanner` para localizar `.synp` |
| `_detectSynesis2graphPath()` | Auto-detecção em 4 etapas (ver §6) |
| `_patchHtml(html, webview, nonce)` | CDN→local; nonces; `acquireVsCodeApi`; PNG patch; theme listener |
| `_setupMessageHandling()` | Recebe `savePNG` → `vscode.workspace.fs.writeFile` |
| `_syncTheme()` | `panel.webview.postMessage({ command: 'setTheme', dark })` |

**Padrões reutilizados:**
- `coderService.js:213–269` → template para `_generate()` (execFile, timeout, env, cancellation)
- `graphViewer.js:465–472` → `getNonce()` (copiar ou importar)
- `graphViewer.js:416–426` → `_getMermaidUri()` → adaptar para `vis-network.min.js`

### 5.2 MODIFICAR: `extension.js`

```javascript
// 1. Instanciar (após dataService e workspaceScanner)
const graphViewerFull = new GraphViewerFull(dataService, context.extensionUri, resolvedWorkspaceRoot);

// 2. Registrar comando
context.subscriptions.push(
    vscode.commands.registerCommand('synesis.showGraphFull', () => graphViewerFull.show())
);

// 3. Refresh ao salvar (dentro do onDidSaveTextDocument handler)
if (graphViewerFull.isVisible()) {
    graphViewerFull.scheduleRefresh(resolvedProjectPath);
}

// 4. Sync de tema
context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => graphViewerFull._syncTheme())
);
```

### 5.3 MODIFICAR: `package.json`

**Novo comando:**
```json
{ "command": "synesis.showGraphFull", "title": "Show Full Relation Graph", "category": "Synesis" }
```

**Novo keybinding:**
```json
{ "command": "synesis.showGraphFull", "key": "ctrl+alt+shift+g", "when": "workspaceContains:*.synp" }
```

**Novas configurações:**
```json
"synesisExplorer.graph.pythonPath":        { "type": "string", "default": "python",
                                             "description": "Python executable for synesis2graph" },
"synesisExplorer.graph.synesis2graphPath": { "type": "string", "default": "",
                                             "description": "Path to synesis2graph.py (auto-detected if empty)" },
"synesisExplorer.graph.configPath":        { "type": "string", "default": "",
                                             "description": "Path to config.toml (auto-detected if empty)" },
"synesisExplorer.graph.minFrequency":      { "type": "number", "default": 3 },
"synesisExplorer.graph.minSourceCount":    { "type": "number", "default": 2 },
"synesisExplorer.graph.maxNodes":          { "type": "number", "default": 200 }
```

### 5.4 NOVO: `media/vis-network.min.js`

Copiar de `node_modules/vis-network/standalone/umd/vis-network.min.js` (~3 MB).
Precedente: `media/mermaid.min.js` já tem 3.2 MB — aceitável.

---

## 6. Auto-detecção do `synesis2graph.py`

Ordem de busca (implementada em `_detectSynesis2graphPath()`):

1. Setting `synesisExplorer.graph.synesis2graphPath` (configuração explícita pelo usuário)
2. Mesmo diretório do executável `synesis-lsp` (derivado de `synesisExplorer.lsp.pythonPath`)
3. `pip show synesis2neo4j --format json` → localiza o pacote instalado pelo pip
4. Fallback: busca `synesis2graph.py` no workspace aberto

Se não encontrado:
- Notificação com botão "Configurar" que abre `settings.json` na chave correta
- Contexto VSCode `synesis.graphFullAvailable = false` desabilita o comando e o keybinding

---

## 7. Fluxo do Subprocess

Baseado diretamente em `coderService._runCoderCli()`:

```javascript
// _generate(projectPath):
const child = execFile(
    pythonPath,
    [
        synesis2graphPath,
        '--project', projectPath,
        '--backend', 'html',
        '--output', outputHtmlPath,
        ...(configPath ? ['--config', configPath] : []),
        '--html-min-frequency',    String(config.minFrequency),
        '--html-min-source-count', String(config.minSourceCount),
        '--html-max-nodes',        String(config.maxNodes),
    ],
    {
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf-8',
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    },
    (error, stdout, stderr) => { /* resolve / reject */ }
);
// Cancellation:
token.onCancellationRequested(() => child.kill());
```

**Localização do output:** `workspaceRoot/graph.html` (mesmo local que a geração externa). Se o arquivo já existe, exibe imediatamente enquanto a regeneração ocorre em background.

---

## 8. Funcionalidades — Status de Portabilidade

| Funcionalidade | Portabilidade | Observação |
|---|---|---|
| Grafo vis-network | ✅ Direta | Apenas CDN → local |
| Modo Ontologia / Evidência | ✅ Direta | JS inline |
| Abas de agrupamento (NOVO) | ✅ Direta | `ALL_GROUPINGS` no JS |
| Arestas bidirecionais (NOVO) | ✅ Direta | Dado em `RAW_EDGES` |
| Sidebar completa | ✅ Direta | CSS variables |
| Dark/light toggle | ✅ Via postMessage | Sync com tema VSCode |
| Resize handle | ✅ Direta | |
| Degree slider | ✅ Direta | |
| PNG export | ⚠️ Patch necessário | `<a>.click()` → postMessage → `vscode.workspace.fs` |
| HUD (zoom, fit, lock) | ✅ Direta | |
| Hyperedges | ✅ (não ativo) | Canvas `afterDrawing`; funciona quando ativado |

---

## 9. Estimativa de Esforço

| Componente | Estimativa |
|---|---|
| `graphViewerFull.js` (subprocess + patch + WebviewPanel) | 3–4 h |
| Patch PNG export (postMessage + `vscode.workspace.fs`) | 1 h |
| Patch theme sync (listener postMessage no HTML) | 0.5 h |
| Auto-detecção do `synesis2graph.py` | 1 h |
| Adições em `extension.js` (comando, refresh, theme) | 1 h |
| Adições em `package.json` (comando, keybinding, 6 settings) | 0.5 h |
| Bundlar `vis-network.min.js` em `media/` + verificar CSP | 0.5 h |
| Testes (Basic, Thompson, Social_Acceptance) | 1.5 h |
| **Total estimado** | **~9–10 h** |

---

## 10. Riscos e Mitigações

| Risco | Prob. | Mitigação |
|---|---|---|
| `synesis2graph.py` não encontrado | Média | Auto-detecção 4 etapas; notificação com botão "Configurar" |
| Geração lenta (>5 s) em projetos grandes | Baixa | HTML anterior exibido durante regeneração em background |
| Nonce CSP falhar em algum `<script>` | Baixa | Regex `/<script>/g` abrange todos; testar com dois projetos |
| `acquireVsCodeApi()` chamado múltiplas vezes | Baixa | Injetado uma vez via patch; API segura para chamadas únicas |
| PNG data URI muito grande para postMessage | Baixa | Social_Acceptance: HTML ~1.75 MB; PNG canvas ~500 KB — dentro do limite |
| Tema VSCode divergir do toggle manual | Baixa | postMessage ao abrir + `onDidChangeActiveColorTheme` |
| `ALL_GROUPINGS_JSON` aumenta tamanho do HTML | Info | +10–20 KB; desprezível frente ao total de ~1.75 MB |
| Webview lenta com 1388 nós | Baixa | vis-network `forceAtlas2Based` + `stabilization.iterations=200` — testado com Social_Acceptance |

---

## 11. Checklist de Implementação

- [ ] Bundlar `vis-network.min.js` em `media/` (via `npm install vis-network` ou download direto)
- [ ] Criar `src/viewers/graphViewerFull.js`
  - [ ] Subprocess `_generate()` (modelo: `coderService._runCoderCli`)
  - [ ] `_patchHtml()`: CDN→local, nonces, `acquireVsCodeApi`, PNG patch, theme listener
  - [ ] `_setupMessageHandling()`: recebe `savePNG`
  - [ ] `_syncTheme()`: postMessage theme
  - [ ] `_detectSynesis2graphPath()`: auto-detecção 4 etapas
  - [ ] `scheduleRefresh()`: debounce 1 s
- [ ] Modificar `extension.js`: instância, comando, refresh trigger, theme listener
- [ ] Modificar `package.json`: comando, keybinding, 6 settings
- [ ] Testar CSP: projeto Basic (mínimo) e Social_Acceptance (máximo, ~1388 nós)
- [ ] Verificar PNG export end-to-end via `vscode.workspace.fs`
- [ ] Verificar refresh automático ao salvar `.syn` / `.syno`
- [ ] Verificar sync de tema (dark → light e vice-versa)
