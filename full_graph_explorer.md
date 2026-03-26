# Plano: Filtro Top-N para Graph Viewer (Ranking de Fatores)

## Contexto

No momento, o GraphViewer do synesis-explorer renderiza grafos Mermaid.js com todas as relações CHAIN de um único bloco SOURCE. Em projetos reais como `social_acceptance.syn` (1388+ fatores, 17.576 linhas), renderizar TODAS as relações, de todos os blocos SOURCE, é inviável — o Mermaid trava ou produz grafos ilegíveis. Precisamos filtrar automaticamente para os ~15 fatores mais relevantes quando o volume excede um limiar, sem Neo4j (apenas dados in-memory do compilador).

## Dados Disponíveis no LinkedProject (LSP)

| Dado | Acesso | Uso para Ranking |
|------|--------|-----------------|
| `code_usage[code] → [ItemNode]` | Frequência: quantos items usam o código | Sinal de relevância empírica |
| `all_triples → [(subj, rel, obj)]` | Grau: quantas relações envolvem o código | Sinal de conectividade |
| `ontology_index` | Se o código está definido na ontologia | Opcional: priorizar definidos |
| `hierarchy` | Relações IS_A entre códigos | Futuro: proximidade à raiz |

## Algoritmo de Ranking

**Composite Score** — uma única passada sobre os triples:

```
score(code) = degree(code) × log₂(1 + frequency(code))
```

- `degree(code)` = nº de triples distintos onde o código aparece (sujeito ou objeto)
- `frequency(code)` = `len(code_usage[normalized_code])` (itens que usam o código)
- `log₂` amortece a frequência para que 200 usos não valham 20× mais que 10

**Por que este e não PageRank/Betweenness:**
- O(n) sem iteração — adequado para resposta LSP em tempo real
- Grafos por-bibref são esparsos e frequentemente desconexos — PageRank perde sentido
- O composto captura a intuição: fatores que são **bem conectados E bem fundamentados nos dados**

**Filtragem de triples:** Após selecionar top-N códigos, manter apenas triples onde **ambos** endpoints estão no top set. Isso evita nós pendurados.

## Implementação

### Passo 1 — `synesis-lsp/synesis_lsp/graph.py`

Adicionar função `_rank_codes()` e integrar no `get_relation_graph()`:

```python
import math
from collections import Counter

def _rank_codes(triples, code_usage, max_nodes=15):
    """Rank codes by degree × log₂(1 + frequency). Returns (top_set, filtered, total, shown)."""
    degree = Counter()
    for subj, _rel, obj in triples:
        degree[subj] += 1
        degree[obj] += 1

    all_codes = set(degree.keys())
    if len(all_codes) <= max_nodes:
        return all_codes, False, len(all_codes), len(all_codes)

    scores = {}
    for code in all_codes:
        freq = len(code_usage.get(_normalize_code(code), []))
        scores[code] = degree[code] * math.log2(1 + max(freq, 1))

    top = sorted(scores, key=scores.get, reverse=True)[:max_nodes]
    return set(top), True, len(all_codes), len(top)
```

Modificar `get_relation_graph()`:
- Novo parâmetro: `max_nodes: int = 15`
- Após determinar `triples` (linha ~74 atual), inserir ranking e filtragem
- Manter apenas triples onde ambos endpoints estão no top set
- Retornar campos adicionais no dict: `filtered`, `totalCodes`, `shownCodes`

### Passo 2 — `synesis-lsp/synesis_lsp/server.py` (linha ~808)

Extrair `maxNodes` dos params do comando `synesis/getRelationGraph`:

```python
max_nodes = params.get("maxNodes", 15) if isinstance(params, dict) else 15
return get_relation_graph(cached, bibref=bibref, max_nodes=max_nodes)
```

### Passo 3 — `synesis-explorer/src/services/dataService.js`

**LspDataProvider.getRelationGraph()** (linha 158): propagar `maxNodes` nos params e retornar metadados de filtragem (`filtered`, `totalCodes`, `shownCodes`).

**DataService.getRelationGraph()** (linha 314): aceitar `maxNodes` como parâmetro opcional.

### Passo 4 — `synesis-explorer/src/viewers/graphViewer.js`

- `showGraph()`: passar metadados de filtragem para `showGraphPanel()`
- `showGraphPanel()` / `getWebviewContent()`: exibir banner informativo quando `filtered === true`:
  > "Showing top 15 of 142 factors by relevance"
- CSS: estilo sutil para o banner (cor `--primary-light`, 12px, centralizado)

## Arquivos Modificados

| Arquivo | Tipo de Mudança |
|---------|----------------|
| `synesis-lsp/synesis_lsp/graph.py` | Nova função `_rank_codes()`, modificar `get_relation_graph()` |
| `synesis-lsp/synesis_lsp/server.py` | Extrair `maxNodes` dos params (~3 linhas) |
| `synesis-explorer/src/services/dataService.js` | Propagar `maxNodes`, retornar metadados |
| `synesis-explorer/src/viewers/graphViewer.js` | Banner informativo no webview |

## Retrocompatibilidade

- Novos campos na resposta (`filtered`, `totalCodes`, `shownCodes`) são ignorados por versões antigas da extensão
- Novo param `maxNodes` é ignorado por versões antigas do LSP (não enviado por padrão)
- Sem breaking changes

## Verificação

1. Testar com projeto pequeno (< 15 fatores) → grafo completo, sem banner
2. Testar com `social_acceptance.syn` (1388+ fatores) → grafo filtrado, banner visível
3. Testar per-bibref → filtragem aplica-se ao subconjunto
4. Verificar que `_rank_codes` retorna códigos coerentes (os mais conectados E frequentes)
5. Rodar testes existentes do synesis-lsp: `pytest tests/`
