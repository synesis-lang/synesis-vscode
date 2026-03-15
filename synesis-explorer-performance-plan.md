# Synesis Explorer — Estudo de Performance Baseado em Pyright

> **Objetivo:** Verificar o correto funcionamento da extensão VSCode após as otimizações no compilador (v0.4.0) e LSP (v0.14.23), identificar regex redundante que duplica funcionalidade do LSP, e propor otimizações concretas baseadas em padrões do vscode-pyright.

> **Restrição fundamental:** Nenhuma funcionalidade da extensão pode ser quebrada. As verificações devem se apoiar no LSP — regex utilizado de forma redundante na extensão deve ser marcado para remoção progressiva.

> **Coordenação com LSP e Compilador:** Este estudo se apoia nas otimizações já implementadas:
> - Compilador v0.4.0: `synesis.ast.normalize.normalize_code`, pre-indexação de field_specs, fix de comma-separated codes
> - Compilador v0.4.1: `to_cli_line()` em todas as 57 subclasses `ValidationError`; +38 novos tipos de erro (Fases 1–4 do plano de erros) propagados automaticamente via `converters.build_diagnostics()` — sem impacto na extensão
> - Compilador v0.4.2: Fix do bloco `GUIDELINES` — keywords dentro do bloco não causam mais falha de parse; gramática expandida + `synesis_standalone.py` regenerado
> - LSP v0.14.23: Debounce (Fase 1), dirty flags (Fase 2), fingerprint leve (Fase 3), cache de providers (Fase 4), revalidação deferida (Fase 5), cancelamento de tasks (Fase 6), pre-filtro de ontology annotations (Fase 7), consolidação de `_normalize_code` (Fase 0)
> - LSP v0.14.24: Novos diagnósticos do compilador propagados (erros de template, semântica, cross-entity e estrutura de projeto) — requer `synesis >= 0.4.1`; sem alteração de código no LSP
> - LSP v0.14.26: Fix crítico de document symbols (`_make_block_range` cobre bloco inteiro); `lsp_version`/`compiler_version` incluídos no retorno de `loadProject`
> - LSP v0.14.27: Fix grafo em cursor ITEM (range SOURCE expandido para incluir children); fix `AttributeError WindowsPath` em `getOntologyAnnotations`

> **Status das Fases (2026-03-15):**
> - **Bug 2.6 (fallback synesisClient):** ✅ Corrigido em v0.5.18 — `_isMethodNotFound(error)` na condição do catch em `_actualSendRequest`
> - **Fase 1 (Debounce factory + refresh seletivo):** ✅ Implementada em v0.5.12 — `Debouncer` class, `FILE_REFRESH_MAP`, `refreshExplorersForFileType()` em `extension.js`
> - **Fase 2 (Cache + deduplicação LSP):** ✅ Implementada em v0.5.13 — `_responseCache`, `_inFlightRequests`, `invalidateCache()` em `synesisClient.js`; `invalidateCache()` chamado antes de cada `loadProject` em `extension.js`
> - **Fase 3 (Remover fallback graphViewer):** ✅ Implementada em v0.5.14 — `_findBibrefLocal()` removido; `_findBibref()` usa LSP exclusivamente; LSP indisponível exibe warning em `graphViewer.js`
> - **Fase 4 (LSP getExcerpts):** ✅ Implementada em v0.5.15 (LSP v0.14.25) — `get_excerpts()` em `explorer_requests.py`, `cmd_get_excerpts` em `server.py`; `_buildExcerptsFromLspItems()` + fallback `_extractExcerptsLocal()` em `abstractViewer.js`
> - **Fase 5 (Mermaid local + CSP):** ✅ Implementada em v0.5.16 — `media/mermaid.min.js` local, CSP com nonce, sem Inter CDN; fallback CDN mantido se `extensionUri` indisponível
> - **Fase 6 (esbuild minify):** ✅ Implementada em v0.5.17 — `minify: !isWatch` em `esbuild.js`

---

## Sumário Executivo

A extensão synesis-explorer (v0.5.11) é um client VSCode que consome dados do synesis-lsp via 6 métodos customizados e expõe 5 tree views, 2 webviews e 30+ comandos. A extensão já possui boas práticas: debounce de file watchers, hash-based change detection nos explorers, e padrão LSP-first com fallback local. No entanto, existem **8 bottlenecks** identificados que causam trabalho redundante: refresh de todos os explorers a cada salvamento, regex-based parsing local que duplica funcionalidade LSP, ausência de cache e deduplicação de requests LSP, e loading de Mermaid.js via CDN. Este estudo propõe **6 otimizações** em fases independentes que eliminam redundância mantendo 100% da funcionalidade existente.

---

## PARTE I — Arquitetura do Pyright Extension (Referência)

### 1.1 Visão Geral da Extensão Pyright

O vscode-pyright é uma extensão de alta performance que implementa padrões avançados para minimizar latência e uso de recursos:

| Pilar | Mecanismo | Aplicação |
|-------|-----------|-----------|
| **Lazy Activation** | `onLanguage:python` + `onView:*` | Extensão só carrega quando necessário |
| **Request Management** | Deduplicação, cancelamento, timeout | Evita requests duplicados ao LSP |
| **Smart Caching** | Cache por documento com invalidação | Evita recomputação de dados idênticos |
| **Bundling Otimizado** | webpack com minification + tree-shaking | Bundle mínimo, cold-start rápido |

### 1.2 Activation Patterns

**Pyright:** Usa `onLanguage:python` para ativação lazy. Tree views registrados via `onView:` activation events — tree views só são criados quando o painel é aberto pela primeira vez.

**Synesis Explorer:** Usa `workspaceContains:*.synp` (bom — lazy). Porém, todos os 5 tree views são criados imediatamente no `activate()`, mesmo que o usuário não abra o painel lateral.

### 1.3 LSP Client Patterns

**Pyright:** O client LSP do Pyright implementa:
- **Request deduplication:** Requests idênticos em voo são coalescidos
- **Request cancellation:** Requests obsoletos são cancelados quando novos chegam
- **Timeout management:** Requests com timeout configurável para evitar hangs
- **Batch notifications:** File change notifications agrupadas antes de envio

**Synesis Explorer:** O `SynesisLspClient` (167 linhas) é simples:
- Sem deduplicação — cada `explorer.refresh()` faz call separado
- Sem timeout — request pode bloquear indefinidamente
- Sem batching — cada `onDidSaveTextDocument` agenda reload independente
- Cache mínimo — apenas `lastLoadProjectResult` é guardado

### 1.4 Tree View Patterns

**Pyright:** Usa virtualização para datasets grandes, expande nós sob demanda, e implementa `resolveTreeItem` para lazy-load de detalhes.

**Synesis Explorer:** Boa prática existente:
- Hash-based change detection (`_hashData()`) evita re-renders desnecessários
- Children expandidos on-demand (collapsible state)
- Filtragem client-side com `toLowerCase().includes(filter)`

### 1.5 Bundling

**Pyright:** webpack com minification, tree-shaking, source maps separados para produção.

**Synesis Explorer:** esbuild sem minification (`sourcemap: true` mas sem `minify: true`). Bundle funcional mas não otimizado para produção.

