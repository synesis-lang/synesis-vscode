# Synesis VS Code Icons

Icons for the **Synesis Explorer** VS Code extension. All assets use the design system's color and mark system.

## Contents

```
icons/
  file-synp.svg          .synp project file — blue, convergence mark
  file-synt.svg          .synt template file — violet, bracket + fields
  file-syn.svg           .syn annotation file — green, highlighted text
  file-syno.svg          .syno ontology file — amber, diamond node
  file-bib.svg           .bib bibliography file — slate, open book
  activity-sidebar.svg   Sidebar / activity bar icon (colored, for dark bar)
  activity-sidebar-mono.svg  Sidebar icon, white-on-transparent (monochrome)
marketplace-logo.png     512×512 Marketplace / README icon
synesis-icons.theme.json VS Code file icon theme definition
```

---

## File icon theme — `package.json` setup

Copy the `assets/vscode/` folder next to your extension's `package.json`, then add:

```json
"contributes": {
  "iconThemes": [
    {
      "id": "synesis-icons",
      "label": "Synesis Icons",
      "path": "./assets/vscode/synesis-icons.theme.json"
    }
  ]
}
```

---

## Activity bar / sidebar icon

In `package.json`, reference the colored SVG for the Explorer view container:

```json
"contributes": {
  "viewsContainers": {
    "activitybar": [
      {
        "id": "synesisExplorer",
        "title": "Synesis Explorer",
        "icon": "assets/vscode/icons/activity-sidebar.svg"
      }
    ]
  }
}
```

Use `activity-sidebar-mono.svg` if you want VS Code to apply its own foreground tinting.

---

## Marketplace logo

Reference in `package.json` root:

```json
"icon": "assets/vscode/marketplace-logo.png"
```

VS Code Marketplace displays it at 128×128; the file is 512×512 for high-DPI.

---

## Icon design rationale

| File | Color | Symbol | Why |
|------|-------|--------|-----|
| `.synp` | Blue `#005cc5` | Convergence mark | The project orchestrates all other files — same as the brand mark |
| `.synt` | Violet `#8250df` | `{` + field lines | Template = the normative grammar, bracket-delimited fields |
| `.syn` | Green `#1a7f37` | Text lines + highlight | Annotations = highlighted excerpts with codes |
| `.syno` | Amber `#bc4c00` | Diamond node | Ontology = canonical concept classification |
| `.bib` | Slate `#6a737d` | Open book | Bibliography = source references |
