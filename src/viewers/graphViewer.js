/**
 * graphViewer.js - Webview para visualizacao de grafos de CHAIN
 *
 * Proposito:
 *     Exibe um grafo Mermaid com relacoes de CHAIN para uma referencia.
 *     Usa DataService para obter mermaidCode via LSP.
 *
 * Componentes principais:
 *     - showGraph: Fluxo principal de exibicao
 *     - showGraphPanel: Renderiza webview com Mermaid.js
 *
 * Dependencias criticas:
 *     - DataService: LSP-only access for mermaidCode
 */

const vscode = require('vscode');

class GraphViewer {
    constructor(dataService, extensionUri) {
        this.dataService = dataService;
        this.extensionUri = extensionUri || null;
        this.panel = null;
    }

    async showGraph() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor');
            return;
        }

        const bibref = await this._findBibref(editor.document, editor.selection.active);
        if (!bibref) {
            vscode.window.showWarningMessage(
                'No reference found. Place the cursor inside a SOURCE or ITEM block.'
            );
            return;
        }

        const result = await this.dataService.getRelationGraph(bibref);
        if (!result || !result.mermaidCode) {
            vscode.window.showWarningMessage(`No chain relations found for ${bibref}.`);
            return;
        }

        this.showGraphPanel(`@${bibref}`, result.mermaidCode);
    }

    async showGraphForFile() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor');
            return;
        }

        const filePath = editor.document.uri.fsPath;
        const result = await this.dataService.getRelationGraphForFile(filePath);
        if (!result || !result.mermaidCode) {
            vscode.window.showWarningMessage('No chain relations found for this file.');
            return;
        }

        const fileName = filePath.split(/[\\/]/).pop();
        this.showGraphPanel(`File: ${fileName}`, result.mermaidCode);
    }

    async showGraphForItem() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor');
            return;
        }

        const itemInfo = await this._findItemInfo(editor.document, editor.selection.active);
        if (!itemInfo) {
            vscode.window.showWarningMessage(
                'No ITEM block found at cursor. Place the cursor inside an ITEM block.'
            );
            return;
        }

        const filePath = editor.document.uri.fsPath;
        const fileName = filePath.split(/[\\/]/).pop();
        console.log(`GraphViewer.showGraphForItem: bibref=${itemInfo.bibref} line=${itemInfo.line} file=${filePath}`);
        const result = await this.dataService.getRelationGraphForItem(itemInfo.bibref, itemInfo.line, filePath);
        if (!result || !result.mermaidCode) {
            vscode.window.showWarningMessage(`No chain relations found for item @${itemInfo.bibref}.`);
            return;
        }

        this.showGraphPanel(`Item: @${itemInfo.bibref} L${itemInfo.line + 1} (${fileName})`, result.mermaidCode);
    }

    showGraphPanel(reference, mermaidCode) {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside);
        } else {
            const localResourceRoots = this.extensionUri
                ? [vscode.Uri.joinPath(this.extensionUri, 'media')]
                : [];
            this.panel = vscode.window.createWebviewPanel(
                'graphViewer',
                `Graph: ${reference}`,
                vscode.ViewColumn.Beside,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots
                }
            );

            this.panel.onDidDispose(() => {
                this.panel = null;
            });
        }

        this.panel.title = `Graph: ${reference}`;
        this.panel.webview.html = this.getWebviewContent(reference, mermaidCode);
    }

    getWebviewContent(reference, mermaidCode) {
        const nonce = getNonce();
        const mermaidSrc = this._getMermaidUri();
        // When the local asset is available, lock script-src to the nonce only.
        // When falling back to CDN, allow the specific CDN host as well.
        const scriptSrc = mermaidSrc
            ? `'nonce-${nonce}'`
            : `'nonce-${nonce}' https://cdn.jsdelivr.net`;
        const mermaidScriptTag = mermaidSrc
            ? `<script nonce="${nonce}" src="${mermaidSrc}"></script>`
            : `<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>`;
        const csp = [
            `default-src 'none'`,
            `script-src ${scriptSrc}`,
            `style-src 'unsafe-inline'`,
            `img-src data: blob:`,
            `font-src 'self'`,
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Graph: ${escapeHtml(reference)}</title>
    ${mermaidScriptTag}
    <style>
        :root {
            --bg: #f8fafc;
            --surface: #ffffff;
            --surface-2: #f1f5f9;
            --border: #e2e8f0;
            --primary: #3b82f6;
            --primary-light: #dbeafe;
            --success: #16a34a;
            --danger: #dc2626;
            --text: #0f172a;
            --text-muted: #64748b;
            --radius: 12px;
            --shadow: 0 4px 12px rgba(0,0,0,0.08);
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: system-ui, sans-serif;
            background: var(--bg);
            color: var(--text);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .header {
            padding: 12px 24px;
            background: white;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-shrink: 0;
        }

        .header-left h1 {
            margin: 0;
            font-size: 16px;
            font-weight: 700;
            color: var(--text);
        }

        .header-left p {
            margin: 2px 0 0 0;
            font-size: 12px;
            font-weight: 400;
            color: var(--text-muted);
        }

        .zoom-controls {
            display: flex;
            gap: 8px;
            align-items: center;
        }

        .zoom-btn {
            background: var(--surface);
            border: 1px solid var(--border);
            color: var(--text);
            padding: 6px 12px;
            border-radius: 6px;
            cursor: pointer;
            font-family: system-ui, sans-serif;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .zoom-btn:hover {
            background: var(--primary-light);
            border-color: var(--primary);
            color: var(--primary);
        }

        .zoom-btn:active {
            transform: scale(0.95);
        }

        .zoom-level {
            font-size: 12px;
            color: var(--text-muted);
            min-width: 50px;
            text-align: center;
            font-weight: 500;
        }

        .graph-container {
            flex: 1;
            background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%);
            padding: 16px;
            overflow: hidden;
            display: flex;
            justify-content: center;
            align-items: center;
            position: relative;
        }

        .mermaid-wrapper {
            width: 100%;
            height: 100%;
            overflow: auto;
            display: flex;
            justify-content: center;
            align-items: center;
            background-color: white;
            border-radius: var(--radius);
            box-shadow: var(--shadow);
        }

        .mermaid {
            padding: 20px;
            display: flex;
            justify-content: center;
            align-items: center;
        }

        .mermaid svg {
            display: block;
            max-width: none !important;
            transition: width 0.2s ease, height 0.2s ease;
        }

        .mermaid svg .node rect,
        .mermaid svg .node polygon,
        .mermaid svg .node circle {
            fill: #dbeafe;
            stroke: #3b82f6;
            stroke-width: 2px;
            rx: 12px;
            ry: 12px;
        }

        .mermaid svg .nodeLabel,
        .mermaid svg .label {
            color: #1e40af;
            fill: #1e40af;
        }

        .mermaid svg .edgePath path {
            stroke: #94a3b8;
            stroke-width: 1.6px;
        }

        .mermaid svg .edgeLabel {
            color: #1e40af;
        }

        .error {
            color: var(--danger);
            padding: 20px;
            text-align: center;
            font-weight: 500;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="header-left">
            <h1>Graph Viewer</h1>
            <p>Reference: <strong>${escapeHtml(reference)}</strong></p>
        </div>
        <div class="zoom-controls">
            <button class="zoom-btn" id="btnZoomOut" title="Zoom out">
                <span>-</span>
            </button>
            <span class="zoom-level" id="zoomLevel">100%</span>
            <button class="zoom-btn" id="btnZoomIn" title="Zoom in">
                <span>+</span>
            </button>
            <button class="zoom-btn" id="btnReset" title="Reset zoom">
                <span>Reset</span>
            </button>
        </div>
    </div>

    <div class="graph-container">
        <div class="mermaid-wrapper" id="mermaidWrapper">
            <div class="mermaid" id="mermaidContent">
${mermaidCode}
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        document.getElementById('btnZoomOut').addEventListener('click', zoomOut);
        document.getElementById('btnZoomIn').addEventListener('click', zoomIn);
        document.getElementById('btnReset').addEventListener('click', resetZoom);

        // naturalWidth/naturalHeight: dimensões reais do SVG gerado pelo Mermaid (px)
        let naturalWidth = 0;
        let naturalHeight = 0;
        let currentZoom = 1.0;
        const zoomStep = 0.15;
        const minZoom = 0.1;
        const maxZoom = 4.0;

        function getSvg() {
            const content = document.getElementById('mermaidContent');
            return content ? content.querySelector('svg') : null;
        }

        // Zoom via redimensionamento direto do SVG — o scroll container vê o tamanho real
        function updateZoom(newZoom) {
            if (naturalWidth === 0 || naturalHeight === 0) return;
            currentZoom = Math.max(minZoom, Math.min(maxZoom, newZoom));
            const svg = getSvg();
            if (svg) {
                svg.setAttribute('width', Math.round(naturalWidth * currentZoom) + 'px');
                svg.setAttribute('height', Math.round(naturalHeight * currentZoom) + 'px');
            }
            document.getElementById('zoomLevel').textContent = Math.round(currentZoom * 100) + '%';
            // Reset scroll so the left edge is never cut off after resize
            const wrapper = document.getElementById('mermaidWrapper');
            if (wrapper) { wrapper.scrollLeft = 0; wrapper.scrollTop = 0; }
        }

        function zoomIn()  { updateZoom(currentZoom + zoomStep); }
        function zoomOut() { updateZoom(currentZoom - zoomStep); }
        function resetZoom() { updateZoom(1.0); }

        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey || e.metaKey) {
                if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomIn(); }
                else if (e.key === '-')              { e.preventDefault(); zoomOut(); }
                else if (e.key === '0')              { e.preventDefault(); resetZoom(); }
            }
        });

        document.getElementById('mermaidWrapper').addEventListener('wheel', (e) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                updateZoom(currentZoom + (e.deltaY > 0 ? -zoomStep : zoomStep));
            }
        }, { passive: false });

        if (typeof mermaid === 'undefined') {
            document.getElementById('mermaidContent').innerHTML =
                '<div class="error">Failed to load Mermaid library. Check your network connection.</div>';
        } else {
            mermaid.initialize({
                startOnLoad: false,
                theme: 'base',
                themeVariables: {
                    fontFamily: 'system-ui, sans-serif',
                    fontSize: '14px',
                    primaryColor: '#dbeafe',
                    primaryBorderColor: '#3b82f6',
                    primaryTextColor: '#1e40af',
                    lineColor: '#94a3b8'
                },
                flowchart: {
                    useMaxWidth: false,
                    htmlLabels: false,
                    curve: 'cardinal'
                }
            });

            mermaid.run({ nodes: [document.getElementById('mermaidContent')] })
                .then(() => {
                    requestAnimationFrame(() => {
                        const wrapper = document.getElementById('mermaidWrapper');
                        const svg = getSvg();
                        if (!svg || !wrapper) return;

                        // Garantir viewBox presente para que redimensionamento preserve proporção
                        if (!svg.getAttribute('viewBox')) {
                            const bbox = svg.getBBox();
                            if (bbox.width > 0 && bbox.height > 0) {
                                svg.setAttribute('viewBox',
                                    bbox.x + ' ' + bbox.y + ' ' + bbox.width + ' ' + bbox.height);
                            }
                        }

                        // Capturar tamanho natural (sem padding) a partir do viewBox ou bbox
                        const vb = svg.getAttribute('viewBox');
                        if (vb) {
                            const parts = vb.split(/[\s,]+/).map(Number);
                            if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
                                naturalWidth  = parts[2];
                                naturalHeight = parts[3];
                            }
                        }
                        if (naturalWidth === 0) {
                            // fallback: tamanho atual do SVG
                            naturalWidth  = svg.getBoundingClientRect().width  || svg.clientWidth  || 800;
                            naturalHeight = svg.getBoundingClientRect().height || svg.clientHeight || 600;
                        }

                        // Auto-fit: escalar para caber no wrapper com margem de 40px
                        const availW = wrapper.clientWidth  - 40;
                        const availH = wrapper.clientHeight - 40;
                        if (availW > 0 && availH > 0 && naturalWidth > 0 && naturalHeight > 0) {
                            const fitScale = Math.min(availW / naturalWidth, availH / naturalHeight, 1.0);
                            updateZoom(fitScale);
                        } else {
                            updateZoom(1.0);
                        }
                    });
                })
                .catch(function(err) {
                    document.getElementById('mermaidContent').innerHTML =
                        '<div class="error">Failed to render graph: ' + err.message + '</div>';
                });
        }
    </script>
