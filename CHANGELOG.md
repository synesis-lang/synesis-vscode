# Changelog

All notable changes to the Synesis Explorer extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.30] - 2026-04-29

### Fixed
- **Zoom do Graph Viewer** (`src/viewers/graphViewer.js`)
  - Causa raiz: o `<script>` do webview não tinha atributo `nonce`, fazendo a CSP (`script-src 'nonce-{nonce}'`) bloquear silenciosamente todo o JavaScript customizado — botões +/−/Reset e scroll wheel não respondiam.
  - Atributo `nonce="${nonce}"` adicionado ao `<script>` tag principal.
  - Atributos `onclick="..."` substituídos por `id` nos três botões + `addEventListener` no script — inline event handlers são bloqueados por CSP mesmo com nonce.
  - `svg.getBBox()` envolvido em `requestAnimationFrame` para garantir que o SVG esteja pintado antes da leitura de dimensões no auto-fit inicial; guard `svgWidth > 0 && svgHeight > 0` adicionado para evitar cálculo com dimensões nulas.

---

## [0.5.29] - 2026-04-25

### Added
- **Suporte a `.synr` (formato de revisão do pipeline ACT)** (`package.json`)
  - A extensão `.synr` foi adicionada à lista de extensões da linguagem `synesis`.
  - Arquivos `.synr` recebem syntax highlighting, semantic tokens e associação de ícone idênticos aos arquivos `.syn` — o formato é sintaticamente compatível (comentários `# REVISION` e `# $key: value` são reconhecidos como `comment.line.synesis`).
  - Nenhuma mudança no atalho Ctrl+Shift+I (`synesis-coder item`) — contrato com a extensão inalterado.

---

## [0.5.28] - 2026-04-01

### Fixed
- **Synesis Coder — encoding UTF-8 no Windows** (`src/services/coderService.js`)
  - `execFile` agora injeta `PYTHONUTF8=1` e `PYTHONIOENCODING=utf-8` no
    ambiente do processo filho, garantindo que o Python escreva stdout em UTF-8
    mesmo em sistemas com code page cp1252 — corrige corrupção de acentos em
    textos em português retornados pelo `synesis-coder item`

## [0.5.27] - 2026-03-26

### Changed
- **Sidebar — redesign minimalista de todos os 5 explorers**
  - Redução de ruído textual: contadores verbosos (`N items in N files`, `N uses`, `N chains`) substituídos por badges `(N)` na `description`.
  - Caminhos de arquivo removidos dos labels dos filhos; substituídos por `Ln X` — nome do arquivo movido para o `tooltip` (visível ao passar o mouse).
  - **References**: nó raiz `@bibref (N)`, filho `Ln X (N)`.
  - **Codes**: nó raiz `código (N)`, filho `Ln X` com `chain` na description apenas quando aplicável; `not in ontology` preservado no tooltip do nó raiz.
  - **Relations**: nó raiz `RELAÇÃO (N)`, filho `A → B` com `Ln X` na description.
  - **Ontology Topics**: nó pai `tópico (N)`, nó folha `conceito Ln X`.
  - **Ontology Annotations**: nó raiz `código (N) · Ln X` (quando definido na ontologia) ou `(N) · not in ontology`, filho `Ln X` com `chain` quando aplicável.
- **Codes — `usageCount` corrigido**: contagem reflete ocorrências individuais; ordenação primária alfabética, secundária por frequência decrescente.

## [0.5.26] - 2026-03-26

### Changed
- **Sidebar — todas as 5 views melhoradas**
  - **References**: descrição `N items in N files` (singular/plural), tooltip com título da referência, cabeçalho `References (N)`
  - **Codes**: ordenação por frequência de uso decrescente, descrição `N uses` com sufixo `· not in ontology` quando não definido na ontologia, contexto de ocorrência exibe `code field` / `chain · fieldName`, cabeçalho `Codes (N)`
  - **Relations**: descrição `N chains` nos itens raiz, seta unicode `→` nos triplets, descrição `arquivo:linha` nos triplets filhos, cabeçalho `Relations (N)`
  - **Ontology Topics**: nós pai com ícone `tag` e descrição `N concepts`, nós folha com ícone `pin` e descrição `arquivo:linha`, cabeçalho `Ontology Topics (N)`
  - **Ontology**: descrição `N uses · arquivo:linha` (quando definido na ontologia) ou `N uses · not in ontology`, contexto de ocorrência exibe `code field` / `chain · fieldName`, cabeçalho `Ontology (N)`
- **References**: título da referência bibliográfica incluído no payload LSP e exibido como tooltip

## [0.5.25] - 2026-03-23

