/**
 * O que o banco GUARDA, e não apenas o que ele DECLARA.
 *
 * `describeProjectSchema` monta o resumo do prompt a partir de `get_schema`,
 * que lista somente as propriedades **declaradas**. Uma propriedade gravada em
 * todo vértice mas nunca declarada é invisível ali — e o modelo não pode
 * consultar o que não sabe que existe.
 *
 * Não é hipótese. Observado ao vivo no banco `candidatos_quinto_andar`
 * (ArcadeDB 26.9.1, 3.027 Sources): o vértice `Source` declara 19 propriedades,
 * todas STRING e todas textuais. `total_score`, `normalized_score`, `coverage`
 * e `scored_criteria` **não aparecem em nenhuma**, apesar de estarem gravadas
 * como inteiros em todos os 3.027 vértices. Perguntado "qual candidato é mais
 * bem pontuado", o modelo não via com o que ordenar e gastava as rodadas
 * descobrindo por tentativa que um campo de pontuação sequer existia.
 *
 * É o MESMO defeito que `describeGraphMetrics` já cobre para as métricas de
 * rede ("gravadas mas não declaradas, e portanto invisíveis ao `get_schema`").
 * Lá foi resolvido para uma lista fixa de oito propriedades conhecidas. Aqui é
 * resolvido pela via geral: amostrar o dado e ver o que ele tem.
 *
 * **Por que no chat e não só no produtor.** O `synesis-graph` pode declarar
 * esses campos daqui para a frente, e deve. Mas o chat não controla o banco a
 * que se conecta: grafos já exportados por versões anteriores continuam com o
 * schema incompleto e ninguém vai reexportá-los todos. Sondar o dado é o que
 * torna o assistente robusto a QUALQUER banco — inclusive um que não tenha
 * saído do synesis-graph. A correção no produtor e esta aqui não se substituem.
 *
 * **Agnosticismo.** Nada aqui conhece o template Synesis, nomes de campo ou
 * convenções de projeto. Só se pergunta ao banco o que ele responde sobre si
 * mesmo, e se relata o observado.
 */

/** Propriedades de serviço: existem em todo vértice e não dizem nada ao modelo. */
const STRUCTURAL_KEYS = new Set(['@rid', '@type', '@cat', '@in', '@out']);

/**
 * Vetor de embedding: a EXISTÊNCIA importa, o VALOR é lixo no prompt (centenas
 * de floats). Mesma decisão que `describeProjectSchema` já toma para o schema
 * declarado — a instrução de como usá-lo vem de `renderSemanticCapability`.
 */
const EMBEDDING_KEY = 'embedding';

/**
 * Quantas linhas amostrar por vértice.
 *
 * Uma só não basta, e a razão é concreta: `Item.score` está ausente em 166.316
 * dos 249.735 Items deste corpus (dois terços). Uma amostra de uma linha pode
 * cair num Item sem `score` e concluir que a propriedade não existe.
 *
 * Cinco é barato — medido em 286ms contra o banco remoto, com todas as chaves
 * já presentes — e não pretende ser exaustivo: a saída é rotulada como
 * observação amostral, não como schema.
 */
const SAMPLE_SIZE = 5;

/**
 * Amostra reduzida para vértice que carrega vetor de embedding.
 *
 * O vetor vem no nó inteiro e domina o tráfego: medido no `Chain` deste corpus,
 * 384 floats por linha — 5,5 KB dos 5,6 KB de uma única linha, e 27 KB quando
 * são cinco. Tudo isso é descartado logo depois, porque só os NOMES das chaves
 * interessam à sondagem.
 *
 * Uma linha basta nesse caso: um vértice com embedding é um vértice de
 * conceito, cujas propriedades são densas e uniformes — o motivo de amostrar
 * cinco (campo esparso como `Item.score`, ausente em dois terços das linhas)
 * não se aplica a ele.
 */
const EMBEDDING_SAMPLE_SIZE = 1;

/**
 * Quantas linhas amostrar deste vértice, pelo que o schema declara.
 *
 * Decidido pela DECLARAÇÃO de `embedding`, não pelo valor — é o que permite
 * escolher o tamanho antes de fazer a consulta.
 */
function sampleSizeFor(vertex) {
    const names = ((vertex && vertex.properties) || []).map((p) => p && p.name);
    return names.includes(EMBEDDING_KEY) ? EMBEDDING_SAMPLE_SIZE : SAMPLE_SIZE;
}

