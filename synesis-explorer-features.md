# Synesis Explorer — Estudo de Features vs. Pyright (World-Class LSP)

> Referência: `vscode-pyright` (Pyright/Pylance) — a extensão LSP mais completa para linguagens tipadas/declarativas.
> Data: 2026-03-15 | Extensão: v0.5.20 | LSP: v0.14.30

---

## Sumário Executivo

O servidor LSP Synesis **já implementa** 11 recursos de edição inteligente:
completion, hover, definition, references, signatureHelp, codeAction,
documentSymbol, semanticTokens, rename, inlayHints e diagnostics.

Porém a extensão VSCode **não está configurada** para consumir vários deles.
O `vscode-languageclient` v9 registra providers automaticamente quando o
servidor os declara, mas temas sem `semanticHighlighting`, falta de
middleware e ausência de configurações impedem que esses recursos funcionem
ou sejam controláveis pelo usuário.

Foram identificados **12 gaps funcionais**, dos quais **7 podem ser
resolvidos apenas na extensão** (sem alterar o LSP).

---

## Inventário de Recursos: LSP Server vs. Extensão vs. Pyright

| Recurso LSP | Server Synesis | Extensão Synesis | Pyright |
|---|:---:|:---:|:---:|
| Completion (autocomplete) | Sim (`@`, `:`, `>`) | Passivo (client auto) | Sim + resolve + snippets |
| Hover (tooltip) | Sim (context-aware) | Passivo (client auto) | Sim + Markdown rico |
| Go to Definition | Sim (@bibref, code) | Sim (F12 + explorer) | Sim + TypeDef + Declaration |
| Find All References | Sim (codes, bibrefs) | Passivo (client auto) | Sim + progress |
| Signature Help | Sim (trigger `:`) | Passivo (client auto) | Sim (`(`, `,`, `)`) |
| Code Actions (quick fix) | Sim (3 tipos) | Passivo (client auto) | Sim + organize imports |
| Document Symbol (outline) | Sim (hierárquico) | Passivo (client auto) | Sim |
| Semantic Tokens | Sim (6 tipos AST) | **Desativado nos temas** | Sim + semanticTokenScopes |
| Rename (workspace-wide) | Sim + prepareRename | Sim (F2 + explorer) | Sim |
| Inlay Hints | Sim ("Author, Year") | Passivo (sem config) | Sim + settings granulares |
| Diagnostics | Sim (template + workspace) | Passivo (client auto) | Sim + tags + pull mode |
| Diagnostic Tags | **Ausente** | N/A | Sim (Unnecessary, Deprecated) |
| Document Highlight | **Ausente** | N/A | Sim |
| Workspace Symbols (Ctrl+T) | **Ausente** | N/A | Sim |
| Folding Range (AST) | **Ausente** (regex only) | Regex em lang-config | Sim (AST) |
| Progress Reporting | **Ausente** | Manual ("Loading...") | Sim ($/progress) |
| Middleware (enriquecimento) | N/A | **Ausente** | Sim (config, hover) |
| Feature Settings (toggles) | N/A | **Ausente** (3 settings) | Sim (100+ settings) |
| Capability Validation | N/A | **Parcial** (5 de 11) | Completa |

**Legenda:** "Passivo (client auto)" = o server fornece, o `vscode-languageclient`
consome automaticamente, mas a extensão não configura nem enriquece.

---

## Os 12 Gaps Funcionais

### Classificação por dependência

| # | Gap | Apenas Extensão? | Esforço |
|---|-----|:-:|---|
| 1 | Semantic Tokens nos temas | Sim | Pequeno |
| 2 | Diagnostics em GUIDELINES | Não (server) | Pequeno |
| 3 | Feature Settings + toggles | Sim | Médio |
| 4 | Diagnostic Tags | Não (server) | Pequeno |
| 5 | Document Highlight | Não (server) | Médio |
| 6 | Inlay Hints configurável | Sim | Pequeno |
| 7 | Middleware hover/completion | Sim | Médio |
| 8 | Capability Validation completa | Sim | Trivial |
| 9 | Code Action Kinds no package.json | Sim | Trivial |
| 10 | Folding Range via AST | Não (server) | Médio |
| 11 | Workspace Symbols | Não (server) | Médio |
| 12 | Progress Reporting | Não (server) | Médio |

---

## Etapas de Implementação

### ETAPA 1 — Ativar Semantic Tokens nos Temas (Apenas Extensão)

**Impacto: CRITICO** | Esforço: Pequeno | Dependência LSP: Nenhuma

