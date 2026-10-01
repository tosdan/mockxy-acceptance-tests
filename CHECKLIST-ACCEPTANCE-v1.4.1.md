# Checklist — Integrazione dei test di accettazione dopo Mockxy 1.4.1

## Obiettivo e perimetro

Verificare dall'esterno le nuove garanzie introdotte da S0–S8 nella topologia reale **browser → immagine Docker di Mockxy → backend**. La suite attuale copre già proxy, CORS, cookie, sequence, console e stato condiviso; questa checklist aggiunge scenari di sistema, senza duplicare le matrici di validazione, CRUD e cache dei test interni.

Baseline: motore `v1.4.1`. Dopo la verifica della baseline, la CI continua a seguire il ref del motore previsto dai workflow, normalmente `main`: non fissare permanentemente la suite alla 1.4.1.

Riferimenti:

- [Perimetro e avvio della suite](README.md).
- [Piano implementato, contratti §13 C0–C8](../mockxy/docs/progetto/PIANO-PILOTAGGIO-DA-AGENT.md).
- [Contratto OpenAPI distribuito](../mockxy/src/admin/admin-api.openapi.yaml), disponibile anche attraverso `GET /_admin/api/openapi.yaml`.
- Guide ADMIN-API e RESPONSE IT/EN del motore, per i comportamenti pubblici.

Questa checklist non introduce nuovi contratti del server. Se durante l'implementazione emerge una divergenza, documentarla e sottoporla alla review; non adattare silenziosamente l'asserzione al comportamento osservato.

## Avanzamento e review

Opus implementa e aggiorna le evidenze; Codex fa la code review delle PR; Opus applica le eventuali correzioni e richiede un nuovo giro. Le decisioni di prodotto restano all'utente.

