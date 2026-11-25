# @llmnative/runner — Claude Code

Leggi e applica `AGENTS.md`. Memoria persistente su Supermemory (MCP `supermemory`, `containerTag: "llmnative"`),
voci prefissate `[llmnative-runner]`; non usare la memoria locale a file.

## Comandi

```bash
npm run typecheck   # libreria + server, 0 errori
npm test            # Vitest, tutti verdi
npm run build       # dist/: client, ui, setup, steps (+ dist/types)
npm run build:console
```

**Branch attivo:** `main`