O servidor já envia 6 tipos de tokens semânticos via AST:

| Token LSP | Significado Synesis | Exemplo |
|---|---|---|
| `keyword` | Blocos estruturais | `SOURCE`, `ITEM`, `END ITEM` |
| `variable` | Referências bibliográficas | `@Smith2024` |
| `property` | Nomes de campo (com `:`) | `code:`, `text:`, `method:` |
| `string` | Valores de campo | `"qualitative approach"` |
| `enumMember` | Códigos ontológicos | `CCS_Support`, `Trust` |
| `namespace` | Metadados de projeto | `PROJECT`, `TEMPLATE`, `INCLUDE` |

**Problema:** Os temas `synesis-dark-theme.json` e `synesis-light-theme.json`
não têm `semanticHighlighting: true` nem `semanticTokenColors`. O editor
recebe os tokens mas **ignora-os completamente**, caindo no TextMate regex.

**Ação:**
1. Adicionar `"semanticHighlighting": true` em ambos os temas
2. Adicionar bloco `"semanticTokenColors"` com mapeamento dos 6 tipos
3. Adicionar `"semanticTokenScopes"` em `package.json` (compatibilidade com temas de terceiros)

**Arquivos:**
- `themes/synesis-dark-theme.json`
- `themes/synesis-light-theme.json`
- `package.json`

---

### ETAPA 2 — Feature Settings e Middleware Base (Apenas Extensão)

**Impacto: ALTO** | Esforço: Médio | Dependência LSP: Nenhuma

**Problema:** Apenas 3 settings existem (`lsp.enabled`, `lsp.pythonPath`, `lsp.args`).
O usuário não pode habilitar/desabilitar features individuais.

**Ação:**
1. Adicionar em `package.json` → `contributes.configuration.properties`:
   - `synesisExplorer.diagnostics.enabled` (boolean, default: true)
   - `synesisExplorer.inlayHints.enabled` (boolean, default: true)
   - `synesisExplorer.semanticHighlighting.enabled` (boolean, default: true)
   - `synesisExplorer.completion.autoImportCodes` (boolean, default: true)
2. Adicionar propriedade `middleware` no `clientOptions` em `synesisClient.js`:
   - Interceptar e suprimir respostas quando features estão desabilitadas
   - Forward settings da extensão para o servidor via `workspace.configuration`
3. Escutar `onDidChangeConfiguration` para atualizar em runtime

**Arquivos:**
- `package.json`
- `src/lsp/synesisClient.js`

---

### ETAPA 3 — Inlay Hints Configurável (Apenas Extensão)

**Impacto: MEDIO** | Esforço: Pequeno | Dependência LSP: Nenhuma

O servidor já envia `"(Author, Year)"` após cada `@bibref`. O client consome
automaticamente. Falta apenas o setting para o usuário desabilitar.

**Ação:** Incluído na Etapa 2 (setting `synesisExplorer.inlayHints.enabled` + middleware
que retorna `null` quando desabilitado).

---

### ETAPA 4 — Middleware Enriquecido para Hover/Completion (Apenas Extensão)

**Impacto: MEDIO** | Esforço: Médio | Dependência LSP: Nenhuma

**Problema:** O `clientOptions` em `synesisClient.js` não tem `middleware`.
Zero interceptação de respostas LSP.

**Ação:** Adicionar ao `middleware` (base criada na Etapa 2):
- `provideHover`: Adicionar command links "Show in Explorer" nos hovers de
  `@bibrefs` e códigos; melhorar formatação Markdown
- `provideCompletionItem`: Sorting customizado, ícones por tipo de completion
- `provideDocumentSymbols`: Enriquecer com ícones Synesis-específicos

**Arquivos:**
- `src/lsp/synesisClient.js`

---

### ETAPA 5 — Capability Validation Completa (Apenas Extensão)

**Impacto: MEDIO** | Esforço: Trivial | Dependência LSP: Nenhuma

**Problema:** `validateLspCapabilities()` em `extension.js:955` verifica apenas
5 capabilities (Hover, Definition, DocumentSymbol, Rename, Completion).
Ignora SemanticTokens, InlayHints, SignatureHelp, CodeAction, References.

**Ação:** Expandir a função para logar todas as 11 capabilities. Separar em
"required" (erro se ausente) e "optional" (warning informativo).

**Arquivos:**
- `extension.js` (função `validateLspCapabilities`)

---

### ETAPA 6 — Code Action Kinds no package.json (Apenas Extensão)

