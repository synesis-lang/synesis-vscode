# Plano de Implantação de Testes — Synesis Explorer

> Estudo para implantar uma suíte de testes na extensão VSCode **synesis-explorer**, espelhando o molde de testes do compilador **synesis** (`pytest` + fixtures de projeto).
>
> **Data:** 2026-06-22 · **Versão alvo da extensão:** 0.5.30

---

## 1. Diagnóstico do estado atual

| Item | Situação |
|------|----------|
| Script `npm run test` | Aponta para `./test/runTest.js` — **arquivo inexistente** |
| Runner configurado | Nenhum (`mocha` e `chai` já estão em `devDependencies`, mas sem harness) |
| `@vscode/test-electron` | **Ausente** das dependências |
| Testes existentes | **Zero** arquivos `*.test.js` / `*.spec.js` |
| Fixtures | Apenas `test/fixtures/bibliometrics/` (projeto Synesis completo: `.synp/.synt/.syn/.syno/.bib`) |
| CI | Nenhum workflow de testes |

**Conclusão:** o tooling está declarado mas nunca foi cabeado. A implantação parte praticamente do zero, mas as dependências-base (`mocha@10`, `chai@4`) já existem.

---

## 1.5. Princípio arquitetural: dependência máxima do LSP (eliminação de regex)

> **Diretriz de design (precede e condiciona o plano de testes):** a extensão deve depender ao máximo do **Synesis LSP** para identificação de campos, códigos, relações e comandos da linguagem. **Regex hardcoded de reconhecimento da gramática Synesis é um anti-padrão a ser eliminado** — a fonte de verdade da sintaxe é o compilador (via LSP), não a extensão. Isso evita divergência quando a linguagem evolui (ex.: o recém-adicionado `OPTIONAL BUNDLE`).

### 1.5.1. Estado atual do acoplamento

| Camada | Acoplamento | Situação |
|--------|-------------|----------|
| `services/dataService.js` | **100% LSP** (`synesis/getReferences`, `getCodes`, `getRelations`, `getRelationGraph`, `getOntologyTopics`, `getOntologyAnnotations`, `getExcerpts`) com fallback snake_case | ✅ exemplar — é o molde a seguir |
| `parsers/*` (5 arquivos) | **Regex hardcoded** da gramática (`.syn`, `.synt`, `.syno`, `.bib`, CHAIN) | ❌ a eliminar/reduzir |

Os parsers regex ainda têm **3 consumidores**:

| Consumidor | Parser regex usado | Endpoint LSP substituto |
|------------|--------------------|--------------------------|
| `viewers/abstractViewer.js` | `bibtexParser` + `synesisParser` | **`synesis/getAbstract` já existe no LSP** (server.py:1122) → migração imediata |
| `core/templateManager.js` | `templateParser.parse(.synt)` | **Gap:** não há `synesis/getTemplate` com field-specs estruturados |
| `services/coderService.js` | `synesisParser` | depende do que o coder precisa extrair do `.syn` |

### 1.5.2. Lacuna no LSP a fechar

O único bloqueador real para zerar o regex de gramática é a **ausência de um request `synesis/getTemplate`** que devolva os field-specs estruturados (nome, tipo, escopo, bundles — inclusive `OPTIONAL BUNDLE`). Hoje existem `synesis/getProjectStats` e os símbolos de documento, mas não o contrato de template consumível por `templateManager`/`coderService`.

> **Recomendação:** adicionar `synesis/getTemplate` ao LSP (reutilizando o `TemplateNode` do compilador) é o passo que permite remover `templateParser.js` por completo. Enquanto não existir, manter `templateParser` como **fallback explícito e documentado**, não como caminho primário.

### 1.5.3. Impacto desta diretriz sobre os testes

Esta diretriz **muda o alvo dos testes** dos parsers regex:

- **Não** investir cobertura profunda em `templateParser`/`synesisParser` como código permanente — são candidatos a remoção. Testá-los apenas o suficiente para garantir o fallback enquanto existirem.
- **Investir** em testes de contrato LSP: o `lspMock` (§5) torna-se o instrumento central — valida que a extensão consome corretamente os shapes do LSP, independente de regex.
- Adicionar um **teste de contrato de versão do LSP** (`MIN_LSP_VERSION`, hoje `0.13.0` em extension.js / README pede `0.13.0+`): garantir que os endpoints esperados existem na versão mínima declarada.

---

## 2. Mapa de testabilidade do código-fonte

A extensão divide-se claramente em duas camadas, o que define **duas estratégias de teste distintas**:

### 2.1 Camada de lógica pura (sem `require('vscode')`) — **unit tests**

Testáveis diretamente com Mocha+Chai em Node, sem harness do VSCode:

| Módulo | Responsabilidade | Alvos de teste |
|--------|------------------|----------------|
| `src/utils/positionUtils.js` | offset → linha/coluna | `buildLineOffsets`, `getLineColumn` (limites, offset 0, fim de arquivo, multilinha) |
| `src/utils/fuzzyMatcher.js` | localizar trecho em abstract | `findExcerpt` (match direto, normalizado, ausência, acentuação) |
| `src/utils/mermaidUtils.js` | IDs de nó / geração Mermaid | `ensureNodeId` (sanitização Unicode, colisão, prefixo numérico) |
| `src/parsers/chainParser.js` | parse de campos CHAIN | `parseChain` (simples vs. qualificada, vazio, relações ímpares) |
| `src/parsers/bibtexParser.js` | parse BibTeX | extração de campos, abstracts |
| `src/parsers/ontologyParser.js` | parse `.syno` | tópicos, níveis, hierarquia |
| `src/parsers/templateParser.js` ⚠️ | parse `.synt` (regex) | **transitório** — alvo de remoção (ver §1.5); testar só o fallback |
| `src/parsers/synesisParser.js` ⚠️ | parse `.syn` (regex) | **transitório** — idem |
| `src/core/fieldRegistry.js` | registro de campos | normalização, lookup |

> **Esta é a camada de maior ROI** para os módulos *não-regex* (utils, `chainParser`, `fieldRegistry`) — funções determinísticas, análogo de `test_parser.py`/`test_validator.py`. Os parsers marcados ⚠️ são **código transitório** (ver §1.5): cobrir apenas o suficiente para garantir o fallback enquanto o endpoint LSP equivalente não existe.

### 2.2 Camada acoplada ao VSCode (`require('vscode')`) — **integration tests**

12 módulos dependem da API `vscode` e exigem o harness `@vscode/test-electron` (Extension Development Host headless) **ou** um mock de `vscode`:

```
core/templateManager.js   core/workspaceScanner.js
lsp/synesisClient.js      services/dataService.js   services/coderService.js
explorers/{reference,code,relation,ontology,ontologyAnnotation}*.js
viewers/{graph,abstract}Viewer.js
```

Destes, **`dataService.js` é o mais crítico** (adapter LSP→explorers, com normalização de shapes e fallback de métodos). Ver §5.

---

## 3. Molde herdado do compilador (synesis)

A suíte do compilador (`synesis/tests/`) define o padrão a replicar:

| Padrão no compilador | Equivalente na extensão |
|----------------------|--------------------------|
| `pytest` + `conftest.py` (fixtures de string-template) | `mocha` + `test/helpers/` (builders de projeto) |
| `tests/fixtures/T0x-Nome/` (projeto completo por cenário) | `test/fixtures/<cenário>/` (idem) |
| `test_parser.py`, `test_validator.py` (unidade) | `test/unit/*.test.js` (parsers + utils) |
| `test_integration.py` → `_compile(project)` → checa `ecodes(r)` | `test/integration/*.test.js` → ativa extensão → checa árvores/diagnósticos |
| `ecodes()/wcodes()` helpers de asserção compacta | helpers `getTreeLabels()`, `getDiagnosticCodes()` |
| 1 fixture = 1 cenário nomeado e versionado | manter `bibliometrics/` + novos fixtures mínimos |