</body>
</html>`;
    }

    _getMermaidUri() {
        if (!this.extensionUri || !this.panel) {
            return null;
        }
        try {
            const mermaidPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'mermaid.min.js');
            return this.panel.webview.asWebviewUri(mermaidPath).toString();
        } catch (_) {
            return null;
        }
    }

    async _findItemInfo(document, position) {
        const lspReady = Boolean(this.dataService && this.dataService.lspClient && this.dataService.lspClient.isReady());
        if (!lspReady) {
            vscode.window.showWarningMessage('Synesis LSP is not ready. Cannot resolve item.');
            return null;
        }
        try {
            const symbols = await vscode.commands.executeCommand(
                'vscode.executeDocumentSymbolProvider',
                document.uri
            );
            if (!symbols || symbols.length === 0) {
                return null;
            }
            return _extractItemInfoFromSymbols(symbols, position);
        } catch (error) {
            console.warn('GraphViewer._findItemInfo: Failed:', error.message);
            return null;
        }
    }

    async _findBibref(document, position) {
        const lspReady = Boolean(this.dataService && this.dataService.lspClient && this.dataService.lspClient.isReady());
        console.log('GraphViewer._findBibref: LSP ready?', lspReady);

        if (!lspReady) {
            vscode.window.showWarningMessage('Synesis LSP is not ready. Cannot resolve reference.');
            return null;
        }

        return this._findBibrefViaLsp(document, position);
    }

    async _findBibrefViaLsp(document, position) {
        try {
            console.log('GraphViewer._findBibrefViaLsp: Requesting document symbols for', document.uri.toString());
            const symbols = await vscode.commands.executeCommand(
                'vscode.executeDocumentSymbolProvider',
                document.uri
            );

            console.log('GraphViewer._findBibrefViaLsp: Received symbols count:', symbols ? symbols.length : 0);
            if (!symbols || symbols.length === 0) {
                console.warn('GraphViewer._findBibrefViaLsp: No symbols returned from LSP');
                return null;
            }

            const bibref = extractBibrefFromSymbols(symbols, position);
            console.log('GraphViewer._findBibrefViaLsp: Extracted bibref:', bibref);
            return bibref;
        } catch (error) {
            console.warn('GraphViewer._findBibrefViaLsp: Failed to resolve bibref via LSP:', error.message);
            return null;
        }
    }

}

function getNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}

function escapeHtml(value) {
    if (!value) {
        return '';
    }

    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

module.exports = GraphViewer;

function _extractItemInfoFromSymbols(symbols, position) {
    const stack = [];
    const found = findSymbolPath(symbols, position, stack);
    if (!found) {
        return null;
    }
    // Walk stack from innermost outward, look for an ITEM-level symbol.
    // ITEMs that are children of a SOURCE symbol are named "ITEM #N" (no bibref);
    // the bibref lives in the parent SOURCE symbol ("SOURCE @bibref"). In that case
    // we continue walking outward to find the SOURCE and extract the bibref from it.
    for (let i = stack.length - 1; i >= 0; i--) {
        const sym = stack[i];
        const name = sym?.name || '';
        if (/^ITEM\b/i.test(name)) {
            // Try to get bibref from the ITEM name itself (orphan ITEM: "ITEM @bibref #N")
            const mDirect = /@([\w._-]+)/.exec(name);
            if (mDirect) {
                const line = sym?.range?.start?.line ?? sym?.selectionRange?.start?.line ?? 0;
                return { bibref: mDirect[1], line };
            }
            // No bibref in ITEM name — this is a child ITEM of a SOURCE.
            // Walk further outward to find the parent SOURCE symbol.
            const line = sym?.range?.start?.line ?? sym?.selectionRange?.start?.line ?? 0;
            for (let j = i - 1; j >= 0; j--) {
                const parentName = stack[j]?.name || '';
                const mParent = /^SOURCE\s+@?([\w._-]+)/i.exec(parentName);
                if (mParent) {
                    return { bibref: mParent[1], line };
                }
            }
            // ITEM found but no SOURCE parent in stack — cannot resolve bibref
            return null;
        }
    }
    return null;
}

function extractBibrefFromSymbols(symbols, position) {
    const stack = [];
    const found = findSymbolPath(symbols, position, stack);
    if (!found) {
        return null;
    }

    for (let i = stack.length - 1; i >= 0; i -= 1) {
        const name = stack[i]?.name || stack[i]?.containerName || '';
        const bibref = extractBibref(name);
        if (bibref) {
            return bibref;
        }
    }

    return null;
}

function findSymbolPath(symbols, position, stack) {
    for (const symbol of symbols) {
        const range = symbol.range || symbol.location?.range;
        if (!range || !isPositionInRange(position, range)) {
            continue;
        }

        stack.push(symbol);

        if (Array.isArray(symbol.children) && symbol.children.length > 0) {
            const found = findSymbolPath(symbol.children, position, stack);
            if (found) {
                return found;
            }
        }

        return symbol;
    }

    return null;
}

function isPositionInRange(position, range) {
    if (!position || !range) {
        return false;
    }

    if (position.line < range.start.line || position.line > range.end.line) {
        return false;
    }

    if (position.line === range.start.line && position.character < range.start.character) {
        return false;
    }

    if (position.line === range.end.line && position.character > range.end.character) {
        return false;
    }

    return true;
}

function extractBibref(text) {
    if (!text) {
        return null;
    }

    const match = String(text).match(/@[\w._-]+/);
    return match ? match[0] : null;
}