**Impacto: BAIXO** | Esforço: Trivial | Dependência LSP: Nenhuma

O servidor envia `CodeActionKind.QuickFix` mas `package.json` não declara isso.
O `vscode-languageclient` funciona sem, mas declarar melhora o menu de contexto.

**Ação:** Verificar se `codeActionKinds` precisa ser declarado ou se já funciona
transparentemente. Se necessário, adicionar ao `contributes`.

**Arquivos:**
- `package.json`

---

### ETAPA 7 — Diagnostics em GUIDELINES (Requer LSP)

**Impacto: CRITICO** | Esforço: Pequeno | Dependência LSP: Sim

O `template_diagnostics.py` interpreta conteúdo dentro de
`GUIDELINES...END GUIDELINES` como campos, gerando falsos positivos.

**Ação:** Corrigir `_parse_blocks` em `template_diagnostics.py` para pular
blocos GUIDELINES.

**Arquivos:**
- `synesis-lsp/synesis_lsp/template_diagnostics.py`

---

### ETAPA 8 — Diagnostic Tags (Requer LSP)

**Impacto: ALTO** | Esforço: Pequeno | Dependência LSP: Sim

Adicionar `DiagnosticTag.Unnecessary` para campos proibidos (FORBIDDEN)
e códigos não referenciados. Visualmente: texto esmaecido em vez de sublinhado.

**Arquivos:**
- `synesis-lsp/synesis_lsp/converters.py`
- `synesis-lsp/synesis_lsp/template_diagnostics.py`

---

### ETAPA 9 — Document Highlight (Requer LSP)

**Impacto: ALTO** | Esforço: Médio | Dependência LSP: Sim

Ao posicionar o cursor em `@bibref` ou código, todas as ocorrências no
documento são realçadas instantaneamente.

**Arquivos:**
- `synesis-lsp/synesis_lsp/document_highlight.py` (novo)
- `synesis-lsp/synesis_lsp/server.py`

---

### ETAPA 10 — Workspace Symbols (Requer LSP)

**Impacto: MEDIO** | Esforço: Médio | Dependência LSP: Sim

"Go to Symbol in Workspace" (Ctrl+T) para buscar SOURCE, ITEM, ONTOLOGY
em todos os arquivos.

**Arquivos:**
- `synesis-lsp/synesis_lsp/workspace_symbols.py` (novo)
- `synesis-lsp/synesis_lsp/server.py`

---

### ETAPA 11 — Folding Range via AST (Requer LSP)

**Impacto: BAIXO** | Esforço: Médio | Dependência LSP: Sim

Substituir o folding regex por `textDocument/foldingRange` via AST.
Mais preciso para blocos aninhados (FIELD dentro de ONTOLOGY, GUIDELINES
dentro de FIELD).

**Arquivos:**
- `synesis-lsp/synesis_lsp/folding_range.py` (novo)
- `synesis-lsp/synesis_lsp/server.py`

---

### ETAPA 12 — Progress Reporting (Requer LSP)

**Impacto: BAIXO** | Esforço: Médio | Dependência LSP: Sim

Barra de progresso nativa durante `synesis/loadProject` e validação workspace-wide.

**Arquivos:**
- `synesis-lsp/synesis_lsp/server.py`

---

## Proposta de Paleta de Cores

### Filosofia de Design

A paleta segue princípios de tipografia acadêmica e cartografia do conhecimento:
- **Hierarquia visual clara:** estrutura (keywords) em destaque, dados (valores) em tom neutro
- **Harmonia cromática:** cores complementares com suficiente contraste (WCAG AA)
- **Semântica intuitiva:** cada cor comunica uma função — não é decoração
- **Coerência light/dark:** mesma lógica cromática, ajustada para cada fundo

### Synesis Dark — Paleta "Midnight Scholar"

Fundo: `#1a1b26` (azul-noite profundo, menos cansativo que preto puro)