/** Tipo legível para o prompt, a partir do valor que o banco devolveu. */
function describeType(value) {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value === 'number') {
        return Number.isInteger(value) ? 'número inteiro' : 'número decimal';
    }
    if (typeof value === 'boolean') {
        return 'booleano';
    }
    if (Array.isArray(value)) {
        return 'lista';
    }
    if (typeof value === 'string') {
        // A distinção que importa para consulta: um número GRAVADO COMO TEXTO
        // não soma e não ordena por grandeza. Ver `NUMERIC_STRING_WARNING`.
        return /^-?\d+(\.\d+)?$/.test(value.trim()) ? 'texto numérico' : 'texto';
    }
    return typeof value;
}

/**
 * Une as chaves observadas nas linhas amostradas.
 *
 * Cada propriedade fica com o primeiro tipo NÃO NULO visto: um campo esparso
 * aparece com o tipo de quem o tem, em vez de sumir por causa de quem não tem.
 */
function collectObserved(rows) {
    const observed = new Map();
    for (const row of rows || []) {
        if (!row || typeof row !== 'object') {
            continue;
        }
        for (const [key, value] of Object.entries(row)) {
            if (STRUCTURAL_KEYS.has(key)) {
                continue;
            }
            const type = describeType(value);
            if (!type) {
                continue;
            }
            if (!observed.has(key)) {
                observed.set(key, type);
            }
        }
    }
    return observed;
}

/**
 * Extrai o nó de uma linha de resultado.
 *
 * `RETURN i` devolve o nó com suas propriedades; conforme o transporte, ele vem
 * na raiz da linha ou aninhado sob o alias. Aceitar as duas formas evita
 * depender do formato exato de um servidor específico.
 */
function unwrapNode(row) {
    if (!row || typeof row !== 'object') {
        return undefined;
    }
    if (Object.keys(row).some((key) => STRUCTURAL_KEYS.has(key))) {
        return row;
    }
    const values = Object.values(row);
    if (values.length === 1 && values[0] && typeof values[0] === 'object') {
        return values[0];
    }
    return row;
}

/**
 * Compara o observado com o declarado e devolve o que o schema não conta.
 *
 * `declaredNames` são as propriedades que `get_schema` já anunciou: repeti-las
 * seria gastar contexto com o que o prompt já diz.
 */
function undeclaredFrom(observed, declaredNames) {
    const declared = new Set(declaredNames || []);
    const extra = [];
    for (const [name, type] of observed) {
        if (declared.has(name) || name === EMBEDDING_KEY) {
            continue;
        }
        extra.push({ name, type });
    }
    // Ordem estável: o prompt não deve mudar entre execuções por causa da
    // ordem em que o servidor devolveu as linhas.
    extra.sort((a, b) => a.name.localeCompare(b.name));
    return extra;
}

/**
 * Aviso do B2: número gravado como texto.
 *
 * Não é detalhe de tipagem — é erro DURO. Verificado contra o servidor:
 * `sum(score)` sobre `Item.score` devolve
 * `sum() requires numeric input, but received a value of type String`,
 * e `ORDER BY` sobre texto numérico ordena lexicograficamente ("9" > "38").
 * Sem este aviso o modelo tenta, falha, reformula e queima rodadas.
 */
function numericStringWarning(entries) {
    const numericText = entries.filter((e) => e.type === 'texto numérico');
    if (numericText.length === 0) {
        return '';
    }
    const names = numericText.map((e) => `\`${e.label}\``).join(', ');
    return (
        `\n\n**Atenção — número gravado como texto:** ${names}. ` +
        'Agregação numérica direta FALHA nestes campos (`sum()` recusa texto) e ' +
        '`ORDER BY` os ordena alfabeticamente, onde "9" vem depois de "38". ' +
        'Converta antes de somar ou ordenar (`toInteger(...)` em Cypher) — e ' +
        'prefira um campo já numérico, quando houver um que responda à pergunta.'
    );
}

/**
 * Monta a seção de prompt a partir das observações por vértice.
 *
 * Devolve string vazia quando nada foi observado além do declarado: um banco
 * com schema completo não recebe seção nenhuma, que é o comportamento correto
 * — e o que mantém o custo em zero para quem já está em dia.
 */