### Added
- **Synesis Coder integration** — `synesis.coder.codeSelection` command
  integrates `synesis-coder item` mode directly into the editor
  - **Context menu**: right-click selected text in a `.syn` file →
    "Synesis: Code Selection" generates an ITEM block via the `synesis-coder` CLI
    and replaces the selection atomically
  - **Keyboard shortcut**: `Ctrl+Shift+I` / `Cmd+Shift+I` (when editor has
    selection in a `.syn` file)
  - **Auto-detection of bibref**: reads the SOURCE/ITEM block under the cursor
    using `SynesisParser`; falls back to the nearest preceding block; prompts
    the user manually only when no block is found
  - **Progress notification** with Cancel button — calls `synesis-coder item`
    as a subprocess via `child_process.execFile` (shell-safe for text with
    quotes, newlines, and special characters)
  - **Cancellation support**: Cancel button kills the subprocess via
    `CancellationToken.onCancellationRequested → child.kill()`
  - Friendly error when `synesis-coder` is not installed (`ENOENT` → message
    suggesting `pip install synesis-coder`)
- **New configuration**: `synesisExplorer.coder.path` (default: `"synesis-coder"`)
  — path to the `synesis-coder` executable for non-default installations
- **New module**: `src/services/coderService.js` — `CoderService` class
  encapsulating bibref detection, CLI invocation, and editor replacement

## [0.5.24] - 2026-03-15

### Fixed
- **`WORD:` dentro de GUIDELINES ainda destacado como campo** (`syntaxes/synesis.tmLanguage.json`)
  - `match: ".+"` em `guidelines_content` usa `^.+$` para ancorar explicitamente ao início da linha.
  - `begin` do `guidelines_block` relaxado de `\s*$` para `\s*(?:#.*)?\r?$` — aceita comentários inline após `GUIDELINES` e trata CRLF (Windows) corretamente, evitando falha silenciosa na ativação do bloco.

## [0.5.23] - 2026-03-15

### Fixed
- **Conteúdo de GUIDELINES ainda destacado como keywords/chains/campos** (`syntaxes/synesis.tmLanguage.json`)
  - Defesa em profundidade: `#guidelines_block` agora incluído em **todos** os contextos (root, SOURCE, ITEM, ONTOLOGY, FIELD) — antes só estava em `meta.block.field.synesis`.
  - Novo `#guidelines_content` com `match: ".+"` consome cada linha inteira como `string.unquoted.guidelines.synesis`, impedindo qualquer sub-padrão (keywords, chains, fields) de casar dentro do bloco.
  - Cor do conteúdo: itálico neutro (`#a9b1d6` dark / `#6e6a86` light) — texto instrucional, não código.

## [0.5.22] - 2026-03-15

### Fixed
- **Conteúdo de GUIDELINES destacado como campos/keywords** (`syntaxes/synesis.tmLanguage.json`)
  - Campos com `begin`/`end` (`DESCRIPTION:`, `SCOPE:`, etc.) não tinham `GUIDELINES` como delimitador de fim — o campo anterior "vazava" e consumia as linhas do bloco GUIDELINES como valor de campo.
  - Fix: adicionado `|\\s*GUIDELINES\\b` ao padrão `end` de todos os quatro tipos de campo (`chain`, `code`, `text`, `generic`), forçando o campo a terminar quando a gramática encontra a linha `GUIDELINES`.

## [0.5.21] - 2026-03-15

### Added
- **Semantic Tokens ativados nos temas** (`themes/synesis-dark-theme.json`, `themes/synesis-light-theme.json`)
  - `"semanticHighlighting": true` em ambos os temas — o editor agora aplica colorização AST do LSP.
  - `"semanticTokenColors"` mapeando os 6 tipos do servidor (keyword, variable, property, string, enumMember, namespace) às novas paletas.
  - TextMate `tokenColors` atualizado para manter consistência como fallback.
- **Novas paletas de cores** ("Midnight Scholar" dark / "Parchment & Ink" light)
  - Dark: fundo `#1a1b26` (azul-noite); keywords `#bb9af7` (rosa-magenta); @bibrefs `#e0af68` (dourado); campos `#7dcfff` (azul-celeste); valores `#9ece6a` (verde-salvia); códigos `#2ac3de` (turquesa); relações `#f7768e` (coral).
  - Light: fundo `#faf4ed` (pergaminho); keywords `#8839ef` (púrpura-real); @bibrefs `#df8e1d` (âmbar); campos `#1e66f5` (azul-tinta); valores `#40a02b` (verde-floresta); códigos `#179299` (teal); relações `#d20f39` (vermelho).
- **semanticTokenScopes** em `package.json` — mapeia token types LSP para escopos TextMate, garantindo compatibilidade com temas de terceiros (Dark+, Monokai, etc.).
- **Configurações de feature toggle** (`package.json`)
  - `synesisExplorer.diagnostics.enabled` — habilita/desabilita squiggles de diagnóstico.
  - `synesisExplorer.inlayHints.enabled` — habilita/desabilita hints inline "(Author, Year)".
  - `synesisExplorer.semanticHighlighting.enabled` — habilita/desabilita colorização AST.
  - `synesisExplorer.completion.autoImportCodes` — inclui/exclui códigos ontológicos nas sugestões de autocomplete.