| Elemento | Cor | Hex | Justificativa |
|---|---|---|---|
| **Fundo do editor** | Azul-noite | `#1a1b26` | Reduz fadiga vs. `#1e1e1e`; tom frio evoca profundidade |
| **Texto base** | Cinza-prata | `#c0caf5` | Alto contraste suave, legível por horas |
| **Keywords (SOURCE, ITEM, END)** | Rosa-magenta | `#bb9af7` | Chama atenção sem agredir; associação com "estrutura" |
| **Keywords declaration** | Rosa-magenta bold | `#bb9af7` bold | Modifier `declaration` reforça com bold |
| **@bibrefs** | Laranja-dourado | `#e0af68` | Dourado = referência, citação, autoridade |
| **@bibrefs underline** | Laranja-dourado | `#e0af68` underline | Clicável, navegável |
| **Nomes de campo (code:, text:)** | Azul-celeste | `#7dcfff` | Campos = estrutura de dados, tom técnico |
| **Nomes de campo bold** | Azul-celeste | `#7dcfff` bold | Destaque do rótulo |
| **Valores de campo** | Verde-salvia | `#9ece6a` | Dados = crescimento, conteúdo vivo |
| **Códigos ontológicos** | Cyan-turquesa | `#2ac3de` | Conceitos = precisão, taxonomia |
| **Relações (INFLUENCES, ENABLES)** | Coral-vibrante | `#f7768e` | Verbos = ação, energia |
| **Setas (->)** | Cinza-médio | `#565f89` | Pontuação neutra, não distrai |
| **Namespace (PROJECT, TEMPLATE)** | Azul-lavanda | `#7aa2f7` | Meta-estrutura, nível acima |
| **Strings ("quoted")** | Verde-salvia | `#9ece6a` | Consistente com valores |
| **Comentários** | Cinza-noturno italic | `#565f89` | Recua visualmente, não compete |

**Semantic Token Colors (Dark):**

```json
{
  "keyword":    "#bb9af7",
  "variable":   "#e0af68",
  "property":   "#7dcfff",
  "string":     "#9ece6a",
  "enumMember": "#2ac3de",
  "namespace":  "#7aa2f7"
}
```

### Synesis Light — Paleta "Parchment & Ink"

Fundo: `#faf4ed` (pergaminho quente, mais agradável que branco puro)

| Elemento | Cor | Hex | Justificativa |
|---|---|---|---|
| **Fundo do editor** | Pergaminho | `#faf4ed` | Quente, evoca papel acadêmico |
| **Texto base** | Tinta-sépia | `#575279` | Contraste suficiente sem a dureza do preto |
| **Keywords (SOURCE, ITEM, END)** | Púrpura-real | `#8839ef` | Nobre, estrutural, distinto |
| **Keywords declaration** | Púrpura-real bold | `#8839ef` bold | Modifier `declaration` |
| **@bibrefs** | Âmbar-escuro | `#df8e1d` | Dourado acadêmico sobre fundo claro |
| **@bibrefs underline** | Âmbar-escuro | `#df8e1d` underline | Navegável |
| **Nomes de campo** | Azul-tinta | `#1e66f5` | Clássico, legível, técnico |
| **Nomes de campo bold** | Azul-tinta | `#1e66f5` bold | Rótulo destacado |
| **Valores de campo** | Verde-floresta | `#40a02b` | Dados vivos sobre pergaminho |
| **Códigos ontológicos** | Teal-profundo | `#179299` | Taxonomia, precisão |
| **Relações** | Vermelho-terracota | `#d20f39` | Ação, energia sobre fundo claro |
| **Setas (->)** | Cinza-quente | `#9893a5` | Pontuação discreta |
| **Namespace** | Azul-índigo | `#7287fd` | Meta-estrutura, harmônico com púrpura |
| **Strings ("quoted")** | Verde-floresta | `#40a02b` | Consistente com valores |
| **Comentários** | Cinza-lavanda italic | `#9893a5` | Recua, não compete |

**Semantic Token Colors (Light):**

```json
{
  "keyword":    "#8839ef",
  "variable":   "#df8e1d",
  "property":   "#1e66f5",
  "string":     "#40a02b",
  "enumMember": "#179299",
  "namespace":  "#7287fd"
}
```

### Comparação Visual (antes vs. depois)

**Antes (tema dark atual):**
```
SOURCE @Smith2024          ← tudo vermelho (#f44747) para keywords
  code: Trust, CCS_Support ← cyan (#00bcd4) + azul (#64b5f6)
  text: qualitative study   ← laranja desbotado (#ce9178)
END SOURCE                  ← mesmo vermelho
```

**Depois (Midnight Scholar):**
```
SOURCE @Smith2024          ← rosa-magenta (SOURCE) + dourado (@Smith2024)
  code: Trust, CCS_Support ← azul-celeste (code:) + turquesa (Trust, CCS_Support)
  text: qualitative study   ← azul-celeste (text:) + verde-salvia (valor)
END SOURCE                  ← rosa-magenta (END SOURCE)
```