---

## PARTE II — Diagnóstico da Extensão Synesis Explorer

### 2.1 Arquitetura Atual

```
synesis-explorer/
├── extension.js                          # Entry point (1040 linhas)
├── src/
│   ├── lsp/
│   │   └── synesisClient.js             # LSP client wrapper (167 linhas)
│   ├── services/
│   │   └── dataService.js               # LSP adapter + normalization (444 linhas)
│   ├── explorers/
│   │   ├── reference/referenceExplorer.js   # TreeDataProvider — bibrefs
│   │   ├── code/codeExplorer.js             # TreeDataProvider — codes
│   │   ├── relation/relationExplorer.js     # TreeDataProvider — chains
│   │   └── ontology/
│   │       ├── ontologyExplorer.js          # TreeDataProvider — topic hierarchy
│   │       └── ontologyAnnotationExplorer.js # TreeDataProvider — codes no arquivo ativo
│   ├── viewers/
│   │   ├── graphViewer.js               # Webview Mermaid (548 linhas)
│   │   └── abstractViewer.js            # Webview BibTeX abstract (806 linhas)
│   ├── parsers/                         # Parsers regex locais (fallback)
│   │   ├── synesisParser.js             # SOURCE/ITEM blocks via regex (226 linhas)
│   │   ├── bibtexParser.js              # BibTeX entries (65 linhas)
│   │   ├── templateParser.js            # .synt FIELD definitions (123 linhas)
│   │   ├── chainParser.js               # CHAIN field split
│   │   └── ontologyParser.js            # .syno structure
│   ├── core/
│   │   ├── projectLoader.js             # .synp loading + path resolution (200 linhas)
│   │   ├── templateManager.js           # Template cache + field registry
│   │   ├── fieldRegistry.js             # Field definitions registry
│   │   └── workspaceScanner.js          # File discovery (288 linhas)
│   └── utils/
│       ├── fuzzyMatcher.js              # Excerpt matching no abstract
│       ├── mermaidUtils.js              # Mermaid diagram utilities
│       └── positionUtils.js             # Line/column conversion
```

### 2.2 Fluxo de Dados LSP → UI

```
LSP Server (synesis-lsp v0.14.23)
  ↓ stdio
SynesisLspClient.sendRequest(method, params)
  ↓ workspace/executeCommand (fallback: direct sendRequest)
DataService._callLsp(method) → normalização (line → 0-based, paths → absolute)
  ↓
Explorer.refresh() → _hashData() → se mudou: rebuild Map → fire()
  ↓
TreeDataProvider.getChildren() → filtra + ordena → TreeItems
  ↓
VSCode renderiza tree view
```

### 2.3 Métodos LSP Customizados

| Método LSP | DataService | Explorer | Fallback Legacy |
|-----------|-------------|----------|-----------------|
| `synesis/loadProject` | — | (trigger global) | — |
| `synesis/getReferences` | `getReferences()` | ReferenceExplorer | `synesis/get_references` |
| `synesis/getCodes` | `getCodes()` | CodeExplorer | `synesis/get_codes` |
| `synesis/getRelations` | `getRelations()` | RelationExplorer | `synesis/get_relations` |
| `synesis/getRelationGraph` | `getRelationGraph()` | GraphViewer | `synesis/get_relation_graph` |
| `synesis/getOntologyTopics` | `getOntologyTopics()` | OntologyExplorer | `synesis/get_ontology_topics` |
| `synesis/getOntologyAnnotations` | `getOntologyAnnotations()` | OntologyAnnotationExplorer | `synesis/get_ontology_annotations` |

### 2.4 O que já está BOM (não mexer)

| Componente | Arquivo | Por que é bom |
|------------|---------|---------------|
| Hash-based change detection | Todos os explorers | `_hashData()` evita re-render se dados idênticos |
| LSP-first com fallback | `graphViewer.js` | `_findBibrefViaLsp()` tenta LSP primeiro, cai em regex local |
| Debounce de file watcher | `extension.js:179-183` | 300ms para refresh, 1000ms para loadProject |
| Lazy activation | `package.json` | `workspaceContains:*.synp` — não carrega sem projeto |
| Panel reuse | `graphViewer.js:62-78` | Reutiliza webview panel existente |
| Context-aware refresh | `extension.js:544-549` | Só ontology annotations refresha ao mudar editor |
| Legacy method fallback | `dataService.js:37-54` | Snake_case fallback para LSP antigos |

### 2.5 Os 8 Bottlenecks Identificados

#### Bottleneck #1: Refresh de TODOS os explorers a cada file save (IMPACTO: ALTO)

**Arquivo:** `extension.js`, linhas 170-176, 217-218

```javascript
const refreshAllExplorers = () => {
    referenceExplorer.refresh();    // → LSP getCodes
    codeExplorer.refresh();         // → LSP getReferences
    relationExplorer.refresh();     // → LSP getRelations
    ontologyExplorer.refresh();     // → LSP getOntologyTopics
    ontologyAnnotationExplorer.refresh(); // → LSP getOntologyAnnotations
};
```

**Problema:** Ao salvar qualquer arquivo `.syn/.syno/.synp/.synt/.bib`, o ciclo é:
1. `onDidSaveTextDocument` → `scheduleLspLoadProject` (1000ms debounce)
2. `runLspLoadProject` → `synesis/loadProject`
3. Se sucesso → `refreshAllExplorers()` → **5 LSP calls simultâneos**

Para projeto Social Acceptance (1614 items, 1388 codes), são 5 requests paralelos ao LSP, cada um processando o projeto inteiro. Se o usuário editou apenas um `.syn`, todos os explorers recebem os mesmos dados que já tinham (hash check impede re-render, mas os dados já foram buscados e transferidos).

**Desperdício estimado:** ~80% dos requests LSP em cenário típico (edição de `.syn` não muda topologia de codes/relations).

---

#### Bottleneck #2: Timer de debounce único compartilhado (IMPACTO: MÉDIO)

**Arquivo:** `extension.js`, linhas 179-183

```javascript
let refreshDebounceTimer;
const debouncedRefresh = (refreshFn, delay = 300) => {
    clearTimeout(refreshDebounceTimer);
    refreshDebounceTimer = setTimeout(refreshFn, delay);
};
```

**Problema:** Há um **único** `refreshDebounceTimer` compartilhado por todas as chamadas a `debouncedRefresh`. Se `onDidChangeActiveTextEditor` dispara refresh de ontology annotations (delay=200ms) e logo depois `onDidSaveTextDocument` dispara o mesmo timer com outro callback, o `clearTimeout` cancela o refresh anterior.

Na prática, o timer é usado apenas por `onDidChangeActiveTextEditor` para ontology annotations. O save handler usa `scheduleLspLoadProject` com timer separado (`lspLoadTimer`). Mas o design é frágil — qualquer futuro uso de `debouncedRefresh` pode causar cancelamento cruzado.

---

#### Bottleneck #3: Sem deduplicação de requests LSP (IMPACTO: MÉDIO)

**Arquivo:** `synesisClient.js`, linhas 97-127