**Princípio-chave do molde:** cada cenário de comportamento vira uma fixture de projeto real, e o teste compila/ativa e afirma sobre o resultado estruturado — não sobre detalhes de implementação interna.

---

## 4. Arquitetura de testes proposta

```
synesis-explorer/
└── test/
    ├── runTest.js                 # entrypoint @vscode/test-electron (a criar)
    ├── suite/
    │   └── index.js               # carregador Mocha (glob **/*.test.js)
    ├── helpers/
    │   ├── projectBuilder.js      # constrói fixtures temporárias .synp/.synt/...
    │   ├── lspMock.js             # fake LspClient (respostas canned p/ dataService)
    │   └── treeAssertions.js      # getTreeLabels, getDiagnosticCodes, ...
    ├── unit/                      # NÃO precisa do harness vscode
    │   ├── positionUtils.test.js
    │   ├── fuzzyMatcher.test.js
    │   ├── mermaidUtils.test.js
    │   ├── chainParser.test.js
    │   ├── bibtexParser.test.js
    │   ├── ontologyParser.test.js
    │   ├── templateParser.test.js
    │   └── synesisParser.test.js
    ├── integration/               # roda dentro do Extension Host
    │   ├── activation.test.js     # extensão ativa em workspace com .synp
    │   ├── dataService.test.js    # adapter LSP (com lspMock)
    │   ├── referenceExplorer.test.js
    │   ├── codeExplorer.test.js
    │   ├── relationExplorer.test.js
    │   └── ontologyExplorer.test.js
    └── fixtures/
        ├── bibliometrics/         # (existente) projeto realista
        ├── minimal/               # menor projeto válido possível
        └── chains/                # projeto focado em CHAIN/relações
```

### 4.1 Dois alvos de execução

Como a camada pura **não** precisa do Electron, separar em dois comandos acelera o ciclo de feedback:

```jsonc
"scripts": {
  "test:unit": "mocha test/unit/**/*.test.js",          // rápido, Node puro
  "test:integration": "node ./test/runTest.js",         // lento, Electron
  "test": "npm run test:unit && npm run test:integration",
  "test:watch": "mocha test/unit/**/*.test.js --watch"
}
```

---

## 5. Estratégia para `dataService.js` (módulo crítico)

`dataService.js` é o ponto de integração mais frágil (já foi fonte de bugs de duplicação de ocorrências — ver memória do projeto). Tem duas naturezas:

- **`LspDataProvider`**: normaliza respostas do LSP. Lógica testável com um **`lspClient` falso** que devolve payloads canned — sem precisar de um LSP real rodando.
- **`DataService`**: orquestra acesso. Testar fallback de método (`_isMethodNotFound`, `_sendRequestWithFallback`) e os shapes documentados no cabeçalho do arquivo:

```
getReferences()  -> Array<{ bibref, itemCount, occurrences }>
getCodes()       -> Array<{ code, usageCount, ontologyDefined, occurrences }>
getRelations()   -> Array<{ relation, triplets }>
getOntologyTopics() -> Array<{ name, level, file, line, children }>
```

**Casos de regressão obrigatórios** (derivados de bugs históricos do ecossistema):
- Código que aparece N vezes no mesmo bloco ITEM **não** deve duplicar/colapsar ocorrências.
- Normalização de chave de código (`A201` vs `a201`) não deve produzir o mesmo item múltiplas vezes.
- Relação CHAIN com nome customizado deve preservar o nome (não virar `IMPLICIT`).

> O `lspMock` permite reproduzir esses payloads exatos como fixtures JSON, tornando os bugs regressões verificáveis sem o servidor Python.

