/**
 * code-dispatch — server MCP che espone Claude Code a Claude Desktop.
 *
 * COS'È UN SERVER MCP STDIO
 * Non è un servizio in ascolto su una porta: è un processo figlio.
 * Claude Desktop lo lancia e ci parla scrivendo su stdin e leggendo da stdout,
 * scambiando messaggi JSON-RPC (uno per riga).
 *
 * DA CUI DISCENDE LA REGOLA PIÙ IMPORTANTE DI QUESTO FILE:
 * mai console.log(). Ogni byte scritto su stdout finisce nel canale del
 * protocollo e corrompe il messaggio. Per il debug si usa console.error(),
 * che scrive su stderr ed è ignorato dal protocollo.
 *
 * CICLO DI VITA
 * Il processo nasce e muore con Claude Desktop. Ogni modifica a questo file
 * richiede un riavvio completo del client (chiusura anche dall'area di notifica).
 * Di conseguenza tutto lo stato tenuto in memoria — vedi la Map `jobs` — evapora
 * al riavvio.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

// L'estensione .js negli import sopra non è un refuso: l'SDK è scritto in
// TypeScript ma distribuito compilato, e la risoluzione ESM richiede il
// percorso reale del file compilato. Senza .js, Node non risolve il modulo.

// ---------------------------------------------------------------------------
// STATO CONDIVISO
// ---------------------------------------------------------------------------

/**
 * Registro dei lavori in background, indicizzato per job_id.
 *
 * Esiste perché nel modello asincrono il processo figlio deve SOPRAVVIVERE
 * alla chiamata che lo ha creato: claude_start ritorna subito, ma il lavoro
 * continua. Senza un riferimento esterno perderemmo sia il modo di leggerne
 * il risultato sia il modo di ucciderlo.
 *
 * Vive in memoria: al riavvio di Claude Desktop i job in corso diventano
 * irraggiungibili (i processi continuano a girare, ma senza maniglia).
 */
const jobs = new Map();

/** Promise che si risolve dopo ms millisecondi. Usata come "corsia" del race. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Da quanto un job deve essere concluso prima di essere rimosso dal registro. */
const RETENZIONE_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// UTILITÀ DI PROCESSO
// ---------------------------------------------------------------------------

/**
 * Termina un processo e TUTTI i suoi discendenti.
 *
 * Perché non basta child.kill(): avendo lanciato con { shell: true }, la catena
 * reale è cmd.exe -> claude.cmd -> node -> agente. Il nostro `child` è cmd.exe,
 * quindi ucciderlo lascerebbe in vita l'agente, che continuerebbe a lavorare e
 * a consumare token senza più essere raggiungibile.
 *
 * /T = tree (l'intero albero dei figli), /F = force.
 *
 * L'errore è deliberatamente ignorato: se il processo è già morto taskkill
 * fallisce, ed è un fallimento privo di conseguenze.
 */
function uccidiAlbero(pid) {
  return new Promise((resolve) => {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => resolve());
  });
}

/**
 * Rimuove dal registro i job conclusi da più di RETENZIONE_MS.
 *
 * Senza questo la Map crescerebbe indefinitamente, trattenendo anche l'intero
 * stdout di ogni job.
 *
 * È cleanup OPPORTUNISTICO: viene invocato all'avvio di un nuovo job invece che
 * da un timer ricorrente. Se non si lanciano job la memoria non cresce, quindi
 * non c'è nulla da pulire — e si evita un setInterval che vivrebbe per sempre.
 *
 * Nota: cancellare da una Map durante l'iterazione con for...of è sicuro
 * (su un array non lo sarebbe: gli indici scalerebbero e si salterebbero elementi).
 *
 * I job "running" non vengono mai toccati, per quanto vecchi: uno che gira da ore
 * è probabilmente piantato, ma la decisione di ucciderlo spetta all'utente.
 */