- **Middleware LSP** (`src/lsp/synesisClient.js`)
  - `_buildMiddleware()` intercepta respostas de diagnostics, inlayHints, semanticTokens e completion de acordo com as configurações do usuário.
  - Hot-reload: toggles funcionam sem reiniciar a extensão.
- **Capability Validation expandida** (`extension.js`)
  - `validateLspCapabilities()` agora verifica 11 capabilities (5 required + 6 optional).
  - Optional features (SignatureHelp, References, CodeActions, SemanticTokens, InlayHints, DocumentHighlight) logadas no Output channel como disponíveis/indisponíveis.

## [0.5.20] - 2026-03-15

### Fixed
- **Syntax highlighting não aplica keywords/fields dentro de GUIDELINES** (`syntaxes/synesis.tmLanguage.json`)
  - O bloco `meta.block.field.synesis` incluía `#keywords` e `#fields` sem contexto de bloco — `CODE:`, `CHAIN:`, etc. dentro de GUIDELINES eram destacados como nome de campo.
  - Fix: nova regra `guidelines_block` com `begin`/`end` marcando `GUIDELINES ... END GUIDELINES` como `meta.block.guidelines.synesis`; o conteúdo interno só aceita `#comments`, ignorando keywords e fields. Incluída no `meta.block.field.synesis` antes de `#keywords`.

## [0.5.19] - 2026-03-15

### Changed
- **Versões LSP e compilador no rodapé** (`extension.js`)
  - `setLspStatus('ready', stats, lspVersion, compilerVersion)` agora exibe `[LSP v0.14.26 · synesis v0.4.1]` diretamente no texto da status bar.
  - Tooltip inclui `— LSP vX.Y.Z · synesis vX.Y.Z` quando versões disponíveis.
  - Valores provêm de `lsp_version` / `compiler_version` retornados por `synesis/loadProject` (LSP v0.14.26+).

## [0.5.18] - 2026-03-15

### Fixed
- **Bug 2.6: fallback indevido em `synesisClient.js`** (`src/lsp/synesisClient.js`)
  - O catch em `_actualSendRequest` fazia fallback para `client.sendRequest()` em **qualquer** erro, não apenas `-32601 Method Not Found`.
  - Consequência: erros de runtime do LSP eram mascarados como "LSP method not supported", disparando `onLspIncompatible` e exibindo "LSP Incompatível" na barra de status.
  - Fix: condição alterada para `this._isMethodNotFound(error)` — o fallback só ocorre quando o servidor LSP realmente não registrou o método como `executeCommand`.

## [0.5.17] - 2026-03-15

### Changed
- **Performance — Fase 6: esbuild minification em produção** (`esbuild.js`)
  - Adicionado `minify: !isWatch` — bundle é minificado em `npm run build` / `vscode:prepublish`, mas não durante `--watch` (dev).
  - Source maps continuam gerados em ambos os modos (`sourcemap: true`).

## [0.5.16] - 2026-03-15

### Changed
- **Performance — Fase 5: Mermaid.js local + CSP** (`src/viewers/graphViewer.js`, `extension.js`, `media/mermaid.min.js`)
  - `media/mermaid.min.js` (~3.2 MB) adicionado como asset local da extensão — grafo funciona sem conexão de rede.
  - `GraphViewer` aceita `extensionUri` como segundo argumento; `extension.js` passa `context.extensionUri`.
  - `showGraphPanel` define `localResourceRoots: [extensionUri/media]` para autorizar acesso ao asset.
  - `getWebviewContent` adiciona `<meta http-equiv="Content-Security-Policy">` com nonce por requisição:
    - Asset local: `script-src 'nonce-{nonce}'` (sem CDN permitido)
    - Fallback CDN (se `extensionUri` não disponível): `script-src 'nonce-{nonce}' https://cdn.jsdelivr.net`
  - `<link href="https://rsms.me/inter/inter.css">` removido — fonte Inter substituída por `system-ui, sans-serif`.
  - `getNonce()` adicionado como função utilitária de módulo (32 chars alfanuméricos).

## [0.5.15] - 2026-03-15

