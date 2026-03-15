/**
 * abstractViewer.js - Webview para visualizacao de abstracts
 *
 * Proposito:
 *     Exibe o abstract BibTeX com trechos destacados.
 *     Lista excerpts com contexto (nota e chain).
 *
 * Componentes principais:
 *     - showAbstract: Fluxo principal de carregamento
 *     - highlightExcerpts: Insere marcacoes no abstract
 *
 * Dependencias criticas:
 *     - projectLoader: resolucao de bibliografia
 *     - bibtexParser: parsing de .bib
 *     - SynesisParser: parse de ITEMs
 */

const vscode = require('vscode');
const SynesisParser = require('../parsers/synesisParser');
const projectLoader = require('../core/projectLoader');
const bibtexParser = require('../parsers/bibtexParser');
const fuzzyMatcher = require('../utils/fuzzyMatcher');

class AbstractViewer {
    constructor(workspaceScanner, templateManager, dataService) {
        this.scanner = workspaceScanner;
        this.templateManager = templateManager;
        this.dataService = dataService || null;
        this.parser = new SynesisParser();
        this.colors = [
            '#ffeb3b', '#ff9800', '#f44336', '#e91e63',
            '#9c27b0', '#673ab7', '#3f51b5', '#2196f3',
            '#00bcd4', '#009688'
        ];
    }