---

## 6. Fixtures a criar

Seguindo o molde "1 cenário = 1 projeto":

| Fixture | Propósito | Conteúdo |
|---------|-----------|----------|
| `fixtures/minimal/` | smoke test de ativação | menor `.synp` + `.synt` + `.syn` válidos |
| `fixtures/chains/` | relações e grafo | itens com campos CHAIN qualificados e simples |
| `fixtures/lsp-payloads/*.json` | respostas canned p/ `lspMock` | saídas reais de `getCodes`/`getReferences`/`getRelations` |
| `fixtures/bibliometrics/` | (já existe) projeto realista end-to-end | reutilizar como teste de integração amplo |

---

## 7. Etapas de implantação

### Etapa 1 — Cabear o harness (desbloqueio)
1. `npm i -D @vscode/test-electron @types/mocha`.
2. Criar `test/runTest.js` (chama `runTests` apontando para `test/suite/index.js`).
3. Criar `test/suite/index.js` (Mocha que faz glob de `integration/**/*.test.js`).
4. Ajustar `scripts` em `package.json` (§4.1).
5. **Critério de pronto:** `npm run test:integration` abre o Extension Host e roda 1 teste trivial verde.

### Etapa 2 — Unit tests da camada pura (maior ROI)
1. Criar `test/unit/` com testes para os 4 utils + 4 parsers (§2.1).
2. Cada arquivo cobre caminho feliz + bordas (vazio, Unicode, limites).
3. **Critério de pronto:** `npm run test:unit` roda sem o Electron, cobre ≥80% das funções puras.

### Etapa 3 — Helpers e mocks
1. `test/helpers/projectBuilder.js` — escreve fixtures em diretório temporário (análogo ao `_compile`).
2. `test/helpers/lspMock.js` — `LspClient` falso devolvendo payloads de `fixtures/lsp-payloads/`.
3. `test/helpers/treeAssertions.js` — `getTreeLabels(provider)`, `getDiagnosticCodes(uri)`.

### Etapa 4 — Integration: `dataService` + explorers
1. `dataService.test.js` com `lspMock` (shapes + fallback + regressões da §5).
2. Um teste por explorer: ativar extensão em fixture, afirmar rótulos da árvore.
3. **Critério de pronto:** bugs históricos de duplicação têm teste de regressão verde.

### Etapa 5 — Integration: ativação e ciclo de vida
1. `activation.test.js` — extensão ativa em workspace com `.synp`; comandos registrados.
2. Verificar context keys (`synesis.hasCodes`, `synesis.activeFileKind`) reagem ao arquivo ativo.

### Etapa 6 — CI
1. Workflow GitHub Actions: matriz Node LTS, `xvfb-run` para o Electron headless no Linux.
2. Rodar `test:unit` (rápido, sempre) + `test:integration` (com `xvfb`).
3. Espelhar a estrutura de CI do compilador (lint + test gating).

---

## 8. Cobertura-alvo e priorização

| Prioridade | Camada | Justificativa |
|------------|--------|---------------|
| **P0** | `dataService.js` + parsers | maior densidade de bugs históricos; lógica pura de alto valor |
| **P1** | utils (`position`, `fuzzy`, `mermaid`) | determinísticos, baratos, alto ROI |
| **P2** | explorers (árvores) | validam contrato visível ao usuário |
| **P3** | viewers (graph/abstract) | webviews — testar geração de HTML/Mermaid, não o render |
| **P4** | ativação / context keys | smoke de ciclo de vida |

**Meta inicial realista:** P0+P1 cobertos na Etapa 2–4 (cobre o núcleo de risco sem depender do harness pesado). Integration (P2+) na sequência.

---

## 9. Riscos e mitigações