### Changed
- **Performance — Fase 4: `synesis/getExcerpts` LSP + fallback local** (`src/viewers/abstractViewer.js`, `src/services/dataService.js`, `extension.js`)
  - `AbstractViewer` agora aceita `dataService` como terceiro argumento do construtor.
  - `_extractExcerpts()` tenta LSP primeiro via `dataService.getExcerpts(bibref)` (novo método `synesis/getExcerpts` do LSP v0.14.25); se bem-sucedido, monta excerpts a partir dos dados já em memória no servidor sem nenhum I/O de disco na extensão.
  - Novo método `_buildExcerptsFromLspItems()` converte o formato LSP (`extra_fields`, `codes`, `chains`) para o mesmo shape de excerpts da lógica original, usando o `templateManager` para identificar os campos QUOTATION/MEMO/CHAIN/CODE do template do projeto.
  - Método `_extractExcerptsLocal()` preserva integralmente a lógica anterior (leitura de arquivos + regex) como fallback: acionado se LSP não disponível, retornar null, ou lançar exceção.
  - `DataService` e `LspDataProvider` recebem método `getExcerpts(bibref)`.
  - Requer `synesis-lsp >= 0.14.25`.

## [0.5.14] - 2026-03-15

### Changed
- **Performance — Fase 3: Remover fallback local do graphViewer** (`src/viewers/graphViewer.js`)
  - Removidos `_findBibrefLocal()` (33 linhas), `this.parser = new SynesisParser()` e o `require('../parsers/synesisParser')`.
  - `_findBibref()` agora confia exclusivamente no LSP (`_findBibrefViaLsp` via `vscode.executeDocumentSymbolProvider`).
  - Se o LSP não estiver pronto, exibe mensagem clara ("Synesis LSP is not ready. Cannot resolve reference.") ao invés de fallback silencioso com parsing regex local.
  - `synesisParser.js` permanece no projeto pois ainda é usado por `abstractViewer.js` (Fase 4).

## [0.5.13] - 2026-03-15

### Changed
- **Performance — Fase 2: Cache de responses LSP + deduplicação de requests** (`src/lsp/synesisClient.js`, `extension.js`)
  - `SynesisLspClient` agora mantém um cache em memória (TTL 5s) para respostas dos métodos `synesis/*` (exceto `synesis/loadProject`, que sempre vai ao servidor).
  - Requests idênticos simultâneos (mesmo método + params) são coalescidos numa única Promise em voo — nenhum request duplicado sai pelo stdio enquanto o primeiro ainda não retornou.
  - `invalidateCache()` adicionado ao cliente e chamado em `runLspLoadProject()` antes de cada `synesis/loadProject`, garantindo que os refreshes subsequentes sempre buscam dados frescos após recompilação.
  - Erros de requests cacheáveis não são armazenados — em caso de falha a entrada não é criada, permitindo nova tentativa no próximo `refresh()`.
  - Efeito prático: os 5 calls de `refreshAllExplorers()` disparados após `loadProject` resultam em 5 requests reais na primeira vez; chamadas subsequentes dentro do TTL (ex: segundo `refreshAllExplorers()` por debounce tardio ou comando manual) retornam do cache sem overhead de stdio.

## [0.5.12] - 2026-03-15

### Changed
- **Performance — Fase 1: Debounce factory + refresh seletivo por tipo de arquivo** (`extension.js`)
  - Substituído o debounce timer único compartilhado por instâncias `Debouncer` independentes, eliminando o risco de cancelamento cruzado entre `onDidChangeActiveTextEditor` e outros handlers.
  - Adicionado mapa `FILE_REFRESH_MAP` e função `refreshExplorersForFileType(ext)`: ao salvar um arquivo, apenas os explorers afetados pelo tipo são atualizados:
    - `.syn` → Reference Explorer, Code Explorer, Ontology Annotations
    - `.syno` → Ontology Topics Explorer, Ontology Annotations
    - `.synt` → todos os explorers (template altera tudo)
    - `.bib` → Reference Explorer apenas
    - `.synp` → todos os explorers (projeto altera tudo)
  - Comportamento de múltiplos saves no mesmo debounce: se dois tipos distintos são salvos antes do timer de 1000ms disparar, o escopo mais amplo prevalece (`'all'` vence qualquer tipo específico).
  - Caminhos que continuam com refresh completo: startup inicial, comando `synesis.lsp.loadProject`, rename de código, rename de referência.
  - Nenhuma funcionalidade existente foi alterada — apenas a granularidade do refresh após save.

## [0.5.11] - 2026-03-06

### Added
- `syntaxes/synesis.tmLanguage.json`: keyword `GUIDELINES` adicionado ao grupo
  `keyword.control.field.synesis`, aplicando syntax highlighting ao bloco
  `GUIDELINES...END GUIDELINES` dentro de `FIELD...END FIELD`.
- `src/core/templateManager.js`: campo `guidelines` extraído de `fieldDef` e
  incluído no field registry via `buildFieldRegistry()`, tornando o conteúdo
  das guidelines disponível para consumidores da extension.

## [0.5.10] - 2026-02-06

### Fixed
- Code Explorer and Ontology (Annotations) refresh now detect rename changes reliably by using a full data hash and avoiding premature cache clears.
- Ontology Topics refresh now detects changes reliably using a full tree hash to prevent stale results.

