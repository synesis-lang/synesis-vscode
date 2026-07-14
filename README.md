# Synesis

> **Knowledge engineering in VS Code — the official interface for the Synesis ecosystem.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![VS Code >=1.60](https://img.shields.io/badge/VS%20Code-%3E%3D1.60.0-blue.svg)](https://code.visualstudio.com/)

Synesis turns your qualitative-research project into live, navigable data: bibliographic references, analytical codes, causal relations, and ontology annotations — all derived directly from your template and annotation files, with real-time diagnostics as you type.

![Full view of the Synesis extension](https://raw.githubusercontent.com/synesis-lang/synesis-vscode/main/images/docs/10_full_view.png)

---

## Setup (3 steps)

**1. Install the compiler and language server** (they do the analysis; the extension is the interface):

```bash
pip install synesis synesis-lsp
```

**2. Create your first project** — in an empty folder, run:

```bash
synesis init
```

This generates a complete, compilable example: `project.synp`, `template.synt`, `references.bib`, `annotations.syn`, and `ontology.syno`. It is the fastest way to see every panel populated.

**3. Install the extension** and open that folder in VS Code. The Synesis icon appears in the Activity Bar and the panels fill in automatically.

> If `pip` installed to a location outside your `PATH`, set **`synesisExplorer.lsp.pythonPath`** in Settings to the full path of `synesis-lsp`.

---

## First 60 seconds

1. Run `synesis init` in an empty folder, then open it in VS Code.
2. Click the **Synesis** icon in the Activity Bar (left).
3. Browse the **References** and **Codes** panels — click any entry to jump to its exact line.
4. Open `annotations.syn`: errors appear inline and in the **Problems** panel (`Ctrl+Shift+M`).
5. Press `Ctrl+Alt+G` to see the relation graph.

![Opening a Synesis project](https://raw.githubusercontent.com/synesis-lang/synesis-vscode/main/images/docs/03_projeto_synesis.png)

> **Keep the [Synesis cheatsheet](https://synesis-lang.github.io/synesis-docs/landing/pt/synesis-cheatsheet.html) handy** — a one-page reference for the Synesis language syntax.
>
> New to the language itself? Start from the [Synesis documentation](https://github.com/synesis-lang/synesis).

---

## What you get

**Navigation panels** (Activity Bar → Synesis). Some appear only for the relevant file type:

| Panel | Shows | Visible when |
|-------|-------|--------------|
| **References** | Bibliographic sources (`SOURCE`), items nested below | always |
| **Codes** | Analytical codes, with each occurrence | a project is loaded |
| **Relations** | Causal chains (`CHAIN`), grouped by source | editing a `.syn` file |
| **Ontology Topics** | Topics from ontology files | editing a `.syno` file |
| **Ontology Annotations** | Where ontology topics are used across `.syn` files | editing a `.syn` file |
| **Template Fields** | Fields from the template (`.synt`), by scope | always |

Click any entry to open the file at the exact line.

![The Synesis panels in the Activity Bar](https://raw.githubusercontent.com/synesis-lang/synesis-vscode/main/images/docs/04_painel_synesis.png)

**References** — every bibliographic source, with its annotation items nested below.

![References panel](https://raw.githubusercontent.com/synesis-lang/synesis-vscode/main/images/docs/05_references.png)

**Codes** — every analytical code, with each occurrence, ready to jump to.

![Codes panel](https://raw.githubusercontent.com/synesis-lang/synesis-vscode/main/images/docs/06_codes.png)

**Relations** — causal chains (`CHAIN`) between concepts, grouped by source.

![Relations panel](https://raw.githubusercontent.com/synesis-lang/synesis-vscode/main/images/docs/07_relations.png)

**Relation graph** — interactive, zoomable graph of your chains, for the whole project, one file, or one item (`Ctrl+Alt+G`).

![Relation graph viewer](https://raw.githubusercontent.com/synesis-lang/synesis-vscode/main/images/docs/08_graph_viewer.png)

**Abstract viewer** — the bibliographic abstract for the active reference (`Ctrl+Shift+A`).

![Abstract viewer](https://raw.githubusercontent.com/synesis-lang/synesis-vscode/main/images/docs/09_abstract_viewer.png)

**Real-time diagnostics** — missing required fields, unknown references, codes not in the template, and more, underlined as you edit `.syn`/`.syno`.

**AI-assisted coding** — send a selection to `synesis-coder` to generate annotations (`Ctrl+Shift+I`; requires `pip install synesis-coder`).

**Two themes** — *Synesis Dark* / *Synesis Light* (`Ctrl+Shift+P` → "Color Theme").

---

## Key commands

Run any of these from the Command Palette (`Ctrl+Shift+P`, type "Synesis"), or use the shortcut:

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+G` | Relation graph — whole project |
| `Ctrl+Alt+F` | Relation graph — active file |
| `Ctrl+Alt+I` | Relation graph — item under cursor |
| `Ctrl+Shift+A` | Show bibliographic abstract for the active reference |
| `Ctrl+Shift+I` | Code the current selection with `synesis-coder` |
| `F12` | Go to a code's definition |
| `F2` | Rename a code or reference across the whole project |

---

## Settings

All under `synesisExplorer.*` (File → Preferences → Settings → "Synesis"):

| Setting | Purpose |
|---------|---------|
| `lsp.pythonPath` | Path to the `synesis-lsp` executable, if not on `PATH` |
| `lsp.enabled` | Turn the language server on/off |
| `diagnostics.enabled` | Toggle inline error squiggles |
| `inlayHints.enabled` | Show `(Author, Year)` hints after references |
| `semanticHighlighting.enabled` | AST-based highlighting (needs a Synesis theme) |
| `completion.autoImportCodes` | Offer ontology codes in autocomplete |
| `coder.path` | Path to the `synesis-coder` executable |

`lsp.pythonPath`, `lsp.args` and `coder.path` are machine-scoped: a workspace cannot override which executable runs, so opening someone else's project is safe.

---

## Troubleshooting

- **Panels are empty** — make sure the folder contains a `.synp` file and that `synesis-lsp` is installed and reachable (check the *Synesis LSP* output channel).
- **A panel is missing** — several panels are file-type-specific (see the table above); open a `.syn` or `.syno` file to reveal them.
- **"Failed to start Synesis LSP"** — set `synesisExplorer.lsp.pythonPath` to the full path of the executable.

---

## Resources

- **[Synesis cheatsheet](https://synesis-lang.github.io/synesis-docs/landing/pt/synesis-cheatsheet.html)** — one-page language syntax reference.
- **[Documentation](https://github.com/synesis-lang/synesis)** — the Synesis language and compiler.
- Run `synesis init` any time to regenerate a working example project.

---

## License

MIT — Christian Maciel De Britto. See [CHANGELOG.md](CHANGELOG.md) for version history.