| Risco | Mitigação |
|-------|-----------|
| Integration tests lentos/instáveis (Electron) | Manter `test:unit` separado e como gate principal; integration como camada complementar |
| Dependência de LSP Python real | **Nunca** depender do servidor real nos testes — sempre `lspMock` com payloads canned |
| `esbuild` empacota em `dist/` — testar fonte ou bundle? | Testar **`src/`** diretamente (lógica), reservar bundle p/ smoke de ativação |
| Divergência de shapes LSP ao longo do tempo | Os payloads canned em `fixtures/lsp-payloads/` viram contrato versionado; quebra de shape = teste vermelho |
| `vscode` mock vs. `@vscode/test-electron` | Preferir o harness real p/ integration (fidelidade); mock só se um teste de unidade tocar `vscode` marginalmente |

---

## 10. Resumo executivo

1. O tooling está **declarado mas não cabeado** — `npm test` aponta para arquivo inexistente.
2. A maior parte do valor está na **camada de lógica pura** (utils + parsers), testável sem o Electron — espelha `test_parser.py`/`test_validator.py`.
3. **`dataService.js`** é o módulo crítico e o principal alvo de testes de regressão (bugs históricos de duplicação de ocorrências), testável via **`lspMock`** sem o LSP real.
4. Replicar o molde do compilador: **fixtures = projetos nomeados**, helpers de asserção compacta, separação unidade/integração.
5. Sequência: harness → unit (ROI) → mocks → integration `dataService`/explorers → ativação → CI.
6. **Diretriz transversal (§1.5):** maximizar dependência do LSP e eliminar regex de gramática — o que reorienta os testes para **contrato LSP** (`lspMock`) em vez de cobertura dos parsers regex transitórios.

---

## Anexo A — Dados para publicação no Visual Studio Marketplace

> Registrados aqui para uso na publicação do publisher e da extensão. **A automação de publicação (`vsce publish`) é fora do escopo deste plano de testes**, mas o CI (Etapa 6) deve servir de gate de qualidade antes de qualquer publicação.

### A.1. Publisher

| Campo | Valor |
|-------|-------|
| Name | Christian Maciel De Britto |
| ID | `synesis-lang` |
| Company website | https://synesis-lang.github.io/synesis-docs/ |
| Source code repository | https://github.com/synesis-lang |
| LinkedIn | https://www.linkedin.com/in/christian-britto-17b99015/ |
| Verified domain | *(a verificar — afirma identidade/marca)* |
| Logo | *(128px × 128px — a fornecer)* |
| Support | *(a definir — e-mail ou URL de suporte)* |
| Twitter | *(opcional — não informado)* |
| Description | *(a preencher no perfil do publisher)* |

### A.2. Consistência a verificar antes de publicar

⚠️ **Divergência detectada:** o `publisher` em [package.json](synesis-explorer/package.json#L6) é **`"synesis"`**, mas o ID do publisher no Marketplace é **`synesis-lang`**. Antes da primeira publicação, alinhar:

```jsonc
// package.json
"publisher": "synesis-lang"   // hoje está "synesis"
```

Demais campos de `package.json` a confirmar/popular para o Marketplace:
- `repository.url` → já aponta para `https://github.com/synesis-lang/synesis-explorer` ✅
- `icon` → `synesis-icon.png` ✅ (confirmar 128×128 para o logo do publisher)
- `homepage` / `bugs` → ausentes; adicionar apontando para docs e issues
- `license` → confirmar campo `license` (há `LICENSE` MIT no repo)
- `categories`, `keywords` → revisar para descoberta no Marketplace

### A.3. Gate de qualidade pré-publicação (liga com Etapa 6)

A publicação no Marketplace deve ser **bloqueada por CI verde**:
1. `npm run test:unit` + `npm run test:integration` passam.
2. `npm run lint` sem erros.
3. `vsce package` gera `.vsix` sem warnings de empacotamento.
4. Versão em `package.json` incrementada e refletida no `CHANGELOG.md` (mesmo molde do compilador).
