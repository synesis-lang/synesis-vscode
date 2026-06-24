# Synesis

> **Visual navigation and assisted editing for Synesis projects in Visual Studio Code.**

Synesis is a VS Code extension for working with Synesis files (`.syn`, `.synp`, `.synt`, `.syno`). It provides navigation panels for bibliographic references, codes, relations, ontologies, and template fields, along with real-time diagnostics as you write.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![VSCode >=1.60](https://img.shields.io/badge/VSCode-%3E%3D1.60.0-blue.svg)](https://code.visualstudio.com/)

---

## What is Synesis

Synesis is the visual interface of the Synesis ecosystem. It connects to the Synesis compiler to display, in real time, the data from your qualitative research project: bibliographic references, analytical codes, causal relations (chains), ontology topics, and ontology annotations.

Everything is derived directly from your template (`.synt`) and annotation files (`.syn`, `.syno`) — no manual field configuration required.

---

## Installation

### Prerequisites

Install the Synesis compiler and language server via terminal:

```
pip install synesis synesis-lsp
```

### Install the extension

1. Download the `.vsix` file from the [releases page](https://github.com/synesis-lang/synesis-vscode/releases).
2. In VS Code: `Ctrl+Shift+P` → "Extensions: Install from VSIX..." → select the downloaded file.

---

## Quick Start

1. Open a folder containing a `.synp` file (Synesis project) in VS Code.
2. Click the Synesis icon in the left sidebar.
3. The panels will be populated automatically with your project data.

---

## Sidebar Panels

The extension adds a sidebar with six panels:

| Panel | What it shows |
|-------|---------------|
| **References** | All bibliographic sources in the project (`SOURCE`), with their annotation items nested below |
| **Codes** | All analytical codes used in the annotations, with occurrences listed per file |
| **Relations** | Causal relations (`CHAIN`) declared in items, grouped by source |
| **Ontology Topics** | Topics defined in ontology files (`.syno`) |
| **Ontology Annotations** | Usage of ontology topics across `.syn` annotation files |
| **Template Fields** | Fields defined in the project template (`.synt`), grouped by scope (SOURCE / ITEM / ONTOLOGY) |

Clicking any item in a panel opens the corresponding file and positions the cursor at the exact line.

---

## Commands and Shortcuts

| Shortcut | Command | Description |
|----------|---------|-------------|
| `Ctrl+Alt+G` | Synesis: Show Relation Graph | Opens the relation graph for the entire project |
| `Ctrl+Alt+F` | Synesis: Show Relation Graph per File | Opens the relation graph for the active file |
| `Ctrl+Alt+I` | Synesis: Show Relation Graph per Item | Opens the graph for the item under the cursor |
| `Ctrl+Shift+A` | Synesis: Show Abstract | Displays the bibliographic abstract for the active reference |
| `F2` (in panel) | Rename Code / Rename Reference | Renames a code or reference across the entire project |

The relation graph is interactive: you can zoom in and out and navigate through the nodes.

Context menus are available in the **Codes** panel (go to definition) and the **References** panel (rename reference).

---

## Real-Time Diagnostics

While editing `.syn` and `.syno` files, the extension displays underlines and error messages directly in the editor — missing required fields, invalid bibliographic references, codes not defined in the template, and more. Errors also appear in the VS Code **Problems** panel (`Ctrl+Shift+M`).

---

## Themes

The extension includes two visual themes optimized for Synesis files:

- **Synesis Dark**
- **Synesis Light**

To activate: `Ctrl+Shift+P` → "Preferences: Color Theme" → select the desired theme.

---

## License

MIT License — Christian Maciel De Britto.

See [CHANGELOG.md](CHANGELOG.md) for the version history.