| Passo | Priorità | Stato | Evidenze: PR, verifiche e review |
|---|---|---|---|
| T0 — Isolamento e infrastruttura | Prerequisito | Completato | [#7](https://github.com/tosdan/mockxy-acceptance-tests/pull/7), integrata (`5658b40`): istanza `mockxy-discovery`, client admin `tests/admin-client.js`, modello di proprietà dello stato nel README. L'uso del project di riavvio arriva con T4. [#8](https://github.com/tosdan/mockxy-acceptance-tests/pull/8), integrata: istanza di sviluppo `mockxy-stream` con watcher e admin, seed in tmpfs. Review Codex su `4476ecd`: 0 rilievi. |
| T1 — Discovery e accesso nell'immagine distribuita | Alta | Completato | [#7](https://github.com/tosdan/mockxy-acceptance-tests/pull/7), integrata (`5658b40`): `tests/discovery.spec.js`, 8 test (7 solo HTTP su Chromium, 1 di accesso cross-origin sui tre browser). Motore `7456cdc` (codice identico a `v1.4.1`), suite `e6a61fc`. Suite completa verde: chromium 71, firefox 51 (+20 skip), webkit 51 (+20 skip), chromium-stack-mutating 1; nuovi test ripetuti 5 volte senza retry, verdi. Controprove nella PR. Review Codex su `4476ecd`: 0 rilievi Standards e Spec; nuovi test rieseguiti sui tre browser senza retry (10 passati, 14 skip previsti) e CI verde. |
| T2 — Stream, reload e diagnostica | Alta | Completato | [#8](https://github.com/tosdan/mockxy-acceptance-tests/pull/8), integrata (`8dcec08`): `tests/stream-reload.spec.js`, 6 test su Chromium in un solo worker. Motore `7456cdc` (codice identico a `v1.4.1`), suite `b7de454`. Suite completa verde: chromium 77, firefox 51 (+26 skip), webkit 51 (+26 skip), chromium-stack-mutating 1; nuovi test ripetuti 5 volte senza retry (`--workers=1`), 30/30. Tre controprove sul motore alterato nel solo container, poi ricreato. **Divergenza da sottoporre alla review:** gli `id` delle connessioni SSE/WS sono numeri, lo spec li dichiara stringhe. Review Codex su `9e263ac`: P3 (callback WS che dopo `wsCloseAll` scrivevano nel registro svuotato, `TypeError` nella pagina) e P2 (causa `admin` pretesa sull'ultimo tentativo, che l'eco del watcher può sostituire), entrambi riprodotti e corretti; regressione sugli errori della pagina, che fallisce in 4 test su 6 con il client precedente. Divergenza risolta nel motore con [mockxy#41](https://github.com/tosdan/mockxy/pull/41), integrata: lo spec dichiara interi i quattro identificativi delle connessioni, con un test di contratto su connessioni reali. Secondo giro di review su `89df9c3`: positivo. |
| T3 — Setup ripetibile tramite API, browser e Monitor | Alta | Completato | [#9](https://github.com/tosdan/mockxy-acceptance-tests/pull/9), integrata: `tests/agent-setup.spec.js` e helper `tests/agent-setup.js`, istanza `mockxy-setup` con CORS spento all'avvio; 6 test su Chromium in un solo worker. Motore `939d992` (`main`, dopo la #41), suite `b45bbd3`. Suite completa verde: chromium 83, firefox 51 (+32 skip), webkit 51 (+32 skip), chromium-stack-mutating 1; nuovi test ripetuti 5 volte senza retry (`--workers=1`), 30/30. Quattro controprove sul setup (CORS non dichiarato, reset mancante, modalità mock mancante, variante preparata selezionata). Review Codex su `d7ef868`: due P2, entrambi riprodotti e corretti. Il controllo iniziale del contratto ora copre tutte le operazioni usate, con una prova negativa: uno stub senza `PUT /mocks/{id}` dà `CONTRACT_UNVERIFIABLE` dopo le sole due letture. La preparazione inattiva confronta la risposta realmente servita mentre la bozza esiste; la controprova con la bozza servita fallisce su quell'asserzione. Secondo giro di review su `8744b6b`: 0 rilievi. |
| T4 — Configurazione effimera e connessioni esistenti | Media | Completato | [#10](https://github.com/tosdan/mockxy-acceptance-tests/pull/10), integrata: `tests/runtime-config.spec.js` (4 test, Chromium in ordine) e `tests/runtime-config-restart.spec.js` (project `chromium-config-restart`, dopo `chromium-stack-mutating`); istanza `mockxy-config`, secondo backend `backend-b`, backend finto con identità e contatori per path. Barriera della richiesta in volo: riga `Request received.` nel log del container, poi contatore del backend a zero dopo il PATCH (proposta di Codex). Motore `939d992`, suite `b9c6195`. Suite completa verde: chromium 87, firefox 51 (+36 skip), webkit 51 (+36 skip), chromium-stack-mutating 1, chromium-config-restart 1; nuovi test ripetuti senza retry (`--workers=1`): 20/20 e riavvio 3/3. Due controprove. Review Codex su `713b61b`: un P2, riprodotto e corretto. Il test di riavvio non ripuliva gli override se falliva prima del riavvio; ora `withStartupRestored` prepara lo stato di avvio e lo ripristina anche dopo un fallimento, con attesa limitata. La regressione simula il comando Docker che fallisce e fallisce se si toglie il `finally`. Secondo giro su `ef24dac`: un P2 sul budget del cleanup, che condivideva il timeout del test. Ripristino spostato in hook con budget proprio (`testInfo.setTimeout`), in `tests/config-restore.js`. Due regressioni in un processo Playwright figlio: errore immediato, e scadenza con l'istanza in pausa per 20 s, oltre gli 8 s di budget normale. Togliendo l'estensione del budget, la seconda fallisce con gli override rimasti. Terzo giro su `139e994`: due P2 sulle regressioni, entrambi corretti. Il processo figlio usa una cartella temporanea propria (`outputDir`), verificata con un artefatto sentinella della suite. La guardia misura la pausa effettiva fra due marcatori: `docker compose pause` riuscito, e `unpause` riuscito dopo 20 s, possibile solo se il container era ancora in pausa. Tre controprove: senza `outputDir`, pausa reale di 1 s, hook senza budget. Quarto giro su `6732d36`: 0 rilievi. |
| T5 — Cattura e riproduzione del traffico | Media | Completato | [#11](https://github.com/tosdan/mockxy-acceptance-tests/pull/11), integrata: `tests/capture-replay.spec.js` (4 test, Chromium in ordine), istanza `mockxy-capture`, helper `createMocksFromMonitor`/`readMonitorEntry`/`requireWritten` in `tests/agent-setup.js`, backend con risposte riconoscibili e binarie sotto `/capture/`. Motore `939d992`, suite `c8b9443`. Suite completa verde: chromium 91, firefox 51 (+40 skip), webkit 51 (+40 skip), chromium-stack-mutating 1, chromium-config-restart 3; nuovi test ripetuti senza retry (`--workers=1`): 20/20. Quattro controprove. Review Codex su `ffed4e0`: un P2. Il test della risposta persa poteva passare con un helper che ripete, perché il timeout di 1 ms può scadere prima dell'invio. Ora un proxy di test lascia completare la creazione sul motore reale e perde solo la risposta. Il test verifica una sola richiesta, il 201 perso e un endpoint con una variante; con un helper che ripete fallisce (2 richieste). Secondo giro su `204bec5`: 0 rilievi. Due osservazioni sul motore (descrizioni YAML troncate nello spec, `x-mock-source` copiato nei mock creati dalle catture) risolte in [mockxy#42](https://github.com/tosdan/mockxy/pull/42) e [mockxy-skills#15](https://github.com/tosdan/mockxy-skills/pull/15), integrate; l'asserzione sul mock salvato è nella verifica finale. |

- [x] Procedere con PR reviewabili: T0 può accompagnare T1; separare poi T2, T3, T4 e T5, salvo motivata diversa suddivisione.
- [x] Per ogni PR riportare scenari coperti, test eseguiti, coppia commit della suite / commit del motore e limiti o verifiche mancanti.
- [x] Registrare gli esiti della review e delle correzioni nelle evidenze del passo.
- [x] Segnare un passo completato dopo merge, criteri soddisfatti, verifiche e documentazione aggiornate. CI verde da sola non prova la copertura dei criteri.

## T0 — Isolamento e infrastruttura

- [x] Predisporre un'istanza standalone amministrabile dedicata ai nuovi scenari, con seed minimo copiato in workspace scrivibile, preferibilmente tmpfs. Impostare esplicitamente admin, allowlist Host, backend e CORS necessari.
- [x] Preservare l'istanza principale e i suoi bind mount read-only. Non usare l'istanza `mockxy-sequence-admin` per cambiare impostazioni globali dei nuovi scenari.
- [x] Per il watcher usare una fixture di sviluppo dedicata, con admin esplicitamente abilitata e filesystem modificabile dal test; non condividere i file modificati da `dev-watch.spec.js`. _Con T2: `mockxy-stream`, servizio di sviluppo con seed in tmpfs modificato con `docker compose exec`; `mockxy-dev` resta com'è._
- [x] Allineare nuove istanze in `docker-compose.yml`, `tests/stack.js` e `tests/global-setup.js`; ogni servizio ha un healthcheck che verifica il serving effettivo di una rotta di fixture.
- [x] Definire chi possiede ogni stato mutabile. I test che condividono configurazione, Monitor o file devono essere serializzati oppure usare istanze isolate. Limitarsi a Chromium non serializza file diversi con `fullyParallel: true`.
- [x] Eseguire i casi che riavviano o ricreano container senza concorrenza con altri test: seguire il modello del project `chromium-stack-mutating`, includendo la serializzazione fra i suoi stessi test quando necessaria. _Con T4: il riavvio di `mockxy-config` è nel project `chromium-config-restart`, in catena dopo `chromium-stack-mutating`._
- [x] Eseguire sui tre browser gli scenari di semantica browser compatibili con l'isolamento scelto. Documentare quelli eseguiti solo su Chromium e il motivo.
- [x] Ogni test prepara esplicitamente lo stato da cui dipende; il cleanup chiude connessioni e ripristina le fixture anche dopo un fallimento. Un retry non deve trovare residui del tentativo precedente. _Regola documentata nel README; T1 non muta stato, i passi successivi la applicano ai propri cleanup._
- [x] Per mutazioni e discovery usare il client HTTP amministrativo di Playwright/Node. Le chiamate applicative partono dal browser reale; non rendere l'admin API leggibile cross-origin per facilitare i test.

**Completamento:** stack avviabile da checkout pulito, suite esistente ancora verde e nessuna nuova dipendenza d'ordine implicita tra test.

## T1 — Discovery e accesso nell'immagine distribuita

- [x] Nell'immagine standalone con admin abilitata leggere `/info`, `/config`, `/runtime/status` e `/openapi.yaml` attraverso `/_admin/api`.
- [x] Verificare versione del checkout costruito e coerenza di `runtimeId` tra le risposte JSON. Non hardcodificare `1.4.1` nei test destinati a seguire `main`.
- [x] Verificare che `/info` riporti i percorsi del workspace dentro il container e l'indirizzo effettivo del listener. La porta interna può differire da quella pubblicata sull'host.
- [x] Verificare che `/config` rappresenti le impostazioni dichiarate dalla fixture, con `startup`, `effective`, `overrides` e `persisted: false` coerenti.
- [x] Scaricare e interpretare lo spec YAML dal container; verificare il contratto delle rotte usate dai nuovi scenari. Il test non deve recuperare lo spec dal checkout host per compensare un file assente nell'immagine.
- [x] Sull'istanza standalone con admin disabilitata verificare `404` sulle quattro rotte, anche in presenza del proxy fallback.
- [x] Estendere le prove di accesso: un Host non consentito riceve `403`; il browser sull'origine del client non può leggere le nuove rotte admin, anche quando CORS è attivo per il traffico applicativo.

**Completamento:** discovery utilizzabile dall'artefatto distribuito e accesso amministrativo confinato come previsto. Non serve ricopiare tutta la matrice degli schemi dei test interni.

## T2 — Stream, reload e diagnostica

- [x] Aprire SSE e WebSocket dal browser e attendere la conferma che entrambe le connessioni siano effettivamente registrate nelle console.
- [x] Modificare la descrizione, preparare una variante realmente inattiva sullo stesso endpoint e modificare un endpoint estraneo: le connessioni originali restano aperte e il copione non riparte.
- [x] Rilevare le riconnessioni nascoste di EventSource: confrontare l'identità della connessione in console e gli eventi di apertura/errore, oltre ai messaggi ricevuti. Ricevere messaggi dopo il reload, da solo, non dimostra la preservazione.
- [x] Modificare il copione attivo SSE e verificare la chiusura della connessione originale SSE, lasciando aperta la WS; fare la verifica simmetrica cambiando il comportamento WS.
- [x] Sul servizio con watcher verificare che una modifica estranea e il suo reload non interrompano lo stream. Attendere il tentativo concluso, non un numero fisso di reload: API e watcher possono aggregare le cause.
- [x] Tramite filesystem rendere illeggibile una nuova definizione di stream selezionata (_contenuto non interpretabile: nel container si è root, un `chmod` non basta_): il runtime mantiene lo stream precedente, `/runtime/status` dichiara `degraded` e `serving: retained`, push e stato della console continuano a funzionare sulla definizione servita.
- [x] Corrompere il sorgente di un handler già caricato: il browser continua a ricevere la risposta precedente e la diagnostica segnala il mantenimento. Correggere il sorgente e verificare nuova risposta, rimozione dell'errore e aggiornamento della revisione `diagnostics`.
- [x] Ripristinare tutti i file e chiudere le connessioni anche se un'asserzione fallisce. Usare attese con scadenza per il watcher, senza modificare il codice del motore o iniettare errori nei suoi moduli.

**Completamento:** la continuità degli stream e la diagnostica sono dimostrate su rete e filesystem reali, senza che la riconnessione automatica mascheri una regressione.

## T3 — Setup ripetibile tramite API, browser e Monitor

- [x] Predisporre un endpoint statico e uno sequence con ID e filename risolti dal catalogo, senza scegliere il bersaglio tramite titolo o selezione corrente.
- [x] L'helper legge discovery e configurazione, verifica il workspace atteso e dichiara via API tutte le impostazioni da cui dipende la prova: selezioni, abilitazioni, Proxy All, ritardi, templating e configurazione runtime pertinente.
- [x] Preparare una variante con `select: false`; leggerla per filename e verificare che preparazione e lettura non modifichino risposta corrente, selezione o cursore della sequence. Una variante usata come step della sequence selezionata è attiva: non usarla come esempio di preparazione inattiva.
- [x] Attivare esplicitamente la variante desiderata, abilitare gli endpoint, disattivare Proxy All e resettare la sequence. Il successo della mutazione è la barriera di applicazione: non aggiungere sleep per aspettare l'eco del watcher.
- [x] Eseguire lo stesso setup e le stesse asserzioni browser in tre condizioni: alternativa selezionata e sequence consumata; endpoint disabilitati e Proxy All attivo; ripetizione immediata del setup senza ripristino.
- [x] La pagina del client usa fetch reali verso Mockxy e verifica contenuto e ordine dei risultati, inclusi i due step della sequence. Configurare CORS esplicitamente per l'origine nginx; non intercettare le risposte applicative con `page.route`.
- [x] Dopo il setup e prima dell'azione browser acquisire `view=page&since=latest`. Leggere le pagine successive riusando `runtimeId`, `generation`, `since` e gli stessi filtri; verificare `gap: false` su ogni pagina.
- [x] Correlare le voci per metodo/path e verificare gli esiti applicativi attesi. Non contare tutte le voci del Monitor: favicon, healthcheck e altro traffico accessorio non devono rendere la prova fragile.
- [x] Verificare una perdita osservabile: dopo clear del Monitor, il vecchio cursore produce `gap: true` con `gapReason: cleared`; l'helper non interpreta la risposta come assenza di traffico.
- [x] Aggiungere un solo scenario di concorrenza protetta: due client leggono la stessa revisione, il primo salva, il secondo riceve `409 REVISION_CONFLICT`; il primo contenuto resta intatto. Non duplicare la matrice completa dei token.
- [x] Le attese sul Monitor hanno una scadenza complessiva che limita anche le singole richieste e l'attraversamento di tutte le pagine. Errori di setup, conflitti e gap falliscono con diagnostica utile, senza retry ciechi delle scritture.

**Completamento:** lo scenario produce lo stesso risultato partendo da stati diversi e il traffico osservato è attribuibile all'azione appena eseguita.

## T4 — Configurazione effimera e connessioni esistenti

- [x] Sul servizio dedicato impostare un override, verificarlo con `GET /config` e verificare il comportamento dalla richiesta applicativa successiva; controllare anche l'avanzamento della revisione `config` in `/info`.
- [x] Cambiare `corsEnabled` e verificare dal browser l'accettazione o il blocco della risposta. Usare richieste/origini nuove o gestire esplicitamente la cache dei preflight per evitare risultati dovuti alla cache del browser.
- [x] Distinguere `set: { backendUrl: null }` da `unset: ["backendUrl"]`: il primo disattiva il backend, il secondo ripristina quello di avvio. Verificare il serving, non soltanto il JSON di configurazione.
- [x] Usare due backend distinguibili: una richiesta iniziata prima del cambio, ancora nel ritardo, raggiunge il vecchio backend; la richiesta successiva raggiunge il nuovo. Dimostrare che la prima è entrata nel motore prima del PATCH mediante una barriera osservabile, non assumendolo perché il fetch è stato appena avviato.
- [x] Aprire un tunnel WS verso il backend, cambiare `backendUrl` e verificare che il tunnel aperto continui sul backend originale e una nuova connessione usi quello nuovo.
- [x] Riavviare il servizio dedicato nel project isolato: cambia `runtimeId`, gli override spariscono e `effective` torna a `startup`. Con il cursore precedente il Monitor segnala `gapReason: runtime_changed`.
- [x] Preservare il test esistente della cache dei preflight che ricrea il container cambiando configurazione di avvio: il PATCH runtime è un caso aggiuntivo, non un sostituto.

**Completamento:** gli override cambiano il traffico nuovo, preservano il ciclo delle richieste e connessioni esistenti e non sopravvivono al riavvio. Non occorre ripetere la validazione di tutte le nove chiavi.

## T5 — Cattura e riproduzione del traffico

- [x] Generare dal browser una risposta riconoscibile del backend, con status, body e almeno un header significativo; trovare la cattura tramite cursore del Monitor e leggere la voce completa per ID e `runtimeId`.
- [x] Chiamare `POST /_admin/api/monitoring/requests/create-mocks` con `runtimeId`, ID catturato, `onConflict`, `selectAddedVariants: false` e `newEndpointEnabled: false` espliciti.
- [x] Leggere gli esiti per elemento anche con `201`: verificare scrittura e completezza della cattura. Un elemento non applicato non può essere trattato come scenario già attivo.
- [x] Verificare che il nuovo endpoint rimanga disabilitato e che prima dell'attivazione il browser continui a ricevere il backend.
- [x] Attivare il mock esplicitamente e verificare status, body e header dal browser. Dimostrare che il backend non è stato chiamato mediante contatore o altra evidenza del backend; uguaglianza del body da sola non prova il passaggio al mock.
- [x] Per un endpoint esistente, provare `add-variant` senza selezione: la variante aggiunta è identificabile e il comportamento attivo resta invariato fino all'attivazione esplicita.
- [x] Generare una cattura non ricostruibile dal backend reale, per esempio binaria: verificarne `captureOutcome: incomplete`, warning `INCOMPLETE_CAPTURE` e preparazione non attiva. Non presentare la bozza come replay fedele.
- [x] Nessun retry cieco della creazione dopo timeout o risposta persa: il test fallisce con dettagli sufficienti per ispezionare il catalogo. Non duplicare qui tutte le fixture di trasformazione già presenti nei test interni.

**Completamento:** il traffico reale diventa un mock preparato senza attivazione implicita e il successivo replay è verificato attraverso il browser e il backend.

## Verifica finale e consegna

Evidenze sulla suite del branch della verifica finale, con il motore `main` (`2b19401`, dopo mockxy#42) e con il tag `v1.4.1`.

- [x] Eseguire i test nuovi e la suite completa, annotando risultati per project e gli skip motivati. Verificare che i vecchi scenari restino coperti.

  Suite completa, motore `main`, senza retry: chromium 91, firefox 51, webkit 51, chromium-stack-mutating 1, chromium-config-restart 3. Nessun fallimento e nessun test instabile. I vecchi scenari restano tutti verdi.

  Gli skip (40 per Firefox e 40 per WebKit) sono i test dichiarati solo Chromium:
  - quelli stateful, sull'istanza condivisa;
  - quelli solo HTTP, senza semantica browser.

  Il motivo è scritto in ogni `test.skip` e nel README.

  _In locale con 4 worker invece di 8: con la memoria della macchina quasi esaurita da altre applicazioni, 8 worker e 14 container mandavano in timeout Firefox e WebKit per attesa sul disco. La CI resta il riferimento._
- [x] Ripetere i nuovi scenari senza retry automatici per controllare isolamento, cleanup e stabilità; non aumentare globalmente timeout o retry per nascondere interferenze.

  I nuovi file sui tre project browser, con `--repeat-each=3 --retries=0 --workers=1`: 90/90. Il project del riavvio ripetuto 2 volte: 6/6. Timeout e retry globali sono invariati.
- [x] Per ogni garanzia centrale dimostrare che la prova distingue comportamento corretto e scorretto, con una controprova mirata o un'altra evidenza equivalente. Rimuovere le alterazioni temporanee e annotare quali asserzioni rilevano la regressione.

  Le controprove sono elencate per passo nelle evidenze e nelle PR #7–#11. Le alterazioni del motore sono state applicate solo ai container in esecuzione, poi ricreati dall'immagine.
- [x] Verificare la coppia suite / motore `v1.4.1` e il funzionamento della CI con il normale ref corrente. I workflow già costruiscono il motore e consumano questa suite: modificarli solo per esigenze concrete dei nuovi scenari.

  Suite contro `v1.4.1`, con `../mockxy` sul tag e le immagini ricostruite:
  - firefox 51 e webkit 51, tutti verdi;
  - chromium 90 su 91: fallisce solo l'asserzione nuova sull'assenza di `x-mock-source` nel mock salvato, comportamento corretto dopo la 1.4.1 da mockxy#42 (atteso);
  - chromium-stack-mutating 1 e chromium-config-restart 3, eseguiti con `--no-deps`.

  Poi il motore è tornato su `main`, con le immagini ricostruite. Il dispatch manuale del workflow con `engine-ref=v1.4.1` non era permesso dal token disponibile (403), quindi la verifica è stata locale. La CI della PR usa il ref normale (`main`). I workflow non sono stati modificati.
- [x] Aggiornare il README: topologia, coperture, comandi e isolamento. Correggere riferimenti obsoleti senza introdurre conteggi dei test destinati a diventare subito vecchi.

  Topologia, tabella di proprietà dello stato e righe di copertura sono state aggiornate passo per passo. Nella verifica finale:
  - browser e prerequisiti, compreso il CLI `docker compose`, resi attuali;
  - tolti i conteggi «jest, 400+» e «una dozzina di scenari»;
  - nuovi scenari aggiunti all'elenco dei test stateful.
- [x] Mantenere nel repository `mockxy` i test della GUI Angular, delle bozze e dell'upload corretto dalla #40: lo stack standalone di questa suite non contiene quella GUI.

  Nessun test della GUI è stato spostato. Il README lo dichiara nel perimetro della suite.
- [ ] Concludere con tutte le righe di avanzamento aggiornate, PR integrate, eventuali limiti espliciti e nessuna fixture versionata lasciata modificata dalle esecuzioni.

  Righe T0–T5 completate, con le PR #7–#11 integrate. I limiti sono dichiarati nelle PR e nel README. Dopo le esecuzioni `git status` mostra solo le modifiche intenzionali, quindi nessuna fixture versionata è stata alterata. _Si chiude dopo il merge della PR della verifica finale._
