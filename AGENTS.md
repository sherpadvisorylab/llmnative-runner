# @llmnative/runner — Agent Reference

Leggi `README.md` per cos'è il runner e il suo pacchetto, `llms.txt` per l'orientamento rapido, `openapi/v1.yaml`
per l'API. Stato e lavoro aperto: `.notes/STATUS.md`. Il design di partenza è in Playbook,
`docs/runner-extraction.md`.

## Regole

- Un solo repository: server (`server/`), immagine degli harness (`agent/`), installer (`install/`), pacchetto npm
  (`src/`: `client`, `ui`, `setup`, `steps`). Nessun altro repository per parti del runner.
- Il runner non dipende da Google né da un cloud: si installa su qualunque VPS Linux; il CMS (Firebase) è solo un client.
- Server: Node 24, TypeScript eseguito così com'è (solo sintassi cancellabile), **nessuna dipendenza**. Import con
  estensione `.ts`.
- Segreti: chiavi solo come hash; token e chiavi dei provider solo in file 0600 dello scope; mai in una risposta né
  nei log (niente prompt, risposte, token, chiavi nei log).
- La UI usa solo i componenti pubblici di `@llmnative/react` (import da `'@llmnative/react'`); se manca qualcosa,
  CR al framework. Testi per le persone in `src/ui/texts.ts` (en, it).
- I passi dell'installazione si descrivono una volta in `src/setup/steps.ts`; `install/install.sh` incorpora
  `install/compose.yaml` (un test controlla che siano uguali) e la versione del pacchetto.
- Test: `tests/server/{unit,integration}` (ambiente node), `tests/unit/{client,setup,ui}`.
- Versione unica per immagini e pacchetto (SemVer); release dal tag `v<versione>` (`.github/workflows/release.yml`),
  con voce in `CHANGELOG.md`. Nessuna pubblicazione a mano.
