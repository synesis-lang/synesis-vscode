/**
 * Cache das leituras que a extensão faz antes de o modelo entrar.
 *
 * **O custo que ele corta.** Toda pergunta refazia as mesmas consultas ao banco
 * antes da primeira palavra do modelo. Medido contra o `candidatos_quinto_andar`
 * (ArcadeDB 26.9.1, remoto): `ProjectContext` 104ms, `get_schema` 28ms e a
 * sondagem de propriedades 148ms — ~280ms fixos por pergunta, repetidos
 * integralmente na pergunta seguinte.
 *
 * Nada disso muda entre perguntas da mesma conversa. Schema, `ProjectContext` e
 * as propriedades gravadas só mudam quando alguém reexporta o grafo, o que não
 * acontece no meio de um chat.
 *
 * **Por que TTL e não cache permanente.** Reexportar durante a sessão é raro mas
 * possível — o pesquisador roda o `synesis-graph` noutra janela e volta ao chat.
 * Um cache sem expiração descreveria com confiança um grafo que mudou. O TTL
 * limita a janela de erro sem devolver o custo a cada pergunta.
 *
 * **Escopo.** Memória do processo, chaveado por banco: trocar de banco no meio
 * da conversa nunca serve o contexto do anterior — que era o defeito mais caro
 * possível aqui, porque a resposta pareceria correta.
 *
 * Mesmo padrão que o `SynesisLspClient` já usa para as respostas `synesis/*`,
 * com TTL maior porque o que se guarda aqui muda com muito menos frequência.
 */

/**
 * Por quanto tempo uma entrada continua válida.
 *
 * Dez minutos: longo o bastante para uma conversa inteira não pagar o prefetch
 * mais de uma vez, curto o bastante para uma reexportação no meio da sessão
 * aparecer sem o pesquisador ter de reabrir nada.
 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

class PrefetchCache {
    constructor({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
        this._ttlMs = ttlMs;
        this._now = now;
        // chave (banco + slot) -> { value, expiresAt }
        this._entries = new Map();
    }

    /**
     * Chave de uma entrada.
     *
     * O banco entra na chave, e não num campo à parte, porque a troca de banco
     * precisa produzir uma FALHA de cache e não uma leitura do anterior.
     */
    _key(database, slot) {
        return `${database || ''}::${slot}`;
    }

    /** Valor ainda válido, ou `undefined` — inclusive quando expirou. */
    get(database, slot) {
        const entry = this._entries.get(this._key(database, slot));
        if (!entry) {
            return undefined;
        }
        if (this._now() >= entry.expiresAt) {
            this._entries.delete(this._key(database, slot));
            return undefined;
        }
        return entry.value;
    }

    /**
     * Guarda um valor.
     *
     * `undefined` NÃO é guardado: as leituras devolvem `undefined` quando o
     * vértice não existe, quando o servidor recusa ou quando a resposta veio
     * inesperada — casos transitórios ou diagnósticos que não devem congelar
     * pela duração do TTL. Um banco sem `ProjectContext` paga a consulta de
     * novo, e é o comportamento correto: ela é barata e o estado pode mudar.
     */
    set(database, slot, value) {
        if (value === undefined) {
            return value;
        }
        this._entries.set(this._key(database, slot), {
            value,
            expiresAt: this._now() + this._ttlMs
        });
        return value;
    }

    /**
     * Devolve o valor em cache ou executa `produce()` e guarda o resultado.
     *
     * Não serializa chamadas concorrentes de propósito: as leituras de prefetch
     * do turno são sequenciais, e uma fila de promessas acrescentaria estado
     * para um caso que não ocorre.
     */
    async resolve(database, slot, produce) {
        const cached = this.get(database, slot);
        if (cached !== undefined) {
            return cached;
        }
        return this.set(database, slot, await produce());
    }

    /** Descarta tudo de um banco, ou o cache inteiro sem argumento. */
    invalidate(database) {
        if (database === undefined) {
            this._entries.clear();
            return;
        }
        const prefix = `${database}::`;
        for (const key of [...this._entries.keys()]) {
            if (key.startsWith(prefix)) {
                this._entries.delete(key);
            }
        }
    }

    /** Quantas entradas vivas — para teste e diagnóstico. */
    get size() {
        return this._entries.size;
    }
}

/**
 * Executa `task` sobre cada item com concorrência limitada (P2).
 *
 * A sondagem fazia uma ida ao servidor por vértice, enfileiradas: 148ms para os
 * sete vértices deste corpus, quando cada consulta custa ~30ms. Em paralelo o
 * custo tende ao da mais lenta.
 *
 * O limite existe porque um grafo com dezenas de vértices dispararia dezenas de
 * requisições simultâneas contra um servidor que pode ser remoto e compartilhado
 * — trocar latência por recusa de conexão não seria ganho.
 *
 * **A ordem do resultado acompanha a da entrada**, não a de chegada: a seção de
 * prompt não pode mudar entre execuções só porque o servidor respondeu noutra
 * ordem. É a mesma disciplina do `sort` em `undeclaredFrom`.
 */
async function mapWithConcurrency(items, limit, task) {
    const list = [...(items || [])];
    const results = new Array(list.length);
    let next = 0;

    const worker = async () => {
        while (next < list.length) {
            const index = next++;
            results[index] = await task(list[index], index);
        }
    };

    const size = Math.max(1, Math.min(limit, list.length));
    await Promise.all(Array.from({ length: size }, worker));
    return results;
}

/**
 * Quantas consultas de sondagem em voo ao mesmo tempo.
 *
 * Quatro cobre o corpus típico (sete vértices aqui) em duas ondas, sem abrir
 * uma conexão por vértice num grafo grande.
 */
const PROBE_CONCURRENCY = 4;

/** Os nomes de slot usados pelo participant. */
const SLOT = {
    CONTEXT: 'projectContext',
    CONTEXT_FULL: 'projectContextFull',
    SCHEMA: 'schema',
    OBSERVED: 'observedProperties'
};

module.exports = {
    PrefetchCache,
    SLOT,
    DEFAULT_TTL_MS,
    mapWithConcurrency,
    PROBE_CONCURRENCY
};