### Removed
- Removed "Rename Code" from the Code Explorer context menu (F2 and editor context rename remain).

## [0.5.9] - 2026-02-06

### Fixed
- **CRÍTICO - Rename (F2) scope error**: `renameSymbol()` chamava `refreshAllExplorers()` que estava fora de escopo, causando `ReferenceError` em runtime
  - Bug: `refreshAllExplorers()` definida dentro de `activate()`, mas `renameSymbol()` está no escopo módulo
  - Resultado: rename aplicava edições mas refresh falhava silenciosamente
- **Rename refresh prematuro**: `refreshAllExplorers()` era chamado antes do LSP recompilar, retornando dados stale
  - Fix: command handlers agora chamam `runLspLoadProject()` após rename bem-sucedido
  - LSP recompila → `refreshAllExplorers()` → dados frescos garantidos
- **Arquivos não salvos após rename**: `applyEdit()` deixava arquivos em estado dirty, dependendo de auto-save
  - Fix: `renameSymbol()` agora chama `await vscode.workspace.saveAll(false)` após `applyEdit()`
  - Garante persistência no disco independente de configuração de auto-save

### Changed
- **`renameSymbol()` assinatura**: Agora retorna `boolean` (true=sucesso, false=falha) ao invés de `void`
  - Remove `refreshAllExplorers()` e `showInformationMessage` (movidos para command handlers)
  - Adiciona `saveAll()` após `applyEdit()`
- **Command handlers (`synesis.code.rename`, `synesis.reference.rename`)**:
  - Capturam retorno de `renameSymbol()`
  - Se sucesso: chamam `runLspLoadProject()` (que já chama `refreshAllExplorers()` internamente)
  - Mostram mensagem de sucesso após refresh completo

### Architecture
- **Fluxo correto**: `renameSymbol()` → `applyEdit()` → `saveAll()` → retorna true → command handler → `runLspLoadProject()` → LSP recompila → `refreshAllExplorers()` → mensagem ao usuário
- **Integridade referencial**: LSP rename (`rename.py`) já cobre CODE, CHAIN e ONTOLOGY via template-driven field discovery
- **Scope safety**: Todas as chamadas de `runLspLoadProject()` e `refreshAllExplorers()` agora dentro do escopo correto de `activate()`

### Technical Details
- Double-reload é inofensivo: `scheduleLspLoadProject()` (1000ms delay) dispara após `saveAll()`, mas explorers usam hash-based caching
- Se dados não mudaram, segundo refresh é ignorado (custo: uma chamada LSP extra sem impacto visual)
- Verificar: rename via F2, menu contextual, cancelamento (Esc), e integridade CODE+CHAIN+ONTOLOGY

## [0.5.8] - 2026-02-05

### Fixed
- **CODE duplication in Ontology Annotations Explorer**: Campos CODE agora aparecem apenas 1x (não duplicados)
  - Bug estava no LSP (synesis-lsp v0.14.14) - faltava deduplicação final em `ontology_annotations.py`
  - Fix foi server-side: adicionada função `_dedupe_occurrences()` em `ontology_annotations.py`
  - Nenhuma alteração necessária na extension
- **Refresh after Rename**: Explorers agora atualizam automaticamente após rename bem-sucedido (F2 ou menu contextual)
  - Adicionada chamada `refreshAllExplorers()` após `applyEdit()` na função `renameSymbol()`
  - UX imediato: usuário vê mudanças instantaneamente sem necessidade de salvar arquivo
  - Padrão consistente com refresh após save

### Changed
- **Dependency**: Requer synesis-lsp v0.14.14+ para funcionamento correto de occurrences CODE em Ontology Annotations Explorer

## [0.5.7] - 2026-02-05

### Fixed
- **CHAIN last-occurrence-only bug**: Code Explorer agora mostra TODAS as occurrences de códigos em campos CHAIN consecutivos, não apenas a última
  - Bug estava no LSP (synesis-lsp v0.14.13) - Phase 2 de `_dedupe_occurrences` colapsava occurrences próximas
  - Exemplo: CCS_Support aparecendo em 4 chains consecutivas agora mostra todas as 4 occurrences
  - Nenhuma alteração necessária na extension - fix foi server-side

### Changed
- **Dependency**: Requer synesis-lsp v0.14.13+ para funcionamento correto de múltiplas CHAIN occurrences

## [0.5.6] - 2026-02-05

### Removed
- **Client-side deduplication band-aid**: Removed `_deduplicateOccurrences()` method from DataService that used 10-line proximity heuristic
  - Method was removing legitimate occurrences and compensating incorrectly for LSP data issues
  - Root cause now fixed in synesis-lsp v0.14.12 via server-side deduplication
  - Removed calls in `getCodes()` (line 111) and `getOntologyAnnotations()` (line 241)