A diferença-chave: **cada elemento tem sua própria cor** em vez de categorias
amplas com a mesma cor. O olho distingue instantaneamente:
- Estrutura (rosa-magenta) de dados (verde)
- Referências (dourado) de códigos (turquesa)
- Campos (azul-celeste) de valores (verde-salvia)

---

## JSON Completo dos Temas Propostos

### synesis-dark-theme.json (proposta)

```json
{
  "name": "Synesis Dark",
  "type": "dark",
  "semanticHighlighting": true,
  "colors": {
    "editor.background": "#1a1b26",
    "editor.foreground": "#c0caf5"
  },
  "semanticTokenColors": {
    "keyword": "#bb9af7",
    "keyword.declaration": { "foreground": "#bb9af7", "fontStyle": "bold" },
    "variable": "#e0af68",
    "property": { "foreground": "#7dcfff", "fontStyle": "bold" },
    "string": "#9ece6a",
    "enumMember": "#2ac3de",
    "namespace": "#7aa2f7"
  },
  "tokenColors": [
    {
      "name": "Keywords (TextMate fallback)",
      "scope": [
        "keyword.control.block.synesis",
        "keyword.control.field.synesis",
        "keyword.control.type.synesis",
        "keyword.control.scope.synesis"
      ],
      "settings": {
        "foreground": "#bb9af7",
        "fontStyle": "bold"
      }
    },
    {
      "name": "References (@bibref)",
      "scope": "entity.name.reference.synesis",
      "settings": {
        "foreground": "#e0af68",
        "fontStyle": "underline"
      }
    },
    {
      "name": "Field Names",
      "scope": [
        "entity.name.tag.field.synesis",
        "entity.name.field.synesis"
      ],
      "settings": {
        "foreground": "#7dcfff",
        "fontStyle": "bold"
      }
    },
    {
      "name": "Codes (ontology concepts)",
      "scope": "variable.other.code.synesis",
      "settings": {
        "foreground": "#2ac3de"
      }
    },
    {
      "name": "Relations (INFLUENCES, ENABLES, ...)",
      "scope": "constant.language.relation.synesis",
      "settings": {
        "foreground": "#f7768e",
        "fontStyle": "bold"
      }
    },
    {
      "name": "Chain Arrows (->)",
      "scope": "keyword.operator.arrow.synesis",
      "settings": {
        "foreground": "#565f89"
      }
    },
    {
      "name": "Field Values",
      "scope": [
        "string.quoted.field.synesis",
        "string.unquoted.field.synesis"
      ],
      "settings": {
        "foreground": "#9ece6a"
      }
    },
    {
      "name": "Comments",
      "scope": [
        "comment.line.synesis",
        "comment.line.number-sign.synesis"
      ],
      "settings": {
        "foreground": "#565f89",
        "fontStyle": "italic"
      }
    },
    {
      "name": "Comma Separators",
      "scope": "punctuation.separator.comma.synesis",
      "settings": {
        "foreground": "#565f89"
      }
    }
  ]
}
```

### synesis-light-theme.json (proposta)

```json
{
  "name": "Synesis Light",
  "type": "light",
  "semanticHighlighting": true,
  "colors": {
    "editor.background": "#faf4ed",
    "editor.foreground": "#575279"
  },
  "semanticTokenColors": {
    "keyword": "#8839ef",
    "keyword.declaration": { "foreground": "#8839ef", "fontStyle": "bold" },
    "variable": "#df8e1d",
    "property": { "foreground": "#1e66f5", "fontStyle": "bold" },
    "string": "#40a02b",
    "enumMember": "#179299",
    "namespace": "#7287fd"
  },
  "tokenColors": [
    {
      "name": "Keywords (TextMate fallback)",
      "scope": [
        "keyword.control.block.synesis",
        "keyword.control.field.synesis",
        "keyword.control.type.synesis",
        "keyword.control.scope.synesis"
      ],
      "settings": {
        "foreground": "#8839ef",
        "fontStyle": "bold"
      }
    },
    {
      "name": "References (@bibref)",
      "scope": "entity.name.reference.synesis",
      "settings": {
        "foreground": "#df8e1d",
        "fontStyle": "underline"
      }
    },
    {
      "name": "Field Names",
      "scope": [
        "entity.name.tag.field.synesis",
        "entity.name.field.synesis"
      ],
      "settings": {
        "foreground": "#1e66f5",
        "fontStyle": "bold"
      }
    },
    {
      "name": "Codes (ontology concepts)",
      "scope": "variable.other.code.synesis",
      "settings": {
        "foreground": "#179299"
      }
    },
    {
      "name": "Relations (INFLUENCES, ENABLES, ...)",
      "scope": "constant.language.relation.synesis",
      "settings": {
        "foreground": "#d20f39",
        "fontStyle": "bold"
      }
    },
    {
      "name": "Chain Arrows (->)",
      "scope": "keyword.operator.arrow.synesis",
      "settings": {
        "foreground": "#9893a5"
      }
    },
    {
      "name": "Field Values",
      "scope": [
        "string.quoted.field.synesis",
        "string.unquoted.field.synesis"
      ],
      "settings": {
        "foreground": "#40a02b"
      }
    },
    {
      "name": "Comments",
      "scope": [
        "comment.line.synesis",
        "comment.line.number-sign.synesis"
      ],
      "settings": {
        "foreground": "#9893a5",
        "fontStyle": "italic"
      }
    },
    {
      "name": "Comma Separators",
      "scope": "punctuation.separator.comma.synesis",
      "settings": {
        "foreground": "#9893a5"
      }
    }
  ]
}
```

