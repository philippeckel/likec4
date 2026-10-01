---
'@likec4/language-server': patch
'@likec4/config': patch
---

Added support for external markdown files in `description`, `summary`, and other markdown-accepting properties. Reference an external file with the `file` keyword, e.g. `description file './overview.md'`. Paths may be relative to the source file, absolute to the project folder (`/docs/x.md`), or use `@alias/x.md` via a new `fileAliases` config option. The language server watches referenced files and reloads views when they change.