function pulisciJobVecchi() {
  const ora = Date.now();
  for (const [id, job] of jobs) {
    if (job.stato !== "running" && ora - job.finitoIl > RETENZIONE_MS) {
      jobs.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// ESECUZIONE DI CLAUDE CODE
// ---------------------------------------------------------------------------

/**
 * Avvia un lavoro in background e ritorna SUBITO il suo id.
 *
 * Contratto opposto a eseguiClaude(): quella attende e ritorna il risultato,
 * questa non attende e ritorna una maniglia. Da qui la differenza di ritorno:
 * un id (stringa), non un oggetto.
 */
function avviaClaude(prompt, cwd, sessionId) {
  pulisciJobVecchi();

  const id = randomUUID();

  // -p          = modalità headless (print): esegue e termina, senza TUI
  // --output-format json = risposta strutturata con result, session_id, costo
  // --resume    = riprende una sessione esistente, riusandone il contesto
  //               (evita di ripagare l'esplorazione del progetto a ogni giro)
  const args = ["-p", "--output-format", "json"];
  if (sessionId) args.push("--resume", sessionId);

  // shell: true è NECESSARIO su Windows perché `claude` è un file .cmd, cioè
  // uno script batch che solo cmd.exe può interpretare — non un eseguibile.
  //
  // La shell aprirebbe la porta alla command injection, ma qui non c'è
  // superficie: gli argomenti sono costanti scritte sopra, e il prompt (l'unico
  // dato variabile e potenzialmente ostile) non passa dalla riga di comando —
  // viaggia su stdin, vedi in fondo alla funzione.
  const child = spawn("claude.cmd", args, { cwd, shell: true });

  const job = {
    id,
    child,
    stdout: "",
    stderr: "",
    stato: "running", // "running" | "done" | "error"
    risultato: null,
    avviatoIl: Date.now(),
  };

  /**
   * Promise che si risolve quando il job termina, comunque vada.
   *
   * Non rigetta MAI, ed è deliberato: qui l'errore non è un'eccezione da
   * propagare ma uno STATO del job, che chi attende deve poter leggere.
   * Chi fa await vuole solo sapere "è finito"; il come si legge in job.stato.
   * Rigettare costringerebbe ogni punto di attesa a un try/catch inutile.
   */
  job.donePromise = new Promise((resolve) => {
    // I chunk sono Buffer (byte grezzi), non stringhe: vanno convertiti.
    // Possono spezzarsi a metà riga, quindi qui ci si limita ad accumulare.
    child.stdout.on("data", (c) => { job.stdout += c.toString(); });
    child.stderr.on("data", (c) => { job.stderr += c.toString(); });

    // "error" = il processo non è MAI partito (eseguibile assente, cwd
    // inesistente, permessi). Diverso da "è partito ed è andato male".
    child.on("error", (err) => {
      job.stato = "error";
      job.risultato = `Avvio fallito: ${err.message}`;
      job.finitoIl = Date.now();
      resolve();
    });

    // "close" = il processo è terminato. Il codice di uscita dice come.
    child.on("close", (code) => {
      if (code === 0) {
        try {
          job.risultato = JSON.parse(job.stdout);
          job.stato = "done";
        } catch {
          // Capita se claude stampa qualcosa che non è JSON: un avviso, una
          // richiesta di login. Meglio riportare i primi caratteri che lasciare
          // esplodere l'eccezione dentro la Promise.
          job.stato = "error";
          job.risultato = `Output non JSON: ${job.stdout.slice(0, 300)}`;
        }
      } else {
        job.stato = "error";
        job.risultato = `Exit ${code}: ${job.stderr.slice(0, 500)}`;
      }
      job.finitoIl = Date.now();
      resolve();
    });
  });

  // Il prompt viaggia su stdin, non come argomento: è testo lungo, pieno di
  // virgolette e a capo, e qualunque escaping per la riga di comando sarebbe
  // fragile. Su stdin la shell non lo tocca nemmeno.
  child.stdin.write(prompt);

  // end() NON è facoltativo: chiudere lo stream è ciò che segnala "messaggio
  // finito, tocca a te". Senza, claude resta in attesa di altro input per
  // sempre, "close" non arriva mai e il job resta appeso senza motivo apparente.
  child.stdin.end();

  jobs.set(id, job);
  return id;
}

/**
 * Esegue un prompt e ATTENDE il risultato. Per compiti brevi.
 *
 * Contrariamente ad avviaClaude(), qui il timeout sta sul processo: non essendoci
 * modo di richiamare il lavoro dopo, se supera il tetto va ucciso, altrimenti la
 * chiamata non ritornerebbe mai e la conversazione resterebbe bloccata.
 * (Claude Code headless non ha un timeout proprio: un agente piantato gira
 * finché qualcuno non lo ferma.)
 */
function eseguiClaude(prompt, cwd, sessionId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    if (!existsSync(cwd)) {
      return reject(new Error(`Directory inesistente: ${cwd}`));
    }
    
    const args = ["-p", "--output-format", "json"];
    if (sessionId) args.push("--resume", sessionId);

    const child = spawn("claude.cmd", args, { cwd, shell: true });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timeout dopo ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });

    // clearTimeout in OGNI via d'uscita: un timer lasciato armato ucciderebbe
    // un processo già terminato (o, peggio, un PID nel frattempo riciclato).
    child.on("error", (err) => { clearTimeout(timer); reject(err); });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Exit ${code}: ${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Output non JSON: ${stdout.slice(0, 300)}`));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// SERVER E STRUMENTI
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "code-dispatch",
  version: "0.1.0",
});

/**
 * NOTA SULLE DESCRIPTION
 * Non sono documentazione per l'umano: sono l'unica cosa che il modello legge
 * per decidere SE e QUANDO usare uno strumento. Una description vaga produce
 * un tool ignorato o usato a sproposito. Per questo claude_start dice
 * esplicitamente che va poi chiamato claude_wait, e quando preferire claude_run.
 *
 * Stesso discorso per .describe() sui singoli campi: finisce nel JSON Schema
 * ricevuto dal modello.
 */

server.registerTool(
  "claude_start",
  {
    title: "Avvia Claude Code",
    description:
      "Avvia un lavoro in background su Claude Code e restituisce subito un job_id. " +
      "Non attende il completamento: usare claude_wait con quel job_id per ottenere il risultato. " +
      "Adatto a compiti lunghi; per richieste brevi usare claude_run.",
    inputSchema: {
      // inputSchema NON è uno z.object(): è un oggetto semplice le cui proprietà
      // sono schemi Zod. L'SDK ci costruisce sopra il JSON Schema.
      prompt: z.string().describe("Il prompt da eseguire"),
      cwd: z.string().describe("Directory del progetto"),
      session_id: z.string().optional().describe("ID sessione da riprendere, se si continua un lavoro precedente"),
    },
  },
  // I parametri arrivano GIÀ VALIDATI da Zod: se il tipo non corrisponde, la
  // chiamata è respinta prima di entrare qui. Nessun controllo manuale necessario.
  async ({ prompt, cwd, session_id }) => {
    if (!existsSync(cwd)) {
      return {
        content: [{ type: "text", text: `Directory inesistente: ${cwd}` }],
        isError: true,
      };
    }
    const id = avviaClaude(prompt, cwd, session_id);
    return {
      content: [{ type: "text", text: `Avviato. job_id: ${id}` }],
    };
  }
);

server.registerTool(
  "claude_run",
  {
    title: "Esegui prompt in Claude Code",
    description:
      "Invia un prompt a Claude Code in modalità headless sul progetto indicato e attende la risposta. " +
      "Restituisce il risultato e il session_id per continuare la conversazione. " +
      "Adatto a richieste brevi; per compiti lunghi usare claude_start.",
    inputSchema: {
      prompt: z.string().describe("Il prompt da eseguire"),
      cwd: z.string().describe("Directory del progetto"),
      session_id: z.string().optional().describe("ID sessione da riprendere, se si continua un lavoro precedente"),
      timeout_ms: z.number().optional().describe("Timeout in millisecondi prima di terminare il processo"),
    },
  },
  async ({ prompt, cwd, session_id, timeout_ms }) => {
    try {
      const r = await eseguiClaude(prompt, cwd, session_id, timeout_ms);
      return {
        content: [{
          type: "text",
          text: `session_id: ${r.session_id}\ncosto: $${r.total_cost_usd ?? "?"}\nturni: ${r.num_turns ?? "?"}\n\n${r.result}`,
        }],
      };
    } catch (err) {
      // isError segnala al modello che la risposta è un fallimento, invece di
      // lasciargliela interpretare come contenuto normale.
      return { content: [{ type: "text", text: `Errore: ${err.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "claude_wait",
  {
    title: "Attendi risultato",
    description:
      "Attende il completamento di un lavoro avviato con claude_start. " +
      "Se il lavoro non è ancora finito entro hold_ms, restituisce lo stato 'in corso' " +
      "e va richiamato di nuovo con lo stesso job_id.",
    inputSchema: {
      job_id: z.string().describe("ID restituito da claude_start"),
      hold_ms: z.number().optional().describe("Quanto attendere prima di rispondere comunque (default 30000)"),
    },
  },
  async ({ job_id, hold_ms }) => {
    const job = jobs.get(job_id);

    if (!job) {
      // Possibile anche per un job reale: se è concluso da più di RETENZIONE_MS
      // il cleanup lo ha rimosso.
      return {
        content: [{ type: "text", text: `Nessun lavoro con id ${job_id}` }],
        isError: true,
      };
    }

    // IL CUORE DEL PATTERN.
    // Due promesse in gara: la fine del lavoro e un timer. Vince la più veloce.
    // Se il job finisce in 5s si prosegue a 5s; se ci mette mezz'ora si prosegue
    // comunque allo scadere di hold_ms, riportando "in corso".
    // Nessun polling, nessun setInterval, nessuna euristica sul "sembra fermo".
    await Promise.race([job.donePromise, sleep(hold_ms ?? 30000)]);

    // Per un job concluso la durata è avvio -> fine. Usare Date.now() anche in
    // quel caso gonfierebbe il numero a ogni successiva chiamata su un job vecchio.
    const fine = job.stato === "running" ? Date.now() : job.finitoIl;
    const secondi = Math.round((fine - job.avviatoIl) / 1000);

    if (job.stato === "running") {
      // Il job RESTA nel registro: la chiamata finisce, il processo no.
      return {
        content: [{
          type: "text",
          text: `In corso da ${secondi}s. Richiama claude_wait con lo stesso job_id.`,
        }],
      };
    }

    if (job.stato === "error") {
      // Una terminazione voluta non è un guasto: distinguerla evita che il
      // modello la interpreti come un fallimento da ritentare.
      const testo = job.ucciso
        ? `Terminato manualmente dopo ${secondi}s.`
        : `Fallito dopo ${secondi}s: ${job.risultato}`;
      return {
        content: [{ type: "text", text: testo }],
        isError: !job.ucciso,
      };
    }

    const r = job.risultato;
    return {
      content: [{
        type: "text",
        text: `Completato in ${secondi}s\nsession_id: ${r.session_id}\ncosto: $${r.total_cost_usd ?? "?"}\nturni: ${r.num_turns ?? "?"}\n\n${r.result}`,
      }],
    };
  }
);

server.registerTool(
  "claude_kill",
  {
    title: "Termina lavoro",
    description:
      "Termina forzatamente un lavoro avviato con claude_start. " +
      "Usare se un job resta bloccato o se il compito non serve più.",
    inputSchema: {
      job_id: z.string().describe("ID del lavoro da terminare"),
    },
  },
  async ({ job_id }) => {
    const job = jobs.get(job_id);
    if (!job) {
      return { content: [{ type: "text", text: `Nessun lavoro con id ${job_id}` }], isError: true };
    }
    if (job.stato !== "running") {
      // Non è un errore, è un'informazione.
      return { content: [{ type: "text", text: `Il lavoro è già in stato "${job.stato}".` }] };
    }

    // Il flag va scritto PRIMA di uccidere. Qualunque await restituisce il
    // controllo all'event loop, e in quella finestra il gestore "close" può già
    // essere stato eseguito: lo troverebbe undefined e il messaggio finale
    // sarebbe corretto solo a volte. Regola generale: se un flag serve a chi
    // reagisce a un evento, scrivilo prima di provocare l'evento.
    job.ucciso = true;
    await uccidiAlbero(job.child.pid);

    // Lo stato non viene forzato a mano: morto cmd.exe scatta "close" con codice
    // diverso da zero, e la macchina a stati porta il job in "error" da sola.
    return { content: [{ type: "text", text: `Terminato il lavoro ${job_id}.` }] };
  }
);

// ---------------------------------------------------------------------------
// AVVIO
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();

// await al livello più esterno del modulo: possibile solo in ESM, da cui
// l'obbligo di "type": "module" nel package.json.
await server.connect(transport);