### Changed
- **Data flow architecture**: Extension now consumes clean data directly from LSP without client-side deduplication
  - Occurrences are used directly after normalization (line number conversion 1-based → 0-based)
  - usageCount reflects actual occurrence count from LSP
  - Simpler, more maintainable code path

### Technical Details
- Removed ~50 lines of code (method + 2 call sites)
- Performance improvement: eliminated O(n²) proximity comparison on every tree refresh
- Data integrity: no risk of legitimate occurrences being filtered out by heuristics
- Requires synesis-lsp v0.14.12+ for correct behavior

## [0.5.5] - 2026-02-05

### Fixed
- **Duplicate Occurrences**: Fixed CODE field occurrences showing duplicate entries (line exact + line block ITEM) - now only shows exact lines
- **Inconsistent Duplications**: Fixed ontologyAnnotationExplorer showing duplicate occurrences similar to CODE fields
- **TreeView Refresh Performance**: Fixed slow/laggy tree refreshes when clicking items

### Performance
- **Cache System**: Added intelligent caching in all explorers (Code, Reference, Relation, Ontology, OntologyAnnotation) to prevent unnecessary tree refreshes when data hasn't changed
  - Hash-based comparison of data before updating tree
  - Skips tree rebuild if data identical to previous refresh
  - ~80% reduction in unnecessary tree redraws
- **Removed File Watchers**: Eliminated redundant file system watchers that duplicated onDidSaveTextDocument functionality
  - Removed synesisWatcher and all handleFileChange handlers
  - Prevents double-refresh on file save
- **Optimized Refresh Strategy**: Reduced refresh frequency - only updates when file is saved and LSP confirms data changed
  - Removed redundant refresh calls on every file change event
  - ~70% reduction in refresh operations
- **Removed Excessive Logging**: Cleaned up console.log statements in DataService and all explorers for production performance
  - Removed ~20 debug logs per refresh cycle
  - ~90% reduction in console output
  - Kept only critical error logging
- **Debounced Active Editor Changes**: Added 200ms debounce to ontologyAnnotationExplorer refresh on editor changes
  - Prevents refresh spam when quickly switching editors

### Changed
- **DataService**: Added `_deduplicateOccurrences()` method to remove near-duplicate occurrences (within 10 lines)
  - Groups by file + context + field
  - Keeps most specific line (highest line number)
  - Removes duplicates within 10-line range
- **All Explorers**: Implemented data hash comparison to skip updates when data unchanged
  - CodeExplorer: `_hashData()` with count + first/last code + occurrence count
  - ReferenceExplorer: `_hashData()` with count + first ref + occurrence count
  - RelationExplorer: `_hashData()` with count + first relation + triplet count
  - OntologyExplorer: `_hashData()` with count + first topic + child count
  - OntologyAnnotationExplorer: `_hashData()` with activeFile + count + first code + occurrence count
- **Extension.js**: Removed file watchers, kept only onDidSaveTextDocument with LSP reload for cleaner refresh flow
  - Removed `synesisWatcher`, `handleFileChange`, `refreshSynFiles`, `refreshOntologyFiles`, `refreshProjectFiles`
  - Single refresh path via LSP reload only

### Technical Details
- Deduplication algorithm: groups occurrences by `file|context|field`, sorts by line descending, removes near-duplicates
- Cache invalidation: hash changes trigger tree rebuild, otherwise skips `_onDidChangeTreeData.fire()`
- Memory impact: minimal (~100 bytes per explorer for hash storage)
- Performance gain: O(1) hash comparison vs O(n) tree rebuild

## [0.5.4] - 2026-02-04

### Fixed
- **Code Explorer**: Occurrence counts now reflect resolved occurrences (CODE/CHAIN) instead of raw usage totals.
- **Go to Definition/Rename**: Symbol position resolution now validates the token location before invoking LSP.

## [0.5.3] - 2026-02-04

### Changed
- **File Watchers**: Consolidated from 4 separate watchers into 1 unified watcher with glob pattern `**/*.{syn,syno,synp,synt}`
- **Debounced Refresh**: Added 300ms debounce to file watcher refreshes to prevent cascade of multiple refreshes when multiple files change

### Removed
- **Editor Config Modification**: Removed automatic `wordWrap: on` setting that was modifying user preferences without consent

### Performance
- Reduced file watcher overhead by ~75% (4 watchers → 1)
- Eliminated redundant refresh calls via debouncing
- Removed blocking I/O during activation (editor config write)

## [0.5.2] - 2026-02-03

### Fixed
- **Relations/Codes/Ontology**: Improved path normalization (including `file://` URIs) to restore navigation to source locations.
- **Go to Definition**: Uses first occurrence with a valid file before falling back to text search.