**Problema:** Se o usuário salva 3 arquivos rapidamente (ex: Ctrl+S em múltiplas tabs), mesmo com debounce de 1000ms, cada save pode disparar um `loadProject` separado. O `scheduleLspLoadProject` tem debounce, mas `refreshAllExplorers` chamado após `loadProject` dispara 5 requests sem qualquer deduplicação:

```
loadProject retorna → refreshAllExplorers():
  getCodes()           ← request 1 (in-flight)
  getReferences()      ← request 2 (in-flight)
  getRelations()       ← request 3 (in-flight)
  getOntologyTopics()  ← request 4 (in-flight)
  getOntologyAnnotations() ← request 5 (in-flight)
```

Se outro `loadProject` disparar 500ms depois, novos 5 requests serão enviados enquanto os anteriores podem ainda estar em voo.

---

#### Bottleneck #4: abstractViewer parseia TODOS os .syn localmente (IMPACTO: ALTO)

**Arquivo:** `abstractViewer.js`, linhas 137-236

```javascript
async _extractExcerpts(bibref, projectUri) {
    const synFiles = await this.scanner.findSynFiles(projectUri);
    for (const fileUri of synFiles) {
        const content = await vscode.workspace.fs.readFile(fileUri);  // ← I/O por arquivo
        const text = content.toString();
        const items = this.parser.parseItems(text, filePath);         // ← regex parse
        const filtered = items.filter(item => item.bibref === bibref);
        // ... extract excerpts from filtered items
    }
}
```

**Problema:** Para cada invocação de "Show Abstract":
1. Descobre todos os `.syn` do projeto via `workspaceScanner.findSynFiles()`
2. Lê **cada arquivo** do disco (`vscode.workspace.fs.readFile`)
3. Parseia **cada arquivo** com regex (`synesisParser.parseItems`)
4. Filtra items pelo bibref desejado

Para Social Acceptance (1 arquivo .syn de 18K linhas), o impacto é moderado. Mas para projetos com múltiplos arquivos .syn, o custo escala linearmente: N arquivos × (I/O + regex parse).

O LSP **já tem** todos os items parseados e indexados em memória (via `loadProject`). Uma nova LSP method `synesis/getExcerpts` eliminaria toda esta computação local.

---

#### Bottleneck #5: Sem cache de responses no LSP client (IMPACTO: MÉDIO)

**Arquivo:** `synesisClient.js`

**Problema:** Cada chamada a `sendRequest` vai diretamente ao LSP server. Se dois explorers pedem `getCodes()` e `getReferences()` consecutivamente, ambos resultam em chamadas reais ao LSP, mesmo que os dados não tenham mudado desde a última chamada.

O LSP já tem caches internos (Fase 4: `_SYMBOLS_CACHE`, `_TOKENS_CACHE`, `_CODES_CACHE`), mas a comunicação stdio tem overhead de serialização/deserialização JSON que poderia ser evitado com cache client-side.

---

#### Bottleneck #6: Dados buscados do LSP mesmo sem mudança (IMPACTO: BAIXO)

**Arquivo:** Todos os explorers

**Problema:** O padrão de hash check é pós-fetch:

```javascript
async refresh() {
    const codes = await this.dataService.getCodes();  // ← SEMPRE busca do LSP
    const newHash = this._hashData(codes);
    if (newHash === this._lastDataHash) {
        return;  // ← dados não mudaram, mas já foram transferidos
    }
    // ... rebuild tree
}
```

