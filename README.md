# claude-dispatch

Server MCP che espone Claude Code a Claude Desktop, per lavorare su un progetto senza copiare e incollare prompt tra le due applicazioni.

Si ragiona su un problema nella chat di Claude Desktop, e da lì si delega l'esecuzione a Claude Code sul progetto reale. I lavori lunghi girano in background: si avviano, si continua a fare altro, si recupera il risultato quando è pronto.

## ⚠️ Prima di installarlo

**Questo server permette a un modello di eseguire Claude Code sulla tua macchina, con accesso al filesystem.** È una superficie di rischio reale e va capita prima di usarlo.

Cosa fa e cosa non fa:

- **Gira solo in locale.** Il trasporto è stdio: Claude Desktop lancia il server come processo figlio e ci parla via stdin/stdout. Nessuna porta in ascolto, nessun endpoint pubblico, niente che entri dal firewall.
- **Non limita cosa Claude Code può fare.** Il server passa il prompt e basta. I veri freni sono i permessi in `.claude/settings.json` del progetto: se lì è consentita la scrittura, l'agente scrive.
- **Non c'è allowlist di directory.** Qualunque percorso esistente passato come `cwd` viene accettato. Se ti serve un vincolo più stretto, aggiungi il controllo in `avviaClaude` ed `eseguiClaude`.
- **Ogni chiamata a strumento passa dalla conferma di Claude Desktop.** Il client chiede l'approvazione prima di invocare il server — a meno che non l'abbia disattivata.

**La raccomandazione:** configura permessi restrittivi nei progetti su cui lo usi, in particolare per le operazioni irreversibili (migration, cancellazioni, deploy). Un agente che deve chiedere prima di fare danni è più utile di uno veloce.

## Requisiti

- Windows (usa `claude.cmd` e `taskkill`; su Linux/macOS vanno adattati)
- Node.js 18+ — testato su 22
- [Claude Code](https://claude.com/claude-code) installato e autenticato
- Claude Desktop

## Installazione

```bash
git clone https://github.com/ITSWProj/claude-dispatch.git
cd claude-dispatch
npm install
```

Verifica che parta:

```bash
node server.js
```

Deve restare appeso in silenzio, senza stampare nulla: sta aspettando input su stdin. È il comportamento corretto. Esci con `Ctrl+C`.

## Configurazione

Aggiungi il server a `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "claude-dispatch": {
      "command": "C:\\percorso\\a\\node.exe",
      "args": ["C:\\percorso\\a\\claude-dispatch\\server.js"]
    }
  }
}
```

Tre punti dove si sbaglia facilmente:

- **Percorso assoluto a `node.exe`**, non la parola `node`. Claude Desktop non eredita il PATH della shell. Se usi nvm, punta all'eseguibile della versione specifica (es. `C:\nvm4w\v22.20.0\node.exe`), non alla junction `nodejs\`, che cambia a ogni `nvm use`.
- **Backslash raddoppiati** nel JSON, oppure slash normali (`C:/percorso/...`), che Node accetta anche su Windows.
- **Percorso assoluto anche in `args`**: il processo viene avviato con una working directory indefinita, quindi `./server.js` non risolve.

Poi chiudi Claude Desktop completamente — anche dall'area di notifica — e riavvialo. La configurazione si legge solo all'avvio.

Se non compare nulla, il sospetto numero uno è il JSON: una virgola di troppo disattiva silenziosamente *tutti* i server, senza messaggi. Passalo da un validatore.

Lo stderr del server (dove finiscono i `console.error()`) è in `%APPDATA%\Claude\logs\mcp-server-claude-dispatch.log`: se il processo muore all'avvio, il motivo è scritto lì.

## Strumenti

| Strumento | Uso |
|---|---|
| `claude_run` | Esegue un prompt e attende la risposta. Per compiti brevi. |
| `claude_start` | Avvia un lavoro in background, ritorna subito un `job_id`. |
| `claude_wait` | Attende un job avviato; se non è pronto entro `hold_ms` (default 30s, massimo 60s) riporta "in corso". |
| `claude_kill` | Termina un job e tutti i suoi processi figli. |

### Quale usare

Il discriminante è il tempo. Una domanda circoscritta — "leggi questi file e spiegami come funziona X" — sta bene in `claude_run`. Un lavoro vero — refactoring, implementazione, esplorazione di un'area sconosciuta — va con `claude_start`, poi `claude_wait` finché non è pronto.

`claude_run` ha un timeout (default 120s) perché una chiamata sincrona che non ritorna blocca la conversazione. `claude_start` non ne ha: il tetto sta sull'*attesa*, non sul lavoro.

Anche quell'attesa però è limitata: `hold_ms` viene tagliato a 60 secondi. Passare valori più alti non allunga l'attesa — semplicemente si richiama `claude_wait` con lo stesso `job_id` finché il lavoro non è concluso. È un vincolo voluto: `hold_ms` lo sceglie il modello, e senza tetto una singola chiamata potrebbe bloccare la conversazione per minuti.

### Il `session_id` conta

Ogni risposta restituisce un `session_id`. Ripassarlo alla chiamata successiva fa riprendere la sessione con il contesto già caricato, invece di riesplorare il progetto da zero.

Non è un dettaglio: la prima invocazione su un progetto di medie dimensioni può costare qualche decina di centesimi. Riusare la sessione riduce il costo dei giri successivi di un ordine di grandezza.

## Limiti noti

- **Lo stato vive in memoria.** Riavviando Claude Desktop mentre un lavoro gira, il processo continua ma il `job_id` diventa irraggiungibile. Non riavviare durante i lavori lunghi.
- **Il timeout di `claude_run` uccide l'intero albero di processi**, agente incluso, e il lavoro parziale non è recuperabile. Se il compito potrebbe essere lungo, usa `claude_start`: lì il tempo non è un vincolo.
- **Solo Windows.** Per portarlo altrove: `claude` al posto di `claude.cmd`, `shell: true` non più necessario, e `kill(-pid)` con `detached: true` al posto di `taskkill`.
- **La prima invocazione su un progetto è la più lenta.** Sembra un blocco, non lo è.
- **Nessun limite di spesa.** Il server non impone tetti di costo o di turni. Se servono, si passano a Claude Code con `--max-turns`.

## Come funziona

Un server MCP stdio non è un servizio in ascolto: è un processo figlio. Claude Desktop lo lancia e ci scambia messaggi JSON-RPC via stdin/stdout.

Da qui discende la regola più importante per chi mette mano al codice: **mai `console.log()`**. Ogni byte su stdout finisce nel canale del protocollo e corrompe il messaggio. Per il debug si usa `console.error()`, che scrive su stderr.

L'asincronia è gestita con `Promise.race` tra la fine del lavoro e un timer: nessun polling, nessuna euristica sul "sembra fermo". I job vivono in una `Map` con pulizia opportunistica dei conclusi da oltre dieci minuti.

Il prompt viaggia su **stdin**, non come argomento della riga di comando: è testo lungo e pieno di caratteri speciali, e qualunque escaping per la shell sarebbe fragile.

Uccidere un processo lanciato con `shell: true` richiede `taskkill /T`: la catena reale è `cmd.exe → claude.cmd → node → agente`, e terminare solo il primo lascerebbe l'agente vivo a consumare token senza più essere raggiungibile.

Il codice è commentato in dettaglio, con il *perché* di ogni scelta non ovvia.

## Licenza

MIT