### Changed
- **Ontology Explorers**: Now consume LSP-only data (`getOntologyTopics` / `getOntologyAnnotations`).
- **LSP Validation**: Added custom method checks for ontology endpoints.

## [0.5.1] - 2026-02-03

### Fixed
- **SynesisParser**: Fixed duplicate field handling - fields with same name now correctly accumulate in arrays instead of overwriting
- **AbstractViewer**: Fixed display of multiple notes and chains - now creates separate excerpts for each (note, chain) pair instead of concatenating all values
- **OntologyAnnotationExplorer**: Fixed crash when processing array field values - added proper array handling for duplicate fields
- **Code Explorer**: Fixed non-clickable occurrences - added null checks for file paths and fallback display when location unavailable
- **Relation Explorer**: Fixed non-clickable triplets - added null checks and visual feedback (question mark icon) for items without location
- **GraphViewer**: Added local fallback for bibref extraction when LSP not available - now works without LSP using SynesisParser
- **Explorer Titles**: Added visual feedback showing "(LSP Loading...)" during LSP initialization

### Added
- **Comprehensive Diagnostic Logging**: Added extensive console logging in DataService, CodeExplorer, RelationExplorer for troubleshooting
  - Logs workspaceRoot, raw LSP data, and processed file paths
  - Warnings for null/undefined file paths
  - Helps identify LSP data issues quickly
- **Null-Safe TreeItems**: Code and Relation explorers now handle missing file locations gracefully
- **Visual Indicators**: Items without locations show question mark icon and "(no location)" description
- **Documentation**: Created BUGS_FIXED.md documenting all issues and fixes, RELOAD_EXTENSION.md with testing instructions

### Changed
- **Field Value Collection**: `collectFieldValues()` in AbstractViewer now properly handles both string and array field values
- **Explorer Error Handling**: Explorers now continue working even when some items lack location data
- **Path Resolution**: Enhanced path resolution logging in DataService for easier debugging

### Technical Details
- Modified `_addFieldValue()` in SynesisParser to accumulate duplicate fields into arrays
- Updated `collectFieldValues()` to iterate over array values when present
- Added `_findBibrefLocal()` to GraphViewer with three fallback strategies (ITEM → SOURCE → inline)
- Enhanced OccurrenceTreeItem and TripletTreeItem with null checks before accessing file paths
- Added `updateExplorerTitles()` function for LSP status feedback

### Breaking Changes
None - all changes are backward compatible

### Known Issues
- GraphViewer may show all chains from project instead of filtering by bibref (LSP server issue, not extension)

## [0.5.0] - 2026-02-02

### Added
- **LSP Strict Mode Now Default**: `synesisExplorer.lsp.strict` now defaults to `true` for LSP-only operation
- **New LSP Endpoints Support**: Added DataService methods for `synesis/getOntologyTopics` and `synesis/getOntologyAnnotations`
- **LSP-Exclusive Methods**: Ontology methods added to exclusive methods set (no regex fallback)
- **Deprecation Warnings**: LocalRegexProvider logs warnings when fallback to regex parsing occurs
- **LSP Capabilities Validation**: Automatic validation of LSP server capabilities on startup with detailed warnings
- **Enhanced Debug Logging**: Comprehensive logging in DataService and GraphViewer for troubleshooting
- **Troubleshooting Guide**: New `LSP_TROUBLESHOOTING.md` with diagnostic checklist and common solutions

### Changed
- **100% LSP Coverage**: All data retrieval now operates via LSP by default
- **No Regex Fallback by Default**: Local regex parsing only used if LSP unavailable and strict mode disabled
- **Improved Error Messages**: Clearer warnings when LSP is required but unavailable
- **Configuration Description**: Updated `lsp.strict` setting description for better clarity

### Technical Notes
- DataService now includes `getOntologyTopics()` and `getOntologyAnnotations()` in public API
- Both new methods added to `DEFAULT_LSP_EXCLUSIVE_METHODS` constant
- LocalRegexProvider stub methods emit console warnings (deprecated)
- `_resolveLspMethodName()` and `_emptyResultFor()` updated to support new methods
- Requires Synesis LSP v0.13.0+ for full functionality

### Migration Guide
- Users with `lsp.strict: false` in settings will need to update to `lsp.strict: true` or ensure LSP is properly installed
- Existing installations with LSP v0.13.0+ will work seamlessly
- Fallback to regex still available by setting `synesisExplorer.lsp.strict: false`

## [0.4.1] - 2026-02-01

### Added
- `synesisExplorer.lsp.args` setting to pass command arguments to the LSP executable (e.g. `["-m", "synesis_lsp"]`)

## [0.4.0] - 2025-01-31

