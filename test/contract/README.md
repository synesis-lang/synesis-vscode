# Contract fixtures (mirrored)

`schemas/` and `examples/` here are a **versioned copy** of the source of truth
in the `synesis-lsp` repository (`synesis-lsp/contracts/`).

They let the extension's CI validate its own fixtures and consumption code
against the same JSON Schemas the LSP validates its handler output against. This
is the consumer half of the LSP↔extension contract (diagnostic D6 of the Golden
Standard).

**Do not edit these files here.** When the contract changes, update it in
`synesis-lsp/contracts/` and copy the result over in the same change. The
compatibility matrix and deprecation policy live in that repo's
`contracts/README.md`.

Enforced by `test/unit/contract.test.js`.