---

## semanticTokenScopes para package.json

Adicionar ao `contributes` do `package.json` para garantir compatibilidade
com temas de terceiros (Dark+, Monokai, Solarized, etc.):

```json
"semanticTokenScopes": [
  {
    "language": "synesis",
    "scopes": {
      "keyword":    ["keyword.control.block.synesis"],
      "variable":   ["entity.name.reference.synesis"],
      "property":   ["entity.name.tag.field.synesis"],
      "string":     ["string.quoted.field.synesis"],
      "enumMember": ["variable.other.code.synesis"],
      "namespace":  ["keyword.control.block.synesis"]
    }
  }
]
```

Isso permite que temas que não têm `semanticTokenColors` para Synesis
usem os mesmos escopos TextMate — o fallback funciona em qualquer tema.

---

## Resumo de Prioridades

### Implementáveis SEM alterar o LSP (Etapas 1-6)

| Etapa | O que | Esforço | Arquivos |
|---|---|---|---|
| 1 | Semantic Tokens nos temas + `semanticTokenScopes` | Pequeno | `themes/*.json`, `package.json` |
| 2 | Feature Settings + middleware base | Médio | `package.json`, `synesisClient.js` |
| 3 | Inlay Hints configurável (dentro da Etapa 2) | Pequeno | (mesmo da Etapa 2) |
| 4 | Middleware enriquecido (hover links, completion sort) | Médio | `synesisClient.js` |
| 5 | Capability Validation completa (11 capabilities) | Trivial | `extension.js` |
| 6 | Code Action Kinds no package.json | Trivial | `package.json` |

### Requerem alteração no LSP (Etapas 7-12)

| Etapa | O que | Esforço | Arquivos |
|---|---|---|---|
| 7 | Diagnostics em GUIDELINES (bug fix) | Pequeno | `template_diagnostics.py` |
| 8 | Diagnostic Tags (Unnecessary/Deprecated) | Pequeno | `converters.py` |
| 9 | Document Highlight | Médio | `document_highlight.py` (novo) |
| 10 | Workspace Symbols (Ctrl+T) | Médio | `workspace_symbols.py` (novo) |
| 11 | Folding Range via AST | Médio | `folding_range.py` (novo) |
| 12 | Progress Reporting | Médio | `server.py` |

---

## Verificação por Etapa

- **Etapa 1:** Abrir `.syn` com tema Synesis Dark/Light. `@bibrefs` em dourado/âmbar,
  `code:` em azul-celeste/azul-tinta, valores em verde, keywords em rosa/púrpura.
  Semantic tokens visíveis no Developer Tools (Ctrl+Shift+P > "Inspect Editor Tokens").
- **Etapa 2:** File > Preferences > Settings > pesquisar "Synesis Explorer".
  Deve mostrar toggles para diagnostics, inlay hints, semantic highlighting.
- **Etapa 4:** Hover sobre `@bibref` → tooltip com link "Show in Explorer".
- **Etapa 5:** Output channel "Synesis LSP" → lista 11 capabilities validadas.
- **Etapa 7:** Conteúdo dentro de GUIDELINES sem diagnósticos falsos.
- **Etapa 9:** Cursor em `@bibref` → todas ocorrências no arquivo realçadas.
- **Etapa 10:** Ctrl+T → buscar "SOURCE" → lista todos os SOURCE blocks do projeto.