/**
 * Mais de um campo numérico pode responder "quem pontua mais"? (A1)
 *
 * **O chat NÃO deve eleger um.** Medido neste corpus: ordenar por `total_score`
 * e por `normalized_score` produz rankings diferentes — um candidato é 2º por um
 * critério e 4º pelo outro, porque tem score bruto maior e cobertura menor.
 * Escolher por conta do pesquisador é decidir o método dele.
 *
 * É a mesma disciplina que `METRIC_HINTS` já adota para centralidade, onde a
 * linha que dizia que PageRank era "a resposta certa" foi corrigida: grau,
 * PageRank e betweenness respondem perguntas diferentes. Ranking de candidato
 * também.
 *
 * O reconhecimento é deliberadamente estrutural — campos numéricos coexistindo
 * no mesmo vértice — e não uma lista de nomes conhecidos, que serviria a este
 * projeto e enganaria os outros. Contagens óbvias ficam de fora: `*_count` é
 * volume, não pontuação, e incluí-las transformaria o aviso em ruído.
 */
const SCORE_HINTS = ['score', 'rating', 'rank', 'pontua', 'nota', 'grade', 'index', 'indice', 'índice'];

/**
 * As métricas de rede já têm tratamento próprio (`METRIC_HINTS`), que explica o
 * que cada uma mede. Repeti-las aqui produziria dois avisos concorrentes sobre
 * a mesma escolha — observado na verificação: `pagerank`, `betweenness` e
 * `degree` apareceram como "campos de pontuação" do `Chain`.
 */
const NETWORK_METRICS = new Set([
    'pagerank',
    'betweenness',
    'degree',
    'in_degree',
    'out_degree',
    'weighted_degree',
    'community',
    'mention_count',
    'source_count'
]);

/**
 * Campos numéricos que representam PONTUAÇÃO, pelo nome.
 *
 * O reconhecimento por radical é assumidamente imperfeito, e é o preço de não
 * conhecer o template: `total_score` e `normalized_score` casam, `followers` e
 * `company_headcount` não. Sem esse corte o aviso listava dez campos — incluindo
 * contagem de seguidores — e um aviso que lista tudo não orienta nada.
 *
 * O radical cobre pt e en porque é onde os corpora reais estão; um campo de
 * pontuação com nome fora disso simplesmente não gera o aviso, que é a falha
 * segura (o modelo segue sem orientação extra, como antes).
 */
function rankingCandidates(entries) {
    return (entries || [])
        .filter((e) => e.type === 'número inteiro' || e.type === 'número decimal')
        .map((e) => e.name)
        .filter((name) => !NETWORK_METRICS.has(name))
        .filter((name) => {
            const lower = name.toLowerCase();
            return SCORE_HINTS.some((hint) => lower.includes(hint));
        })
        .sort();
}

/**
 * Aviso de ambiguidade de ranking.
 *
 * Só dispara com DOIS ou mais candidatos: com um só não há escolha a fazer, e o
 * aviso seria ruído.
 */
function renderRankingAmbiguity(label, entries) {
    const candidates = rankingCandidates(entries);
    if (candidates.length < 2) {
        return '';
    }
    const names = candidates.map((n) => `\`${n}\``).join(', ');
    return (
        `**Mais de um campo de pontuação em \`${label}\`:** ${names}. ` +
        'Eles não produzem necessariamente a mesma ordem — medido neste tipo de ' +
        'corpus, um total bruto e sua versão normalizada divergem exatamente onde ' +
        'a cobertura difere entre registros. Não escolha por conta própria qual ' +
        'representa "melhor": diga por qual está ordenando e nomeie a unidade; ' +
        'quando a pergunta não especificar, apresente por mais de um critério ou ' +
        'pergunte qual o pesquisador quer.'
    );
}

/**
 * Remove da sondagem o que o `template_doc` já nomeia (R1).
 *
 * Verificado neste corpus: o `template_doc` (28.703 chars) **já lista**
 * `total_score`, `normalized_score`, `coverage`, `score_band` e `score_state` —
 * todos os campos que a sondagem anuncia. Mas os lista como nomes numa linha de
 * "opcionais", **sem o tipo** e sem dizer que `Item.score` é texto.
 *
 * A sobreposição é de NOMES, não do que faz a consulta funcionar. Então a
 * desduplicação é seletiva: sai o campo cujo tipo não muda a consulta, fica o
 * que o documento não sabe dizer — `texto numérico`, que é o caso em que somar
 * ou ordenar falha.
 *
 * Sem `templateDoc` (a maioria dos turnos, em que ele não é carregado) nada é
 * removido: a sondagem é a única fonte ali.
 */