    async showAbstract() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor');
            return;
        }

        const bibref = this._findBibref(editor.document, editor.selection.active);
        if (!bibref) {
            vscode.window.showWarningMessage('No reference found. Position cursor inside a SOURCE or ITEM block.');
            return;
        }

        const projectUri = await this.scanner.findProjectFile();
        if (!projectUri) {
            vscode.window.showWarningMessage('No project file found. Create a .synp to enable abstracts.');
            return;
        }

        const project = await projectLoader.load(projectUri);
        if (!project.bibliographyPath) {
            vscode.window.showWarningMessage('Bibliography not found in project.');
            return;
        }

        const entries = await bibtexParser.parse(project.bibliographyPath);
        const entry = bibtexParser.findEntry(entries, bibref);
        if (!entry) {
            vscode.window.showErrorMessage(`Entry ${bibref} not found in bibliography.`);
            return;
        }

        const abstract = bibtexParser.getAbstract(entry);
        const extracted = await this._extractExcerpts(bibref, projectUri);
        const excerpts = extracted.excerpts;
        const display = extracted.display;
        const highlighted = abstract ? this.highlightExcerpts(abstract, excerpts) : '';
        const hasAbstract = Boolean(abstract);
        if (!hasAbstract) {
            vscode.window.showWarningMessage(`No abstract found for ${bibref}. Showing bibliographic info only.`);
        }

        const panel = vscode.window.createWebviewPanel(
            'synesisAbstract',
            `Abstract: ${bibref}`,
            vscode.ViewColumn.Beside,
            { enableScripts: false }
        );

        panel.webview.html = this.getHtmlContent(bibref, entry, highlighted, excerpts, hasAbstract, display);
    }

    highlightExcerpts(abstract, excerpts) {
        if (!abstract) {
            return '';
        }

        const matches = [];

        for (let index = 0; index < excerpts.length; index += 1) {
            if (!excerpts[index].text) {
                continue;
            }

            const match = fuzzyMatcher.findExcerpt(abstract, excerpts[index].text);
            if (!match) {
                continue;
            }

            matches.push({
                start: match.start,
                end: match.end,
                color: this.colors[index % this.colors.length]
            });
        }

        if (matches.length === 0) {
            return escapeHtml(abstract);
        }

        matches.sort((a, b) => a.start - b.start);

        let result = '';
        let cursor = 0;

        for (const match of matches) {
            if (match.start < cursor) {
                continue;
            }

            result += escapeHtml(abstract.slice(cursor, match.start));
            result += `<mark style="background-color: ${match.color};">`;
            result += escapeHtml(abstract.slice(match.start, match.end));
            result += '</mark>';
            cursor = match.end;
        }

        result += escapeHtml(abstract.slice(cursor));
        return result;
    }

    async _extractExcerpts(bibref, projectUri) {
        // Try LSP first — eliminates all local I/O and regex parsing
        if (this.dataService) {
            try {
                const lspItems = await this.dataService.getExcerpts(bibref);
                if (lspItems && lspItems.length > 0) {
                    const registry = await this.templateManager.loadTemplate(projectUri);
                    return this._buildExcerptsFromLspItems(lspItems, registry);
                }
            } catch (err) {
                console.warn('AbstractViewer._extractExcerpts: LSP getExcerpts failed, falling back to local:', err.message);
            }
        }

        // Fallback: local I/O + regex parsing (kept during transition)
        return this._extractExcerptsLocal(bibref, projectUri);
    }

    _buildExcerptsFromLspItems(lspItems, registry) {
        const quotationFields = getFieldsByType(registry, 'QUOTATION');
        const memoFields = getFieldsByType(registry, 'MEMO');
        const chainFields = getFieldsByType(registry, 'CHAIN');
        const codeFields = getFieldsByType(registry, 'CODE');

        const useMemoAsExcerpt = quotationFields.length === 0 && memoFields.length > 0;
        const excerptFields = quotationFields.length > 0 ? quotationFields : (useMemoAsExcerpt ? memoFields : []);
        const showNote = memoFields.length > 0 && !useMemoAsExcerpt;
        const showChain = chainFields.length > 0;
        const showCodes = !showChain && codeFields.length > 0;

        const excerpts = [];

        for (const item of lspItems) {
            const fields = item.extra_fields || {};
            // Normalise field names to lowercase for lookup
            const fieldsLower = {};
            for (const [k, v] of Object.entries(fields)) {
                fieldsLower[k.toLowerCase()] = v;
            }

            const noteValues = showNote ? collectFieldValues(fieldsLower, memoFields) : [];
            const chainValues = showChain ? collectFieldValues(fieldsLower, chainFields) : [];

            // Codes: from extra_fields CODE/code fields, or from item.codes
            let codes = [];
            if (showCodes) {
                codes = extractCodesFromFields(fieldsLower, codeFields);
                if (codes.length === 0 && Array.isArray(item.codes) && item.codes.length > 0) {
                    codes = item.codes.map(String);
                }
            }

            // Chain fallback: if chainValues empty but item.chains has data
            let effectiveChainValues = chainValues;
            if (showChain && chainValues.length === 0 && Array.isArray(item.chains) && item.chains.length > 0) {
                effectiveChainValues = item.chains.map(String);
            }

            if (excerptFields.length === 0) {
                const maxPairs = Math.max(noteValues.length, effectiveChainValues.length, codes.length > 0 ? 1 : 0);
                if (maxPairs === 0) continue;
                for (let i = 0; i < maxPairs; i++) {
                    excerpts.push({
                        text: '',
                        note: noteValues[i] || '',
                        chain: effectiveChainValues[i] || '',
                        codes: i === 0 ? codes : [],
                        line: item.line || 0,
                        file: item.file || ''
                    });
                }
                continue;
            }

            for (const fieldName of excerptFields) {
                const rawValue = fieldsLower[fieldName.toLowerCase()];
                if (!rawValue) continue;
                const excerptText = normalizeExcerpt(Array.isArray(rawValue) ? rawValue[0] || '' : String(rawValue));
                if (!excerptText) continue;

                if (noteValues.length <= 1 && effectiveChainValues.length <= 1) {
                    excerpts.push({
                        text: excerptText,
                        note: noteValues[0] || '',
                        chain: effectiveChainValues[0] || '',
                        codes,
                        line: item.line || 0,
                        file: item.file || ''
                    });
                } else {
                    const maxPairs = Math.max(noteValues.length, effectiveChainValues.length);
                    for (let i = 0; i < maxPairs; i++) {
                        excerpts.push({
                            text: excerptText,
                            note: noteValues[i] || '',
                            chain: effectiveChainValues[i] || '',
                            codes: i === 0 ? codes : [],
                            line: item.line || 0,
                            file: item.file || ''
                        });
                    }
                }
            }
        }

        return { excerpts, display: { showNote, showChain, showCodes } };
    }

    async _extractExcerptsLocal(bibref, projectUri) {
        const excerpts = [];
        const registry = await this.templateManager.loadTemplate(projectUri);
        const quotationFields = getFieldsByType(registry, 'QUOTATION');
        const memoFields = getFieldsByType(registry, 'MEMO');
        const chainFields = getFieldsByType(registry, 'CHAIN');
        const codeFields = getFieldsByType(registry, 'CODE');

        const useMemoAsExcerpt = quotationFields.length === 0 && memoFields.length > 0;
        const excerptFields = quotationFields.length > 0 ? quotationFields : (useMemoAsExcerpt ? memoFields : []);
        const showNote = memoFields.length > 0 && !useMemoAsExcerpt;
        const showChain = chainFields.length > 0;
        const showCodes = !showChain && codeFields.length > 0;

        const synFiles = await this.scanner.findSynFiles(projectUri);

        for (const fileUri of synFiles) {
            const content = await vscode.workspace.fs.readFile(fileUri);
            const text = content.toString();
            const filePath = fileUri.fsPath;

            const items = this.parser.parseItems(text, filePath);
            const filtered = items.filter(item => item.bibref === bibref);

            for (const item of filtered) {
                // Coletar notes, chains e codes como arrays (não concatenar)
                const noteValues = showNote ? collectFieldValues(item.fields, memoFields) : [];
                const chainValues = showChain ? collectFieldValues(item.fields, chainFields) : [];
                const codes = showCodes ? extractCodesFromFields(item.fields, codeFields) : [];

                if (excerptFields.length === 0) {
                    // Se não há excerpt fields, criar excerpts para cada par (note, chain)
                    const maxPairs = Math.max(noteValues.length, chainValues.length, codes.length > 0 ? 1 : 0);

                    if (maxPairs === 0) {
                        continue;
                    }

                    for (let i = 0; i < maxPairs; i++) {
                        excerpts.push({
                            text: '',
                            note: noteValues[i] || '',
                            chain: chainValues[i] || '',
                            codes: i === 0 ? codes : [],
                            line: item.line,
                            file: filePath
                        });
                    }
                    continue;
                }

                // Se há excerpt fields (ex: text), criar múltiplos excerpts se houver múltiplos notes/chains
                for (const fieldName of excerptFields) {
                    if (!item.fields[fieldName]) {
                        continue;
                    }

                    const excerptText = normalizeExcerpt(item.fields[fieldName]);
                    if (!excerptText) {
                        continue;
                    }

                    // Se há apenas 1 note e 1 chain (ou nenhum), criar 1 excerpt (comportamento original)
                    if (noteValues.length <= 1 && chainValues.length <= 1) {
                        excerpts.push({
                            text: excerptText,
                            note: noteValues[0] || '',
                            chain: chainValues[0] || '',
                            codes,
                            line: item.line,
                            file: filePath
                        });
                    } else {
                        // Se há múltiplos notes/chains, criar um excerpt para cada par
                        const maxPairs = Math.max(noteValues.length, chainValues.length);

                        for (let i = 0; i < maxPairs; i++) {
                            excerpts.push({
                                text: excerptText,
                                note: noteValues[i] || '',
                                chain: chainValues[i] || '',
                                codes: i === 0 ? codes : [],
                                line: item.line,
                                file: filePath
                            });
                        }
                    }
                }
            }
        }

        return {
            excerpts,
            display: {
                showNote,
                showChain,
                showCodes
            }
        };
    }

    getHtmlContent(bibref, entry, abstractHtml, excerpts, hasAbstract, display) {
        const bibInfo = buildBibInfo(entry);
        const legendHtml = excerpts.map((excerpt, index) => {
            const color = this.colors[index % this.colors.length];
            const shortText = excerpt.text.length > 80
                ? `${excerpt.text.slice(0, 80)}...`
                : excerpt.text;
            const label = excerpt.text ? `Excerpt ${index + 1}: ${escapeHtml(shortText)}` : `Entry ${index + 1}`;
            const noteHtml = display.showNote && excerpt.note
                ? `<div class="note-line"><em>Note:</em> ${escapeHtml(excerpt.note)}</div>`
                : '';
            const chainHtml = display.showChain && excerpt.chain
                ? `<div class="chain-line"><em>Chain:</em> ${formatChain(excerpt.chain)}</div>`
                : '';
            const codesHtml = display.showCodes && excerpt.codes && excerpt.codes.length > 0
                ? `<div class="chain-line"><em>Codes:</em> ${formatCodes(excerpt.codes)}</div>`
                : '';

            return `
        <div class="legend-item">
          <div style="display: flex; align-items: flex-start;">
            <span class="legend-color" style="background-color: ${color};"></span>
            <div>
              <div class="legend-excerpt">${label}</div>
              <div class="legend-description">
                ${noteHtml}
                ${chainHtml}
                ${codesHtml}
              </div>
            </div>
          </div>
        </div>
      `;
        }).join('');

        const bibInfoHtml = buildBibInfoHtml(bibInfo, bibref);
        const abstractSection = hasAbstract ? `
        <div class="abstract-container">
          <div class="abstract-text">
            ${abstractHtml}
          </div>
        </div>
        ` : '';

        return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Abstract: ${escapeHtml(bibref)}</title>
        <style>
          :root {
            --surface: var(--vscode-editorWidget-background);
            --surface-2: var(--vscode-editor-background);
            --border: var(--vscode-panel-border);
            --primary: var(--vscode-textLink-foreground);
            --primary-hover: var(--vscode-textLink-activeForeground);
            --text: var(--vscode-foreground);
            --text-secondary: var(--vscode-descriptionForeground);
            --radius: 12px;
            --shadow: 0 4px 12px rgba(0,0,0,0.08);
            --transition: all 0.25s ease;
          }

          body {
            margin: 0;
            padding: 32px 40px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            font-size: 15px;
            line-height: 1.7;
            background-color: var(--surface-2);
            color: var(--text);
          }

          .header, .abstract-container, .legend, .stats {
            margin-bottom: 24px;
            padding: 28px 32px;
            border-radius: var(--radius);
            background-color: var(--surface);
            border: 1px solid var(--border);
            box-shadow: var(--shadow);
            transition: var(--transition);
          }

          .header:hover, .abstract-container:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 20px rgba(0,0,0,0.12);
          }

          .header {
            padding: 32px 36px;
          }

          .doc-type {
            display: inline-block;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            padding: 4px 10px;
            border-radius: 20px;
            margin-bottom: 16px;
          }

          .bib-title {
            font-size: 22px;
            font-weight: 700;
            line-height: 1.35;
            margin-bottom: 16px;
            color: var(--text);
          }

          .bib-author-year {
            font-size: 15px;
            margin-bottom: 14px;
            color: var(--text-secondary);
            line-height: 1.5;
          }

          .bib-author {
            font-weight: 600;
          }

          .bib-year {
            font-weight: 600;
            margin-left: 6px;
          }

          .doi-line {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 18px;
            padding: 12px 14px 18px;
            border-bottom: 1px solid var(--border);
            background: var(--surface-2);
            border-radius: 10px;
            border: 1px solid var(--border);
          }

          .doi-line a {
            flex: 1;
            font-size: 13px;
            font-family: 'Consolas', 'Monaco', monospace;
            word-break: break-all;
          }

          .external-link {
            color: var(--primary);
            text-decoration: none;
            font-weight: 500;
            transition: var(--transition);
          }

          .external-link:hover {
            color: var(--primary-hover);
            text-decoration: underline;
          }

          .metadata-section {
            margin-top: 20px;
            padding: 18px 20px;
            border-radius: 10px;
            background: var(--surface-2);
            border: 1px solid var(--border);
          }

          .metadata-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 12px;
          }

          .metadata-item {
            font-size: 14px;
            line-height: 1.6;
          }

          .metadata-label {
            display: block;
            font-size: 11px;
            color: var(--text-secondary);
            margin-bottom: 4px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.3px;
          }

          .metadata-value {
            color: var(--text);
            font-weight: 500;
          }

          .abstract-text {
            text-align: justify;
            hyphens: auto;
            font-size: 15.5px;
            line-height: 1.75;
          }

          mark {
            font-weight: 500;
            border-radius: 4px;
            padding: 2px 5px;
            transition: var(--transition);
          }

          mark:hover {
            box-shadow: 0 2px 8px rgba(0,0,0,0.15);
            transform: translateY(-1px);
          }

          .legend h2 {
            font-size: 18px;
            font-weight: 700;
            margin-bottom: 20px;
            color: var(--text);
          }

          .legend-item {
            padding: 16px 18px;
            margin-bottom: 14px;
            border-left: 4px solid #ccc;
            background: var(--surface-2);
            border-radius: 10px;
            border: 1px solid var(--border);
            transition: var(--transition);
          }

          .legend-item:hover {
            transform: translateX(4px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.08);
          }

          .legend-color {
            width: 20px;
            height: 20px;
            border-radius: 6px;
            margin-right: 12px;
            flex-shrink: 0;
            border: 1px solid rgba(0,0,0,0.1);
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }

          .legend-excerpt {
            font-weight: 600;
            font-size: 14.5px;
            line-height: 1.5;
          }

          .legend-description {
            margin-left: 32px;
            font-style: italic;
            color: var(--text-secondary);
            border-left: 3px solid var(--border);
            padding-left: 12px;
            margin-top: 8px;
            font-size: 13.5px;
            line-height: 1.6;
          }

          .note-line, .chain-line {
            margin-top: 4px;
          }

          .chain-line {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            align-items: center;
          }

          .factor-chain {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-left: 6px;
          }

          .factor-tag {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            padding: 5px 12px;
            border-radius: 14px;
            font-size: 11.5px;
            font-weight: 600;
            transition: var(--transition);
          }

          .factor-tag:hover {
            transform: scale(1.05);
          }

          .factor-link {
            background: linear-gradient(135deg, #a8e6cf, #88d8b0);
            color: #2d5a45;
            padding: 5px 12px 5px 10px;
            font-size: 11px;
            font-weight: 700;
            clip-path: polygon(0% 0%, calc(100% - 8px) 0%, 100% 50%, calc(100% - 8px) 100%, 0% 100%);
            padding-right: 18px;
            transition: var(--transition);
          }

          .factor-link:hover {
            transform: translateX(3px);
          }

          .chain-empty {
            font-style: normal;
            background: var(--surface-2);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 2px 8px;
            color: var(--text-secondary);
          }

          .stats {
            font-size: 14px;
            font-weight: 500;
            color: var(--text-secondary);
            padding: 16px 24px;
            text-align: center;
          }

          .stats strong {
            color: var(--primary);
            font-weight: 700;
            font-size: 15px;
          }
        </style>
      </head>
      <body>
        <div class="header">
          ${bibInfoHtml}
        </div>
        ${abstractSection}
        <div class="legend">
          <h2>Excerpts (${excerpts.length} found)</h2>
          ${legendHtml}
        </div>
        <div class="stats">
          Excerpts encontrados: <strong>${excerpts.length}</strong>
        </div>
      </body>
      </html>
    `;
    }
    _findBibref(document, position) {
        const text = document.getText();
        const offset = document.offsetAt(position);
        const filePath = document.uri.fsPath;

        const items = this.parser.parseItems(text, filePath);
        const item = items.find(block => offset >= block.startOffset && offset <= block.endOffset);
        if (item) {
            return item.bibref;
        }

        const sources = this.parser.parseSourceBlocks(text, filePath);
        let last = null;

        for (const source of sources) {
            if (source.startOffset <= offset) {
                last = source.bibref;
            }
        }

        return last;
    }
}

function normalizeExcerpt(text) {
    return text.replace(/\s+/g, ' ').trim();
}

function formatChain(chainText) {
    const cleaned = normalizeExcerpt(chainText || '');
    if (!cleaned) {
        return '<span class="chain-empty">No chain</span>';
    }

    const tokens = cleaned
        .split('->')
        .map(token => token.trim())
        .filter(Boolean);

    if (tokens.length === 0) {
        return '<span class="chain-empty">No chain</span>';
    }

    const html = tokens.map(token => {
        const cssClass = isRelationToken(token) ? 'factor-link' : 'factor-tag';
        return `<span class="${cssClass}">${escapeHtml(token)}</span>`;
    }).join('');

    return `<span class="factor-chain">${html}</span>`;
}

function formatCodes(codes) {
    if (!Array.isArray(codes) || codes.length === 0) {
        return '<span class="chain-empty">No codes</span>';
    }

    const html = codes.map(code => {
        return `<span class="factor-tag">${escapeHtml(code)}</span>`;
    }).join('');

    return `<span class="factor-chain">${html}</span>`;
}

function isRelationToken(token) {
    const relationTokens = new Set([
        'INFLUENCES', 'ENABLES', 'CONSTRAINS', 'CONTESTED-BY', 'RELATES-TO',
        'CAUSES', 'PREVENTS', 'REQUIRES', 'EXCLUDES', 'CORRELATES', 'DEPENDS-ON'
    ]);

    return relationTokens.has(token.toUpperCase());
}

function collectFieldValues(fields, names) {
    const values = [];
    for (const name of names) {
        const fieldValue = fields[name];
        if (!fieldValue) {
            continue;
        }

        // Suporta campos com múltiplos valores (arrays)
        if (Array.isArray(fieldValue)) {
            for (const val of fieldValue) {
                const normalized = normalizeExcerpt(val);
                if (normalized) {
                    values.push(normalized);
                }
            }
        } else {
            const normalized = normalizeExcerpt(fieldValue);
            if (normalized) {
                values.push(normalized);
            }
        }
    }
    return values;
}

function extractCodesFromFields(fields, names) {
    const values = collectFieldValues(fields, names);
    const codes = [];

    for (const value of values) {
        const parts = value.split(',').map(part => part.trim()).filter(Boolean);
        for (const part of parts) {
            if (!codes.includes(part)) {
                codes.push(part);
            }
        }
    }

    return codes;
}

function buildBibInfo(entry) {
    const tags = entry?.entryTags || {};
    return {
        type: entry?.entryType || '',
        title: sanitizeBibValue(tags.title),
        author: sanitizeBibValue(tags.author),
        year: sanitizeBibValue(tags.year),
        journal: sanitizeBibValue(tags.journal),
        booktitle: sanitizeBibValue(tags.booktitle),
        publisher: sanitizeBibValue(tags.publisher),
        doi: sanitizeBibValue(tags.doi),
        url: sanitizeBibValue(tags.url)
    };
}

function buildBibInfoHtml(info, bibref) {
    const items = [];

    if (info.type) {
        items.push(`<div class="doc-type">${escapeHtml(info.type.toUpperCase())}</div>`);
    }

    if (info.title) {
        items.push(`<div class="bib-title">${escapeHtml(info.title)}</div>`);
    }

    const authorYearParts = [];
    if (info.author) {
        authorYearParts.push(`<span class="bib-author">${escapeHtml(info.author)}</span>`);
    }
    if (info.year) {
        authorYearParts.push(`<span class="bib-year">(${escapeHtml(info.year)})</span>`);
    }
    if (authorYearParts.length > 0) {
        items.push(`<div class="bib-author-year">${authorYearParts.join(' ')}</div>`);
    }

    const venue = [info.journal, info.booktitle, info.publisher].filter(Boolean).join(' · ');
    if (venue) {
        items.push(`<div class="bib-author-year">${escapeHtml(venue)}</div>`);
    }

    const link = info.doi
        ? (info.doi.startsWith('http') ? info.doi : `https://doi.org/${info.doi}`)
        : info.url;

    if (link) {
        items.push(`
          <div class="doi-line">
            <a href="${escapeHtml(link)}" class="external-link">${escapeHtml(link)}</a>
          </div>
        `);
    }

    const metadataItems = [
        `<div class="metadata-item">
          <span class="metadata-label">Reference</span>
          <span class="metadata-value">${escapeHtml(bibref)}</span>
        </div>`
    ];

    items.push(`
      <div class="metadata-section">
        <div class="metadata-grid">
          ${metadataItems.join('\n')}
        </div>
      </div>
    `);

    return items.join('\n');
}

function sanitizeBibValue(value) {
    if (!value) {
        return '';
    }

    return String(value)
        .replace(/[{}]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function getFieldsByType(registry, type) {
    return Object.entries(registry)
        .filter(([, def]) => def.type === type)
        .map(([name]) => name);
}

function escapeHtml(text) {
    if (!text) {
        return '';
    }

    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

module.exports = AbstractViewer;
