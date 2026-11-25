# Stato

| Versione | Stato | Note |
|---|---|---|
| 1.0.0 | 🔄 in rilascio | Estratto da Playbook 0.53.0 (storia mantenuta). API v1, account per persona, installer, console, pacchetto. |

## Da fare dopo la 1.0.0

- Prova su una VPS nuova fuori da Google e senza Coolify (install.sh, TLS, pairing, una chat vera).
- Playbook: immagine `FROM llmnative-runner` con i suoi moduli (turni, progettazione, sapere, memoria) e studio su `v1`.
- Agentico (CR): porta `AgenticoRunnerConfig`, «I miei abbonamenti» con `RunnerAccounts`, `createRunnerExecutor`, credito finito con proposta del modello API.
- CMS: pagina di piattaforma dei runner (superadmin) con `RunnersSettings`, `runnerId` sul `TenantRecord`, Cloud Function con `forwardToRunner` e `installAndPair`.
- Futuro: portare gli abbonamenti quando un tenant cambia runner; scelta automatica del runner meno carico.