function dedupeAgainstTemplate(byLabel, templateDoc) {
    if (!templateDoc) {
        return byLabel || [];
    }
    return (byLabel || []).map((entry) => ({
        ...entry,
        undeclared: (entry.undeclared || []).filter(
            (e) => e.type === 'texto numérico' || !templateDoc.includes(e.name)
        )
    }));
}

function renderObservedProperties(byLabel) {
    const lines = [];
    const numericTextEntries = [];
    const guidances = [];

    for (const { label, undeclared, guidance } of byLabel || []) {
        if (guidance) {
            guidances.push(guidance);
        }
        if (!undeclared || undeclared.length === 0) {
            continue;
        }
        const rendered = undeclared.map((e) => `\`${e.name}\` (${e.type})`).join(', ');
        lines.push(`  - \`${label}\`: ${rendered}`);
        for (const entry of undeclared) {
            numericTextEntries.push({ ...entry, label: `${label}.${entry.name}` });
        }
    }

    const rankings = [];
    for (const { label, ranking } of byLabel || []) {
        // A ambiguidade de ranking (A1) considera TODOS os campos numéricos do
        // vértice, não só os não declarados: um projeto cujo schema já declare
        // `total_score` continua tendo a mesma escolha a fazer.
        const text = renderRankingAmbiguity(label, ranking);
        if (text) {
            rankings.push(text);
        }
    }

    const sections = [];
    if (lines.length > 0) {
        sections.push(
            'Propriedades presentes no dado mas AUSENTES do schema declarado ' +
                '(lidas por amostragem de algumas linhas, não pelo `get_schema`):\n' +
                `${lines.join('\n')}\n` +
                'Elas são consultáveis normalmente — o schema é que está incompleto, não o dado. ' +
                'Por virem de amostra, podem não existir em todas as linhas: confirme com uma ' +
                'consulta antes de afirmar cobertura total.' +
                numericStringWarning(numericTextEntries)
        );
    }
    // A orientação de chave (A2) sai de uma contagem EXATA sobre todo o vértice,
    // não de amostra — por isso vai em seção própria, e não sob a ressalva de
    // amostragem acima.
    sections.push(...guidances);
    sections.push(...rankings);

    return sections.join('\n\n');
}

/**
 * Campos textuais que valem testar como identificador de um vértice.
 *
 * Só texto: agrupar por um número (`total_score`, `coverage`) não é
 * identificação, e testar todo campo numérico gastaria a consulta à toa.
 */
function identityCandidates(observed) {
    const names = new Set();
    for (const [name, type] of observed || []) {
        // Só o que a AMOSTRA mostrou ser texto. Antes esta função também tomava
        // todo nome declarado, inclusive os que a amostra revelou numéricos —
        // e o resultado foi anunciar `community`, `degree` e `in_degree` como
        // candidatos a identificador de `Chain`, que é absurdo.
        if (type === 'texto' || type === 'texto numérico') {
            names.add(name);
        }
    }
    return [...names]
        .filter((name) => name && name !== EMBEDDING_KEY)
        // Prosa longa não é identificador: `abstract`, `description` e
        // `citation` existem para serem lidos, não para agrupar. Avisar que
        // `abstract` "repete" é ruído — ninguém agruparia por ele.
        .filter((name) => !PROSE_FIELDS.has(name))
        .sort();
}

/**
 * Campos que são prosa por convenção estrutural do Synesis, não candidatos a
 * chave. `citation` e `description` são o texto anotado; `abstract` é o resumo
 * da fonte. Nenhum deles identifica coisa alguma.
 */
const PROSE_FIELDS = new Set(['abstract', 'citation', 'description', 'about_summary']);