### Added
- **LSP Integration**: Full Language Server Protocol support with automatic fallback to local regex parsing
  - Synesis LSP client (`vscode-languageclient` v9.x) connecting to Python-based LSP server
  - DataService adapter pattern: LSP-first with silent fallback to local parsing
  - Configurable via `synesisExplorer.lsp.enabled` and `synesisExplorer.lsp.pythonPath`
  - Status bar indicator showing LSP connection state
  - `Synesis: LSP Load Project` command for manual project loading
  - Auto-reload on file save (`.syn`, `.syno`, `.synp`, `.synt`, `.bib`)
- **Go to Definition**: Right-click a code in the Code Explorer to navigate to its ontology definition (`.syno`)
  - Requires LSP for cross-file definition resolution
- **Rename Symbol**: Right-click to rename codes or references across all workspace files
  - `Rename Code` in Code Explorer context menu
  - `Rename Reference` in Reference Explorer context menu
  - Cross-file rename powered by LSP `textDocument/rename`
- **LSP-powered features** (automatic when LSP is connected):
  - Diagnostics (syntax error squiggles)
  - Semantic token highlighting
  - Document symbols (Outline view)
  - Hover information for `@bibref`, fields, and codes
  - Inlay hints (author, year) after `@bibref`
  - Go-to-Definition via `Ctrl+Click`
  - Autocomplete for `@bibrefs`, ontology codes, and template fields
  - Signature help for field types
  - Rename via `F2`

### Changed
- **Reference Explorer**: Now uses DataService instead of direct parser access
- **Code Explorer**: Now uses DataService; codes show differentiated icons for ontology-defined vs. usage-only
- **Relation Explorer**: Now uses DataService; `hasChains` context derived from data availability
- **Graph Viewer**: Now uses DataService (`getRelationGraph`); removed ~150 lines of local chain parsing
- Extracted `mermaidUtils.js` for reusable Mermaid graph generation

### Technical Notes
- DataService implements Adapter Pattern with `LspDataProvider` and `LocalRegexProvider`
- All explorers and Graph Viewer consume normalized data shapes from DataService
- LSP fallback is transparent: `_tryLspThenLocal()` with warning-level logging
- Bundle includes all new modules via esbuild

## [0.3.0] - 2025-01-14

### Added
- **Ontology Topics Explorer**: New tree view for browsing TOPIC, ORDERED, and ENUMERATED fields in `.syno` files
- **Ontology Annotations Explorer**: View ontology annotations directly from `.syn` files
- New commands: `synesis.ontology.refresh` and `synesis.ontology.filter`
- Conditional view visibility based on active file type (`.syn` vs `.syno`)

### Changed
- Views now dynamically show/hide based on file context
- Improved context awareness for ontology-related features

## [0.2.0] - 2025-01-14

### Added
- **Relation Explorer**: Tree view for CHAIN relations with triplet visualization (A → REL → B)
- **Graph Viewer**: Interactive Mermaid.js visualization for relation graphs
- **Abstract Viewer**: BibTeX abstract display with highlighted excerpts
- Chain parser for extracting relation triplets
- Keyboard shortcuts:
  - `Ctrl+Alt+G` (Mac: `Cmd+Shift+G`): Show Relation Graph
  - `Ctrl+Shift+A` (Mac: `Cmd+Shift+A`): Show Abstract
- File icon theme for Synesis and BibTeX files

### Changed
- Enhanced syntax highlighting with dark and light themes
- Improved parser performance for large files

## [0.1.0] - 2025-01-13

### Added
- **Initial release**
- **Reference Explorer**: Tree view listing all `SOURCE @bibref` with ITEM counts
- **Code Explorer**: Tree view for CODE and CHAIN field values
- Basic syntax highlighting for `.syn`, `.synt`, `.synp`, `.syno` files
- Workspace scanner for automatic file discovery
- Template manager with lazy loading and caching
- Navigation support (click to jump to source location)
- Auto-refresh on file save
- Regex-based parser (MVP solution)

### Technical Notes
- Parser uses regex instead of Lark.js due to Unicode property incompatibility (`\p{L}`)
- Fallback to default templates when `.synt` not available

## [Unreleased]

### Changed
- Removed local regex fallback; all data requests are LSP-only
- Removed `synesisExplorer.lsp.strict` setting (LSP is always required)

### Planned
- Smart snippets for ITEM/ONTOLOGY blocks
- Smart Paste command for quick item creation
- Ontology Explorers via LSP (requires new server endpoints)
- Abstract Viewer via LSP (requires new server endpoint)

---

[0.4.0]: https://github.com/your-username/synesis-explorer/releases/tag/v0.4.0
[0.4.1]: https://github.com/your-username/synesis-explorer/releases/tag/v0.4.1
[0.3.0]: https://github.com/your-username/synesis-explorer/releases/tag/v0.3.0
[0.2.0]: https://github.com/your-username/synesis-explorer/releases/tag/v0.2.0
[0.1.0]: https://github.com/your-username/synesis-explorer/releases/tag/v0.1.0