O hash check evita o rebuild da tree (bom), mas os dados já foram transferidos via stdio. Com cache client-side (Bottleneck #5), este problema seria eliminado.

---

#### Bottleneck #7: Mermaid.js carregado via CDN (IMPACTO: BAIXO)

**Arquivo:** `graphViewer.js`, linha 92

```html
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
```

**Problemas:**
1. **Dependência de rede:** Não funciona offline
2. **Sem Content-Security-Policy (CSP):** Scripts de CDN sem nonce são risco de segurança
3. **Latência:** Cada abertura de graph baixa ~200KB (gzipped) do CDN
4. **Font externa:** `https://rsms.me/inter/inter.css` — outra dependência de rede

---

#### Bottleneck #8: synesisParser como fallback redundante com LSP (IMPACTO: BAIXO-MÉDIO)

**Arquivos:** `graphViewer.js:429-462`, `abstractViewer.js:589-610`

**Problema:** O `synesisParser.js` usa regex pesado para parsear blocos SOURCE e ITEM:

```javascript
// synesisParser.js:49 — regex para SOURCE blocks
const sourcePattern = /SOURCE\s+(@[\p{L}\p{N}._-]+)(.*?)END\s+SOURCE/gsu;

// synesisParser.js:100 — regex para ITEM blocks
const itemPattern = /ITEM\s+(@[\p{L}\p{N}._-]+)(.*?)END\s+ITEM/gsu;
```

Estes regexes são aplicados ao conteúdo completo do documento. Para arquivos grandes (78K linhas Thompson, 489K linhas Nave), o custo de regex `.exec()` com flags `gsu` e lazy `(.*?)` é significativo.

O LSP já fornece `documentSymbols` que contém a mesma informação de forma estruturada. O `graphViewer` já usa LSP como caminho primário (`_findBibrefViaLsp`) — o fallback local deveria ser desnecessário com o LSP estável.

---

### 2.6 Bug Identificado: Fallback Incorreto no synesisClient Mascara Erros de Runtime

#### Sintoma

```
Synesis LSP does not support "synesis/getOntologyAnnotations".
Update synesis-lsp to v0.13.0+ or adjust synesisExplorer.lsp.pythonPath.
```

Este warning aparece mesmo com LSP v0.14.23 que **registra corretamente** o comando `synesis/getOntologyAnnotations`.

#### Causa Raiz

**Arquivo:** `synesisClient.js`, linhas 106-120

```javascript
let result;
try {
    if (this._isSynesisMethod(method)) {
        result = await this._sendExecuteCommand(method, params);  // ← via workspace/executeCommand
    }
} catch (error) {
    if (this._isSynesisMethod(method)) {
        // Fallback to direct request if executeCommand failed for any reason.
        result = await this.client.sendRequest(method, params);   // ← fallback INCORRETO
    } else {
        throw error;
    }
}
```

**O problema em 3 passos:**

1. `_sendExecuteCommand('synesis/getOntologyAnnotations', params)` envia via `workspace/executeCommand`. Se o **handler Python** do comando lança uma exceção de runtime (ex: `TypeError`, `KeyError`, erro no `_get_cached_for_workspace`), pygls retorna um erro JSON-RPC que **NÃO é** `-32601 Method Not Found` — é um erro genérico.

2. O `catch` no synesisClient captura **qualquer** erro (não filtra por código) e faz fallback para `this.client.sendRequest('synesis/getOntologyAnnotations', params)` — um **request direto**. Porém, pygls registrou `synesis/getOntologyAnnotations` como **command** (`@server.command`), não como **request handler** (`@server.feature`). Então o request direto falha com `-32601 Method Not Found`.

3. Este segundo erro (`-32601`) propaga para `dataService._callLsp()` → `_isMethodNotFound()` retorna `true` → `unsupportedMethods.add('getOntologyAnnotations')` → `_warnUnsupported()` mostra o warning enganoso "LSP does not support".

**Resultado:** Um erro de runtime no handler Python é **mascarado** como "método não suportado", impedindo o diagnóstico correto.

**Agravante:** Uma vez que o método é adicionado a `unsupportedMethods` (Set), ele permanece lá pelo resto da sessão. Todas as chamadas subsequentes a `_callLsp('getOntologyAnnotations')` retornam `[]` sem sequer tentar o LSP (linha 342: `if (this.unsupportedMethods.has(method))`). O Ontology Annotations explorer fica **permanentemente sem dados** até reiniciar a extensão.

#### Fix Proposto

```javascript
// synesisClient.js — Corrigir fallback para só acionar em "Method Not Found"
try {
    if (this._isSynesisMethod(method)) {
        result = await this._sendExecuteCommand(method, params);
    } else {
        result = await this.client.sendRequest(method, params);
    }
} catch (error) {
    if (this._isSynesisMethod(method) && this._isMethodNotFound(error)) {
        // Fallback to direct request ONLY if executeCommand itself is not supported
        result = await this.client.sendRequest(method, params);
    } else {
        throw error;  // ← Propagar erro real (runtime error no handler)
    }
}
```

**Mudança:** Adicionar `&& this._isMethodNotFound(error)` na condição do catch. Erros de runtime no handler agora propagam corretamente ao invés de serem mascarados.

#### Arquivos Afetados
- `synesisClient.js` — Condição do catch no `sendRequest()`

#### Verificação
1. Forçar erro de runtime no handler `cmd_get_ontology_annotations` (ex: `raise ValueError("test")`)
2. Verificar que a extensão mostra o erro REAL, não "method not supported"
3. Com LSP funcionando normalmente → nenhum warning
4. Com LSP antigo (sem o comando) → warning "method not supported" funciona corretamente

---

### 2.7 Fluxo Atual vs. Fluxo Ideal

```
FLUXO ATUAL (salvar um .syn com 5 explorers):
═══════════════════════════════════════════════════════════════
onDidSaveTextDocument(.syn)
  → scheduleLspLoadProject (1000ms debounce)
  → [1000ms depois]
    → synesis/loadProject                        ← LSP call 1
    → refreshAllExplorers():
      → getCodes()                               ← LSP call 2
      → getReferences()                          ← LSP call 3
      → getRelations()                           ← LSP call 4
      → getOntologyTopics()                      ← LSP call 5
      → getOntologyAnnotations()                 ← LSP call 6
    → cada explorer: _hashData() → dados idênticos → skip render
  ← Total: 6 LSP calls, 5 provavelmente desnecessários

Show Abstract (Social Acceptance):
  → workspaceScanner.findSynFiles()              ← glob
  → readFile(social_acceptance.syn)              ← I/O (18K linhas)
  → synesisParser.parseItems()                   ← regex parse completo
  → filter items by bibref
  ← Total: ~200ms de I/O + regex para dados que o LSP já tem

═══════════════════════════════════════════════════════════════
FLUXO IDEAL (após otimizações):
═══════════════════════════════════════════════════════════════
onDidSaveTextDocument(.syn)
  → scheduleLspLoadProject (1000ms debounce)
  → [1000ms depois]
    → synesis/loadProject                        ← LSP call 1
    → refreshAllExplorers():
      → getCodes() → client cache HIT (TTL 5s)  ← 0 calls
      → ... (hash + cache check, 0 LSP calls)
  ← Total: 1 LSP call (loadProject)

Show Abstract:
  → synesis/getExcerpts(bibref)                  ← 1 LSP call (dados já em memória)
  ← Total: ~5ms
```

---

## PARTE III — Auditoria de Regex na Extensão

### 3.1 Inventário Completo de Regex

#### Categoria 1: MANTER — HTML/Mermaid Escaping (Segurança)

| Arquivo | Linha | Padrão | Propósito |
|---------|-------|--------|-----------|
| `graphViewer.js` | 471-475 | `/&/g`, `/</g`, `/>/g`, `/"/g`, `/'/g` | HTML entity escaping para webview |
| `abstractViewer.js` | 798-802 | `/&/g`, `/</g`, `/>/g`, `/"/g`, `/'/g` | HTML entity escaping para webview |
| `mermaidUtils.js` | 45-49 | `/"/g`, `/\[/g`, `/]/g`, `/\|/g`, `/[<>(){}#]/g` | Mermaid diagram escaping |
| `mermaidUtils.js` | 12 | `/[^\p{L}\p{N}_]/gu` | Node ID sanitization |
| `mermaidUtils.js` | 17 | `/^\d/` | Teste se começa com dígito |

**Justificativa:** Sanitização de input é responsabilidade do client, não do LSP. Indispensável para segurança de webviews.

---

#### Categoria 2: MANTER — Features Locais (sem equivalente LSP)

| Arquivo | Linha | Padrão | Propósito | Por que LSP não serve |
|---------|-------|--------|-----------|----------------------|
| `projectLoader.js` | 73 | `/^\s*PROJECT\b([^\n]*)/mi` | Extrair header PROJECT | ProjectLoader é feature local da extensão |
| `projectLoader.js` | 76 | `/PROJECT\b[^\n]*\n([\s\S]*?)END\s+PROJECT/mi` | Extrair bloco PROJECT | Idem |
| `projectLoader.js` | 150 | `/^\s*INCLUDE\s+([A-Z_]+).../gmi` | Parse INCLUDE directives | Idem |
| `projectLoader.js` | 164 | `new RegExp(\`${blockName}...\`, 'i')` | Extração genérica de blocos | Idem |
| `templateParser.js` | 26 | `/FIELD\s+([\p{L}_]...)\s+TYPE\s+([\p{L}\p{N}_-]+)([\s\S]*?)END\s+FIELD/gu` | Parse FIELD definitions | TemplateManager é local |
| `templateParser.js` | 50 | `/SCOPE\s+([\p{L}\p{N}_-]+)/u` | Extract SCOPE | Idem |
| `templateParser.js` | 55 | `/RELATIONS([\s\S]*?)END\s+RELATIONS/` | Extract RELATIONS block | Idem |
| `templateParser.js` | 70 | `/^([\p{L}\p{N}._-]+)\s*:/u` | Parse relation definitions | Idem |
| `templateParser.js` | 80 | `/ARITY\s*(>=\|<=\|=\|>\|<)\s*(\d+)/` | Parse ARITY constraint | Idem |
| `templateParser.js` | 92 | `/VALUES([\s\S]*?)END\s+VALUES/` | Extract VALUES block | Idem |
| `templateParser.js` | 107 | `/^(?:\[(\d+)\]\s*)?([\p{L}\p{N}._-]+)\s*:\s*(.+)$/u` | Parse value definition | Idem |
| `bibtexParser.js` | 56 | `/[\p{L}\p{N}._-]+/u` | Normalizar bibref key | BibTeX parsing é local |
| `ontologyParser.js` | 110 | `/^([\p{L}\p{N}._-]+)\s*:\s*(.*)$/u` | Parse ontology field entries | Usado por templateManager |
| `abstractViewer.js` | 614 | `/\s+/g` | Normalizar excerpt | Feature de highlight local |
| `abstractViewer.js` | 781 | `/[{}]/g` | Remover braces BibTeX | Feature de display local |
| `abstractViewer.js` | 782 | `/\s+/g` | Colapsar whitespace | Idem |
| `fuzzyMatcher.js` | 116 | `/[\p{L}\p{N}]/u` | Teste char alfanumérico | Matching local |
| `fuzzyMatcher.js` | 120 | `/\s/` | Teste whitespace | Idem |

**Justificativa:** Estas regex servem features que operam localmente (project loading, template parsing, abstract display, fuzzy matching). O LSP não expõe estas funcionalidades e não deve expor — são responsabilidade do client.

---

#### Categoria 3: MANTER — Utilidades Necessárias

| Arquivo | Linha | Padrão | Propósito |
|---------|-------|--------|-----------|
| `positionUtils.js` | 41 | `/[.*+?^${}()\|[\]\\]/g` | Escape de regex special chars |
| `positionUtils.js` | 46-48 | `new RegExp(\`^\\s*${escapedName}\\s*:...\`, 'gmu')` | Encontrar valor de field em bloco |
| `positionUtils.js` | 63 | `new RegExp(\`(^[\|[^\\p{L}...](${escaped})...)\`, 'u')` | Encontrar token com word boundaries |
| `synesisClient.js` | 23 | `/^"(.*)"$/`, `/^'(.*)'$/` | Strip quotes de config path |
| `synesisClient.js` | 29 | `/\s+/` | Split args do LSP |
| `synesisClient.js` | 134 | `/Method Not Found/i` | Detectar erro de método LSP |
| `dataService.js` | 34 | `/Method Not Found/i` | Detectar erro de método LSP |
| `workspaceScanner.js` | 255 | `/[*?[\]]/` | Detectar glob patterns em path |

**Justificativa:** Utilities genéricos indispensáveis para operação da extensão.

---

#### Categoria 4: DEPRECAR — Redundante com LSP (graphViewer)

| Arquivo | Linha | Padrão | Propósito | Alternativa LSP |
|---------|-------|--------|-----------|-----------------|
| `graphViewer.js` | 450 | `/@[\w._-]+/` | Extrair bibref inline | LSP `documentSymbols` (já usado como primário) |
| `graphViewer.js` | 545 | `/@[\w._-]+/` | Extrair bibref de symbol name | LSP `documentSymbols` |
| `synesisParser.js` | 49 | `/SOURCE\s+(@[\p{L}\p{N}._-]+)(.*?)END\s+SOURCE/gsu` | Parse SOURCE blocks | LSP `documentSymbols` |
| `synesisParser.js` | 100 | `/ITEM\s+(@[\p{L}\p{N}._-]+)(.*?)END\s+ITEM/gsu` | Parse ITEM blocks | LSP `documentSymbols` |
| `synesisParser.js` | 155 | `/^([\p{L}\p{N}._-]+)\s*:\s*(.*)$/u` | Parse field: value pairs | LSP (dados já parseados) |
| `synesisParser.js` | 219 | `new RegExp(\`ITEM\\s+${...}\`, 'gu')` | Contar ITEMs por bibref | LSP (dados já contados) |

**Status:** O `graphViewer._findBibref()` já usa LSP como caminho primário. O fallback local (`_findBibrefLocal`) existe para quando LSP não está pronto. Com LSP v0.14.23 estável, o fallback pode ser simplificado para apenas regex inline (`/@[\w._-]+/`) sem parse completo de blocos SOURCE/ITEM.

**Recomendação (Fase 3):**
- Remover `_findBibrefLocal()` de `graphViewer.js`
- Manter apenas `_findBibrefViaLsp()` como caminho único
- Se LSP não disponível, mostrar mensagem ao invés de fallback silencioso

---

#### Categoria 5: FUTURO — Substituível por nova LSP method (abstractViewer)

| Arquivo | Linha | Padrão | Propósito | Alternativa Futura |
|---------|-------|--------|-----------|-------------------|
| `abstractViewer.js` | 589-610 | `synesisParser.parseItems()` + `synesisParser.parseSourceBlocks()` | `_findBibref()` local | Nova LSP method `synesis/getBibrefAtPosition` |
| `abstractViewer.js` | 137-236 | `synesisParser.parseItems()` | `_extractExcerpts()` — parse ALL .syn files | Nova LSP method `synesis/getExcerpts` |

**Status:** `abstractViewer._extractExcerpts()` é o maior consumidor de regex local. Lê todos os .syn, parseia todos os ITEM blocks, filtra por bibref, extrai fields (quotation, memo, chain, code). O LSP já tem todos estes dados em memória após `loadProject`. Uma nova method eliminaria todo o I/O e regex.

**Recomendação (Fase 4):** Implementar `synesis/getExcerpts(bibref)` no LSP que retorne:
```json
{
    "excerpts": [
        {
            "text": "excerpt text",
            "note": "memo text",
            "chain": "A -> B -> C",
            "codes": ["CODE1", "CODE2"],
            "line": 42,
            "file": "/path/to/file.syn"
        }
    ]
}
```

---

### 3.2 Resumo da Auditoria

```
Total de regex patterns identificados:  ~45
├── MANTER (segurança/escaping):         5
├── MANTER (features locais):           18
├── MANTER (utilidades):                 8
├── DEPRECAR (redundante com LSP):       6 ← graphViewer fallback
└── FUTURO (substituível por LSP):       2 ← abstractViewer
                                         6 removíveis a curto prazo
```

**Impacto da remoção dos 6 regex deprecáveis:**
- `graphViewer.js`: Remover `_findBibrefLocal()` (33 linhas) e simplificar fluxo
- `synesisParser.js`: Se graphViewer não usar mais, avaliar se abstractViewer é o único consumer
  - Se sim, synesisParser fica usado APENAS por abstractViewer (candidato a remoção quando Fase 4 implementada)

---

## PARTE IV — Otimizações em Fases Independentes

### Fase 1: Debounce Factory + Refresh Seletivo por Tipo de Arquivo

> **Impacto:** ALTO | **Risco:** MUITO BAIXO | **Esforço:** 1h

**O que:** Substituir o debounce timer único por factory de debouncers independentes. Implementar refresh seletivo baseado no tipo de arquivo salvo.

**Por que:** Atualmente, salvar qualquer `.syn/.syno/.synp/.synt/.bib` dispara `refreshAllExplorers()` (5 LSP calls). Mas:
- Salvar `.syn` → só precisa atualizar References, Codes e OntologyAnnotations
- Salvar `.syno` → só precisa atualizar OntologyExplorer e OntologyAnnotations
- Salvar `.synt` → precisa atualizar todos (mudou template)
- Salvar `.bib` → só precisa atualizar References
- Salvar `.synp` → precisa atualizar todos (mudou projeto)

**Padrão Pyright:** Debounce por categoria de evento, não timer global.

**Como implementar:**

```javascript
// extension.js — Debounce factory
class Debouncer {
    constructor(delay = 300) {
        this.delay = delay;
        this.timer = null;
    }
    run(fn) {
        clearTimeout(this.timer);
        this.timer = setTimeout(fn, this.delay);
    }
    cancel() {
        clearTimeout(this.timer);
    }
}

// Debouncer separado para cada contexto
const editorChangeDebouncer = new Debouncer(200);
const lspLoadDebouncer = new Debouncer(1000);

// Refresh seletivo por tipo de arquivo
const FILE_REFRESH_MAP = {
    '.syn':  ['reference', 'code', 'ontologyAnnotation'],
    '.syno': ['ontology', 'ontologyAnnotation'],
    '.synt': ['all'],  // template muda tudo
    '.bib':  ['reference'],
    '.synp': ['all'],  // projeto muda tudo
};

function refreshExplorersForFileType(ext) {
    const targets = FILE_REFRESH_MAP[ext] || ['all'];
    if (targets.includes('all')) {
        refreshAllExplorers();
        return;
    }
    if (targets.includes('reference')) referenceExplorer.refresh();
    if (targets.includes('code')) codeExplorer.refresh();
    if (targets.includes('relation')) relationExplorer.refresh();
    if (targets.includes('ontology')) ontologyExplorer.refresh();
    if (targets.includes('ontologyAnnotation')) ontologyAnnotationExplorer.refresh();
}
```

**Arquivos afetados:**
- `extension.js` — Substituir `debouncedRefresh` + `scheduleLspLoadProject`, adicionar `refreshExplorersForFileType`

**Verificação:**
1. Abrir Social Acceptance no VSCode. Editar `.syn`, salvar → verificar que OntologyExplorer **não** refreshou
2. Editar `.synt`, salvar → verificar que TODOS refresharam
3. Editar `.bib`, salvar → verificar que apenas ReferenceExplorer refreshou
4. Logs: contar número de calls LSP em cada cenário

**O que NÃO pode quebrar:**
- Todos os explorers devem continuar mostrando dados corretos
- Refresh manual via comando deve continuar funcionando
- Debounce não deve cancelar callbacks de contextos diferentes

---

### Fase 2: Cache de Responses LSP + Deduplicação de Requests

> **Impacto:** ALTO | **Risco:** BAIXO | **Esforço:** 2h

**O que:** Adicionar cache com TTL no `SynesisLspClient` para responses LSP. Implementar deduplicação de requests em voo.

**Por que:** Após `loadProject`, o LSP já cacheou todos os dados (Fase 4 do LSP). As 5 chamadas de `refreshAllExplorers()` recebem dados que não mudaram desde o último `loadProject`. Com cache client-side de 5-10 segundos TTL, apenas o primeiro request após invalidação vai ao LSP.

**Padrão Pyright:** Request deduplication + cache por document version.

**Como implementar:**

```javascript
// synesisClient.js — Adicionar cache layer
class SynesisLspClient {
    constructor() {
        // ... existente ...
        this._responseCache = new Map();    // method:params → { result, expiry }
        this._inFlightRequests = new Map(); // method:params → Promise
        this._cacheTTL = 5000;              // 5 segundos
    }

    async sendRequest(method, params) {
        // ... existing ready check ...

        const cacheKey = `${method}:${JSON.stringify(params || {})}`;

        // 1. Check cache
        const cached = this._responseCache.get(cacheKey);
        if (cached && cached.expiry > Date.now()) {
            return cached.result;
        }

        // 2. Deduplication: coalesce with in-flight request
        const inFlight = this._inFlightRequests.get(cacheKey);
        if (inFlight) {
            return inFlight;
        }

        // 3. New request
        const promise = this._actualSendRequest(method, params)
            .then(result => {
                // Cache result
                this._responseCache.set(cacheKey, {
                    result,
                    expiry: Date.now() + this._cacheTTL
                });
                return result;
            })
            .finally(() => {
                this._inFlightRequests.delete(cacheKey);
            });

        this._inFlightRequests.set(cacheKey, promise);
        return promise;
    }

    // Invalidar cache ao receber loadProject
    invalidateCache() {
        this._responseCache.clear();
    }
}
```

**Invalidação:** Cache é invalidado quando `synesis/loadProject` é chamado (dados podem ter mudado). Os 5 requests de `refreshAllExplorers()` que seguem o `loadProject` vão ao LSP — mas se chamados novamente dentro do TTL (ex: novo `refreshAllExplorers()` por debounce tardio), são servidos do cache.

**Arquivos afetados:**
- `synesisClient.js` — Cache layer, deduplicação, `invalidateCache()`
- `extension.js` — Chamar `lspClient.invalidateCache()` antes de `loadProject`

**Verificação:**
1. Abrir Social Acceptance. Forçar refresh 3 vezes em 5 segundos → logs devem mostrar 5 LSP calls (primeira vez), depois 0 (cache hits)
2. Salvar arquivo → `loadProject` invalida cache → próximo refresh vai ao LSP
3. `pytest tests/` no LSP deve continuar passando

**O que NÃO pode quebrar:**
- Dados nunca ficam stale por mais de 5 segundos (TTL)
- `loadProject` sempre invalida cache antes de buscar dados novos
- Deduplicação não causa deadlocks (Promise resolve é compartilhado)

---

### Fase 3: Eliminar Fallback Local do graphViewer

> **Impacto:** BAIXO | **Risco:** MUITO BAIXO | **Esforço:** 30min

**O que:** Remover `_findBibrefLocal()` do graphViewer. Confiar exclusivamente no LSP para resolução de bibref.

**Por que:** O `graphViewer._findBibref()` já usa LSP como caminho primário (linhas 387-403). O fallback local `_findBibrefLocal()` (linhas 429-462) usa `synesisParser.parseItems()` e `synesisParser.parseSourceBlocks()` — regex pesado que parseia o documento inteiro. Com LSP v0.14.23 estável, o fallback é desnecessário.

**Padrão Pyright:** Não usa parsing local quando LSP disponível.

**Como implementar:**

```javascript
// graphViewer.js — Simplificar _findBibref
async _findBibref(document, position) {
    if (!this.dataService || !this.dataService.lspClient || !this.dataService.lspClient.isReady()) {
        vscode.window.showWarningMessage('Synesis LSP is not ready. Cannot resolve reference.');
        return null;
    }
    return this._findBibrefViaLsp(document, position);
}

// Remover: _findBibrefLocal()
// Remover: this.parser = new SynesisParser();
// Remover: const SynesisParser = require('../parsers/synesisParser');
```

**Arquivos afetados:**
- `graphViewer.js` — Remover `_findBibrefLocal`, `SynesisParser` import, `this.parser`

**Verificação:**
1. Abrir Social Acceptance, posicionar cursor em ITEM block, executar "Show Graph" → grafo deve aparecer
2. Posicionar cursor em SOURCE block → grafo deve aparecer
3. Posicionar cursor fora de blocos → warning message
4. Desabilitar LSP → warning message (não fallback silencioso)

**O que NÃO pode quebrar:**
- "Show Graph" com LSP ativo funciona identicamente
- Se LSP desabilitado, mensagem clara ao invés de fallback silencioso
- Nenhum outro componente afetado

---

### Fase 4: Nova LSP Method `synesis/getExcerpts` (Coordenada com LSP)

> **Impacto:** ALTO (para projetos grandes) | **Risco:** MÉDIO | **Esforço:** 4-6h (2-3h LSP + 2-3h extensão)

**O que:** Implementar `synesis/getExcerpts(bibref)` no LSP que retorna excerpts já parseados. Substituir `abstractViewer._extractExcerpts()` por chamada LSP.

**Por que:** `_extractExcerpts()` é o maior consumidor de I/O e regex local na extensão. Lê todos os `.syn` do projeto e parseia com regex. O LSP já tem todos os items parseados e indexados. Mover esta lógica para o LSP elimina:
- I/O de leitura de arquivos (já em memória no LSP)
- Regex parsing de blocos ITEM (já parseados pelo compilador)
- Transferência de dados brutos (LSP envia apenas excerpts filtrados)

**Implementação LSP (synesis-lsp):**

```python
# explorer_requests.py — Nova function
def get_excerpts(cached_result, workspace_root, bibref):
    """Retorna excerpts de um bibref com campos de quotation, memo, chain e code."""
    if not cached_result or not cached_result.result:
        return {"excerpts": []}

    lp = cached_result.result
    template = cached_result.template if hasattr(cached_result, 'template') else None

    excerpts = []
    for source_key, source in lp.sources.items():
        for item in source.items:
            if item.bibref != bibref:
                continue
            # Extract quotation, memo, chain, code fields from item
            excerpt = {
                "text": _get_field_value(item, "quotation") or _get_field_value(item, "text") or "",
                "note": _get_field_value(item, "memo") or _get_field_value(item, "note") or "",
                "chain": _get_field_value(item, "chain") or "",
                "codes": list(item.codes) if hasattr(item, 'codes') else [],
                "line": item.location.line if hasattr(item, 'location') else 0,
                "file": str(item.location.file) if hasattr(item, 'location') else ""
            }
            excerpts.append(excerpt)

    return {"excerpts": excerpts}
```

**Implementação Extensão (synesis-explorer):**

```javascript
// abstractViewer.js — Substituir _extractExcerpts
async _extractExcerpts(bibref, projectUri) {
    // Tentar LSP primeiro
    const lspResult = await this.dataService.getExcerpts(bibref);
    if (lspResult && lspResult.excerpts && lspResult.excerpts.length > 0) {
        return { excerpts: lspResult.excerpts, display: this._inferDisplay(lspResult.excerpts) };
    }

    // Fallback: parsing local (manter durante transição)
    return this._extractExcerptsLocal(bibref, projectUri);
}
```

**Pré-requisito:** LSP v0.14.24 com `synesis/getExcerpts`.

**Arquivos afetados:**
- `synesis-lsp/synesis_lsp/explorer_requests.py` — Nova `get_excerpts()`
- `synesis-lsp/synesis_lsp/server.py` — Registrar handler `synesis/getExcerpts`
- `synesis-explorer/src/services/dataService.js` — Novo `getExcerpts()`
- `synesis-explorer/src/viewers/abstractViewer.js` — Usar LSP, manter fallback local

**Verificação:**
1. Abrir Social Acceptance, posicionar em SOURCE, "Show Abstract" → abstract com highlights corretos
2. Verificar que excerpts são idênticos (LSP vs local)
3. Medir tempo: LSP (~5ms) vs local (~200ms para arquivo grande)
4. Desabilitar LSP → fallback local funciona

**O que NÃO pode quebrar:**
- Abstract viewer funciona com e sem LSP
- Highlights de excerpt são idênticos
- Notas, chains e codes aparecem corretamente
- Fallback local mantido durante transição

---

### Fase 5: Bundle Mermaid Localmente + CSP

> **Impacto:** BAIXO | **Risco:** MUITO BAIXO | **Esforço:** 1h

**O que:** Incluir `mermaid.min.js` como asset local da extensão. Adicionar Content-Security-Policy com nonce.

**Por que:** Elimina dependência de CDN (funciona offline), melhora segurança (CSP), e reduz latência (arquivo já local).

**Padrão Pyright:** Assets bundled localmente, webviews com CSP.

**Como implementar:**

```javascript
// graphViewer.js — Usar asset local
getWebviewContent(reference, mermaidCode) {
    const nonce = getNonce();
    const mermaidUri = this.panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'mermaid.min.js')
    );

    return `<!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy"
              content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
        <script nonce="${nonce}" src="${mermaidUri}"></script>
    </head>
    ...`;
}

function getNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}
```

**Arquivos afetados:**
- `graphViewer.js` — Asset local + CSP
- `package.json` — Adicionar `dist/mermaid.min.js` a `files`
- Novo: `dist/mermaid.min.js` (download de CDN, ~2MB)

**Verificação:**
1. Desconectar rede → "Show Graph" funciona offline
2. Grafo renderiza corretamente com Mermaid local
3. Zoom, pan, export funcionam

---

### Fase 6: esbuild Production Minification

> **Impacto:** BAIXO | **Risco:** MUITO BAIXO | **Esforço:** 15min

**O que:** Adicionar `minify: true` ao esbuild em modo produção.

**Por que:** Reduz tamanho do bundle, melhora cold-start.

**Como implementar:**

```javascript
// esbuild.js — Adicionar minification
const buildOptions = {
    entryPoints: ['extension.js'],
    bundle: true,
    platform: 'node',
    target: 'node14',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    sourcemap: true,
    minify: !isWatch  // minify em produção, não em dev
};
```

**Arquivos afetados:**
- `esbuild.js` — Adicionar `minify`

---

## PARTE V — Ordem de Implementação e Dependências

```
Fase 1 (Debounce + Refresh Seletivo) ─── independente ─── deploy primeiro
  │
  │ (beneficia)
  ▼
Fase 2 (Cache + Deduplicação)         ─── independente, combina com Fase 1

Fase 3 (Remover fallback graphViewer) ─── independente (requer LSP estável)

Fase 4 (LSP getExcerpts)             ─── DEPENDE de implementação no LSP
                                          Requer coordenação com synesis-lsp

Fase 5 (Mermaid local + CSP)         ─── totalmente independente

Fase 6 (esbuild minify)              ─── totalmente independente
```

### Cronograma Sugerido

| Sprint | Fases | Foco | Esforço Total | Dependência |
|--------|-------|------|---------------|-------------|
| **Sprint 1** | Fases 1 + 6 | Quick wins, risco mínimo | ~1.5h | Nenhuma |
| **Sprint 2** | Fase 2 | Cache inteligente | ~2h | Nenhuma |
| **Sprint 3** | Fases 3 + 5 | Limpeza de fallbacks e assets | ~1.5h | LSP estável |
| **Sprint 4** | Fase 4 | Nova LSP method | ~4-6h | Coordenação com LSP |

### Impacto Cumulativo Estimado

| Cenário | Antes | Após Todas as Fases | Redução |
|---------|-------|---------------------|---------|
| Salvar .syn (5 explorers) | 6 LSP calls | 1 call (loadProject) + cache hits | **~83%** |
| Salvar .bib | 6 LSP calls | 1 call + 1 refresh (Reference only) | **~83%** |
| Refresh rápido (< 5s) | 5 LSP calls | 0 calls (cache hit) | **~100%** |
| Show Abstract (Social Acceptance) | I/O + regex 18K linhas | 1 LSP call (~5ms) | **~97%** |
| Show Graph (bibref) | LSP + regex fallback | LSP only | **~50%** (regex eliminado) |
| Cold-start bundle | ~150KB não-minificado | ~80KB minificado | **~47%** |

---

## PARTE VI — Verificação End-to-End (Projetos Reais)

> **Projetos de teste:** Todos os testes usam projetos reais da pasta `case-studies/`.
>
> | Projeto | Caminho | Escala | Uso na Extensão |
> |---------|---------|--------|-----------------|
> | **Basic** | `case-studies/Basic/project.synp` | 1 source, 1 item, 2 ontologies | Smoke test rápido |
> | **AIDS Corpus** | `case-studies/Sociology/iramuteq_aids_corpus/aids_corpus.synp` | 5 sources, 5 items, 2 ontologies | Funcional pequeno |
> | **Social Acceptance** | `case-studies/Sociology/Social_Acceptance/social_acceptance.synp` | 484 sources, 1614 items, 1388 ontologies | Benchmark + performance |
> | **Thompson** | `case-studies/Theology/Thompson_Chain_Reference/thompson_bible.synp` | 1 source, 15757 items, 1728 ontologies | Stress test grande |
> | **Nave** | `case-studies/Theology/Nave_Topical_Concordance/nave.synp` | 1 source, 82826 items, 5317 ontologies | Escala máxima |

### Testes de Regressão (obrigatório após cada fase)

#### Smoke Test — Basic

```
1. Abrir pasta case-studies/Basic/ como workspace no VSCode
2. Verificar: LSP inicia e status bar mostra "ready"
3. Code Explorer: deve mostrar códigos definidos na ontologia
4. Reference Explorer: deve mostrar bibrefs
5. Relation Explorer: verificar se chains existem
6. Ontology Explorer: deve mostrar tópicos hierárquicos
7. Show Graph: posicionar em ITEM, executar comando
8. Show Abstract: posicionar em SOURCE, executar comando
```

#### Teste Funcional — Social Acceptance

```
1. Abrir pasta case-studies/Sociology/Social_Acceptance/ como workspace
2. Abrir social_acceptance.syn (18819 linhas)
3. Code Explorer: deve mostrar 1388+ códigos
4. Reference Explorer: deve mostrar 484+ bibrefs
5. Relation Explorer: deve mostrar relações de chain
6. Ontology Explorer: tópicos hierárquicos
7. Ontology Annotations: mudar para arquivo .syn → anotações do arquivo ativo
8. Filter: filtrar codes por "ACCEP" → lista reduzida
9. Go to Definition (F12): em código do Code Explorer → navega para .syno
10. Rename (F2): renomear um código → refactoring propaga
```

#### Teste de Performance — Social Acceptance

```
1. Com Social Acceptance aberto:
2. Salvar .syn → medir tempo até explorers atualizarem
   - Esperado: < 2s (loadProject + 5 refreshes)
   - Após Fase 1: < 1s (loadProject + 3 refreshes seletivos)
   - Após Fase 2: < 0.5s (loadProject + cache hits)
3. Show Abstract em source com 10+ excerpts → deve renderizar em < 1s
4. Show Graph → mermaid deve renderizar em < 2s
5. Filtro de codes: digitar "ACCEP" → lista atualiza em < 100ms
```

#### Stress Test — Nave

```
1. Abrir pasta case-studies/Theology/Nave_Topical_Concordance/ como workspace
2. Verificar: LSP NÃO dá timeout nem crash
3. Code Explorer: deve listar 5317 códigos sem travamento
4. Scroll pelo Code Explorer → responsivo
5. Show Abstract em um dos bibrefs → deve funcionar (arquivo grande)
6. Show Graph → deve funcionar se existirem chains
```

### Métricas de Performance (antes/depois)

```
| Cenário                    | Projeto         | Antes (ms) | Depois (ms) | Redução |
|----------------------------|-----------------|------------|-------------|---------|
| Salvar .syn → explorers    | Social Accept.  |            |             |         |
| Salvar .bib → explorers    | Social Accept.  |            |             |         |
| Show Abstract (10 excerpts)| Social Accept.  |            |             |         |
| Show Graph (mermaid)       | Social Accept.  |            |             |         |
| Code Explorer: 5317 codes  | Nave            |            |             |         |
| Filter codes               | Social Accept.  |            |             |         |
```

### Checklist de Segurança por Fase

| Fase | Teste Crítico | Projeto de Teste | Indicador de Falha |
|------|---------------|------------------|----------------------|
| 1 | Explorers atualizam corretamente por tipo de arquivo | Social Acceptance | Explorer não atualiza quando deveria (refresh seletivo errado) |
| 2 | Dados nunca ficam stale | Social Acceptance (editar, salvar, verificar) | Explorer mostra dados antigos (cache TTL muito longo) |
| 3 | Show Graph funciona sem fallback | Social Acceptance + Basic | Grafo não aparece (LSP symbols falhou) |
| 4 | Excerpts idênticos via LSP vs local | Social Acceptance (abstracts) | Highlights missing ou errados (LSP extração diferente) |
| 5 | Grafo renderiza offline | Basic (desconectar rede) | Mermaid não carrega (asset path errado) |
| 6 | Extensão carrega corretamente | Basic (ativar extensão) | Crash no startup (minification quebrou) |

---

### Mapa de Dependência de Parsers Locais

| Parser | Consumidores Atuais | Removível Após |
|--------|--------------------|----|
| `synesisParser.js` | `graphViewer._findBibrefLocal`, `abstractViewer._findBibref`, `abstractViewer._extractExcerpts` | Fase 3 (graphViewer) + Fase 4 (abstractViewer) |
| `bibtexParser.js` | `abstractViewer.showAbstract` | Nunca — LSP não expõe BibTeX parsing |
| `templateParser.js` | `templateManager.loadTemplate` | Nunca — feature local da extensão |
| `projectLoader.js` | `abstractViewer`, `workspaceScanner` | Nunca — feature local da extensão |
| `ontologyParser.js` | `templateManager` (indireto) | Nunca — feature local |
| `chainParser.js` | Uso mínimo | Avaliar remoção |
| `positionUtils.js` | `extension.js` (findSymbolPosition) | Nunca — utility necessário |
| `fuzzyMatcher.js` | `abstractViewer.highlightExcerpts` | Nunca — feature local |
| `mermaidUtils.js` | `graphViewer` (indiretamente, via DataService/LSP) | Nunca — utility de rendering |

**Conclusão:** Após Fases 3 e 4, `synesisParser.js` pode ser removido inteiramente (nenhum consumidor restante). Todos os outros parsers servem features locais sem equivalente LSP e devem ser mantidos.

---

*Documento gerado em: 2026-03-13 | Atualizado em: 2026-03-15*
*Baseado em: synesis-explorer v0.5.19 + synesis-lsp v0.14.27 + synesis v0.4.2*
*Referências: vscode-pyright (patterns de performance), synesis-lsp-performance-plan.md, synesis-performance-plan.md*