/**
 * Quais campos identificam uma linha, e quais fundem linhas distintas (A2).
 *
 * **O erro que isto evita é SILENCIOSO.** Neste corpus, 29 títulos são
 * compartilhados por dois ou mais candidatos — "Lucas Vieira" são três pessoas
 * diferentes. Um `GROUP BY title` soma os trechos das três e devolve um total
 * que não pertence a ninguém: observado ao vivo, um "Lucas Vieira, 85" que não
 * existe (o maior score real do corpus é 61). A consulta não falha, não avisa,
 * e o número parece plausível.
 *
 * `bibtex` e `candidate_key` têm 3.027 valores distintos para 3.027 vértices;
 * `title` tem 2.997. A diferença é toda a informação necessária, e sai de uma
 * consulta só.
 *
 * Recebe `{total, counts}` já medidos — a consulta fica no participant, esta
 * função só interpreta.
 */
function classifyIdentity(total, counts) {
    const unique = [];
    const ambiguous = [];
    for (const [name, distinct] of Object.entries(counts || {})) {
        if (typeof distinct !== 'number' || !total) {
            continue;
        }
        if (distinct === total) {
            unique.push(name);
            continue;
        }
        // **Só o QUASE-único é armadilha.** Um campo com 2 valores distintos em
        // 249.735 linhas (`evaluation_origin`) é uma categoria: ninguém o
        // confunde com identificador, e avisar sobre ele é ruído que afoga o
        // aviso que importa. O perigoso é o campo que PARECE identificar e
        // falha na margem — `title`, com 2.997 valores para 3.027 candidatos:
        // 99% das linhas são únicas, e as 30 restantes fundem pessoas
        // diferentes em silêncio.
        if (distinct >= total * NEAR_UNIQUE_RATIO && distinct < total) {
            ambiguous.push({ name, distinct, collisions: total - distinct });
        }
    }
    unique.sort();
    // Do mais ambíguo para o menos: o campo que mais funde linhas é o que mais
    // importa avisar.
    ambiguous.sort((a, b) => b.collisions - a.collisions || a.name.localeCompare(b.name));
    return { total, unique, ambiguous };
}

/**
 * A partir de que fração de valores distintos um campo "parece" identificador.
 *
 * 0,9: `title` (2.997/3.027 = 99,0%) entra; `current_company_size`
 * (143/3.027 = 4,7%) e `evaluation_origin` (2/249.735) ficam de fora. O aviso
 * existe para o caso em que a intuição do modelo falha na margem, não para
 * enumerar toda coluna de baixa cardinalidade do vértice.
 */
const NEAR_UNIQUE_RATIO = 0.9;

/**
 * A seção de prompt sobre chave de agrupamento.
 *
 * Só é gerada quando há de fato um campo ambíguo E um campo único a recomendar:
 * avisar sem oferecer alternativa deixaria o modelo sem saída, e avisar num
 * corpus onde tudo é único seria ruído.
 */
function renderIdentityGuidance(label, identity) {
    if (!identity || !identity.ambiguous || identity.ambiguous.length === 0) {
        return '';
    }
    if (!identity.unique || identity.unique.length === 0) {
        return '';
    }
    const worst = identity.ambiguous
        .slice(0, 3)
        .map((e) => `\`${e.name}\` (${e.distinct} valores para ${identity.total} vértices)`)
        .join(', ');
    // Só os dois primeiros identificadores: o modelo precisa de UMA chave para
    // agrupar, não do inventário completo. Listar oito ocupa o prompt e ainda
    // devolve a escolha que o aviso existe para resolver.
    const keys = identity.unique.slice(0, 2).map((n) => `\`${n}\``).join(' ou ');
    const plural = identity.ambiguous.length > 1 ? 'esses campos' : 'esse campo';
    return (
        `**Chave de agrupamento em \`${label}\`:** ${keys} identifica cada vértice ` +
        `unicamente. Já ${worst} REPETE entre vértices distintos — agrupar ou contar ` +
        `por ${plural} funde registros diferentes num só e produz totais que não ` +
        'pertencem a ninguém, sem erro visível. Agrupe pela chave única e use o campo ' +
        'repetido apenas para exibição.'
    );
}

module.exports = {
    classifyIdentity,
    rankingCandidates,
    renderRankingAmbiguity,
    collectObserved,
    dedupeAgainstTemplate,
    describeType,
    identityCandidates,
    renderIdentityGuidance,
    renderObservedProperties,
    undeclaredFrom,
    unwrapNode,
    sampleSizeFor,
    SAMPLE_SIZE,
    EMBEDDING_SAMPLE_SIZE
};
