# Test esterni black-box di Mockxy

Suite di test **di sistema** che esercita Mockxy dall'esterno, come lo vede un consumatore
reale: l'**immagine Docker standalone** (costruita da `../mockxy`, non una copia del
codice) nella topologia completa «browser → Mockxy → backend», con **browser veri**
(Playwright: Chromium, Firefox e WebKit) come client.

## Perché esistono, e cosa NON sono

I test interni del progetto (jest) coprono la logica del motore a livello HTTP, ma tre
classi di comportamento sono fuori dalla loro portata **per costruzione**:

1. **La semantica browser** — CORS, preflight e loro cache, credenziali, cookie `SameSite`:
   sono applicati dal *browser*, non dal server. Un test che simula l'header `Origin` verifica
   cosa emette Mockxy, non se un browser reale lo accetta. Qui le chiamate partono da una
   pagina servita su un'**altra origin**, quindi il browser applica le regole per davvero.
2. **L'artefatto distribuito** — il packaging Docker: dipendenze di produzione, env, bind
   mount del workspace. Un bug da imballaggio (dipendenza mancante nell'immagine) i test jest
   non lo vedranno mai.
3. **La topologia reale** — proxy verso un backend su una rete separata, redirect che senza
   riscrittura punterebbero a un host irraggiungibile, cookie che attraversano due hop.

Questi test **non sostituiscono** quelli interni e non ne duplicano la matrice (filtri,
paginazione, CRUD dell'admin API…): sono scenari mirati alle tre classi sopra. Gli scenari del
pilotaggio da agent (discovery, setup ripetibile, stream durante i reload, configurazione
effimera, cattura e riproduzione) usano l'admin API dell'artefatto distribuito con rete,
browser e filesystem reali. Quando un comportamento è testabile bene da jest, va testato lì.

Restano nel repository `mockxy` i test della GUI Angular (bozze, sincronizzazione, upload dopo
una creazione): lo stack standalone di questa suite non contiene la GUI.

## Architettura dello stack

```
client (nginx, :8081)  ──origin diversa──▶  mockxy (:8080, immagine standalone, CORS attivo)
                                               │ proxy fallback
                                               ▼
Playwright (host) ──pilota──▶ browser       backend finto (node puro, :9090 per debug)
                                               ▲
                       mockxy-raw (:8090) ─────┤  (stessa immagine: CORS/adattamenti SPENTI
                                               │   e timeout basso, per i test di contrasto)
                       mockxy-dev (:8070) ─────┤  (immagine di SVILUPPO: watch con polling su
                                               │   workspace-watch/ montato scrivibile)
                     mockxy-delay (:8050) ─────┤  (ritardo globale 600ms, anche sul proxy)
            mockxy-sequence-admin (:8040) ─────┤  (workspace in tmpfs, CRUD sequence isolato)
                 mockxy-discovery (:8030) ─────┤  (admin attiva, nove impostazioni dichiarate,
                                               │   seed in tmpfs: discovery in sola lettura)
                    mockxy-stream (:8020) ─────┤  (immagine di SVILUPPO: watcher + admin, seed
                                               │   in tmpfs modificato con docker compose exec)
                     mockxy-setup (:8010) ─────┤  (admin attiva, CORS spento all'avvio: lo
                                               │   dichiara il setup ripetibile via API)
                    mockxy-config (:8005) ─────┤  (configurazione effimera: backend "a" all'avvio,
                                               │   override verso backend-b, riavvio isolato)
                   mockxy-capture (:8015) ─────┤  (traffico reale catturato e trasformato in mock
                                               │   preparati, senza attivazione implicita)
                    mockxy-toggle (:8060) ─────┘  (CORS commutabile a runtime dal test
                                                   della cache dei preflight)

                    mockxy-config (:8005) ─────▶  backend-b (stesso backend finto con identità
                                                   "b", :9091 per leggerne i contatori)
```

L'istanza principale espone anche l'**admin API** (`ADMIN_API_ENABLED=true` +
`ADMIN_ALLOWED_HOSTS=localhost`, che attiva la guardia DNS-rebinding sul bind di rete).

- Il **backend finto** (`backend/server.js`) è volutamente "ostile" al viaggio attraverso un
  proxy locale: policy CORS di un'altra origin, `Set-Cookie` con `Domain`/`Secure`/
  `SameSite=None`, redirect assoluti verso il proprio indirizzo interno. Sono esattamente le
  cose che Mockxy deve sovrascrivere, adattare e riscrivere.
- La **pagina client** (`client/index.html`) è il minimo indispensabile: un helper `callApi`
  che riporta esito, header leggibili e body — o `blocked: true` quando il browser rifiuta —
  più gli helper WebSocket/SSE usati dai test. Accanto ci sono due micro app per le
  [prove manuali](#prove-manuali-i-tester-websocket-e-sse) dei mock WebSocket e SSE.
- I **mock di fixture** stanno in `workspace/mocks/` e arrivano al container via bind mount
  read-only, come nell'uso documentato dell'immagine standalone.

## Come si lancia

Prerequisiti: Docker con il CLI `docker compose` (alcuni test lo usano direttamente per
modificare file nei container, riavviarli o metterli in pausa), Node ≥ 20.

```bash
npm install                                     # solo la prima volta
npx playwright install chromium firefox webkit  # solo la prima volta
npm run stack:up                                # costruisce le immagini e avvia lo stack completo
npm test                                        # esegue la suite Playwright
npm run stack:down                              # spegne lo stack
```

Lo stack resta su tra un run e l'altro: in iterazione basta `npm test`. Se i container non
sono su, il setup globale fallisce subito con un messaggio esplicito. Per vedere il browser:
`npm run test:headed`. Log dei container: `npm run stack:logs`.

La suite gira su **tre motori browser** (Chromium, Firefox, WebKit): le semantiche sotto
test — CORS, cookie, preflight, SSE — sono proprio quelle che divergono tra i motori. I test
stateful (sequence, shared runtime state, hot reload, cache dei preflight e gli scenari del
pilotaggio da agent) si autolimitano a Chromium perché mutano stato condiviso mentre i project
girano in parallelo: vedi [Isolamento e stato mutabile](#isolamento-e-stato-mutabile). In CI
c'è un retry automatico (`retries: 1` solo con `CI` impostata); in locale la flakiness resta
visibile.

## Isolamento e stato mutabile

Ogni stato che un test può cambiare ha un proprietario: i test che lo condividono girano in
serie, gli altri usano un'istanza propria. Limitarsi a Chromium evita solo l'esecuzione
parallela dello stesso file nei tre project: con `fullyParallel: true` file diversi girano
comunque in parallelo, quindi due file non devono mutare lo stesso stato.

| Istanza | Proprietario dello stato mutabile | Stato mutabile | Esecuzione |
|---|---|---|---|
| `mockxy` (:8080) | `sequences`, `shared-state`, push di `sse-mock`/`ws-mock` | solo stato runtime (cursori, stato condiviso, broadcast); workspace read-only | test stateful su Chromium, in serie nel loro file; il resto sui tre browser |
| `mockxy-raw` (:8090) | nessuno | nessuno | tre browser |
| `mockxy-delay` (:8050) | nessuno | nessuno | tre browser |
| `mockxy-sequence-admin` (:8040) | `sequences` | catalogo in tmpfs, cursori | Chromium, in serie |
| `mockxy-dev` (:8070) | `dev-watch` | file di `workspace-watch/` | Chromium |
| `mockxy-toggle` (:8060) | `preflight-cache` | il container, ricreato | project `chromium-stack-mutating`, dopo i tre browser |
| `mockxy-discovery` (:8030) | nessuno: `discovery` la legge soltanto | nessuno (seed in tmpfs) | letture HTTP su Chromium, accesso cross-origin sui tre browser |
| `mockxy-stream` (:8020) | `stream-reload` | file del tmpfs, connessioni SSE/WS e console | Chromium, in ordine in un solo worker; ogni test riparte dal seed |
| `mockxy-config` (:8005) | `runtime-config`, poi `runtime-config-restart` | configurazione runtime, tunnel WebSocket, il container (riavviato e messo in pausa) | Chromium, in ordine; il riavvio nel project `chromium-config-restart`, dopo tutti gli altri |
| `mockxy-capture` (:8015) | `capture-replay` | catalogo in tmpfs e Monitor | Chromium, in ordine; path unici per test, endpoint creati rimossi anche dopo un fallimento |
| `backend` / `backend-b` (:9090 / :9091) | nessuno in esclusiva | contatori per path sotto `/identity/` e `/capture/` (path unici per test) e di `/api/tracked` (`preflight-cache`) | — |
| `mockxy-setup` (:8010) | `agent-setup` | catalogo in tmpfs, modalità server, configurazione runtime, Monitor | Chromium, in ordine in un solo worker; i casi non ripristinano niente fra loro, ogni test dichiara lo stato da cui dipende |

Regole per le istanze nuove:

- una nuova istanza amministrabile copia un seed minimo in tmpfs (`command` con `cp -R /seed/.`)
  e dichiara esplicitamente admin, allowlist Host, backend e CORS di cui ha bisogno;
- ogni istanza è allineata in `docker-compose.yml` (con un healthcheck che verifica il serving
  di una rotta di fixture), `tests/stack.js` e `tests/global-setup.js`;
- i test che riavviano o ricreano container vanno in un project dedicato, dopo i project browser:
  `chromium-stack-mutating` (`preflight-cache`) e poi `chromium-config-restart`
  (`runtime-config-restart`), in catena, così non girano mai in concorrenza nemmeno fra loro;
- i file di un'istanza in tmpfs si modificano con `docker compose exec` (serve il CLI docker,
  come per `preflight-cache`), e l'attesa del reload guarda il suo effetto osservabile
  (errore in diagnostica, risposta servita), non un numero fisso di tentativi;
- le mutazioni e le letture dell'admin API passano dal client HTTP di Playwright
  (`tests/admin-client.js`), mai dal browser: l'admin API non è leggibile cross-origin e non
  va resa tale per i test;
- ogni test prepara lo stato da cui dipende e il cleanup lo ripristina anche dopo un
  fallimento, così un retry non trova residui. Un cleanup che può dover attendere più del tempo
  rimasto al test (per esempio un'istanza a metà di un riavvio) sta in un hook che si dà un
  budget proprio con `testInfo.setTimeout` (vedi `tests/config-restore.js`). Gli hook ricevono il
  timeout del test: oltre quello, il cleanup verrebbe interrotto.

I test che usano solo il client HTTP (senza semantica browser) girano una volta, su Chromium:
il motore del browser non cambia l'esito.

Per ripetere dei test che condividono un'istanza, aggiungere `--workers=1` a `--repeat-each`:
altrimenti Playwright distribuisce le ripetizioni su più worker, che userebbero la stessa
istanza nello stesso momento.

Le istanze con seed in tmpfs montano la cartella del seed dall'host. Se un cambio di branch la
rimuove e la ricrea, il container resta legato alla cartella cancellata e vede un seed vuoto:
dopo un checkout che tocca `workspace-*/` conviene `docker compose up -d --force-recreate`.

**Nota di versioning**: la suite testa l'immagine costruita dal checkout corrente di
`../mockxy`. Dopo modifiche al motore serve `npm run stack:up` (ri-build) per testare la
versione nuova; annotare nei commit di questo repo contro quale commit del motore si è verde.

## Prove manuali: i tester WebSocket e SSE

Oltre alla suite automatica, il container nginx del client serve due **micro app
autocontenute** (un singolo file HTML ciascuna, zero dipendenze) per esplorare a mano i mock
streaming di Mockxy — utili per provare un copione appena scritto, guardare le regole
rispondere in diretta o fare da "pubblico" alla regia della console admin. Servono solo lo
stack su (`npm run stack:up`) e un browser:

- **<http://localhost:8081/ws-tester.html>** — apre una WebSocket vera verso l'URL indicato
  (default `ws://localhost:8080/ws-rules`) e mostra il transcript nei due versi con
  timestamp: ▶ quello che invii, ◀ quello che arriva dal mock. Il composer manda messaggi
  liberi (Invio per spedire); le macro `ping` e `subscribe` esercitano le due regole della
  fixture `/ws-rules`. Alla chiusura il log riporta codice, reason e se è stata pulita: con
  `ws://localhost:8080/ws-close` si vede arrivare il `4001 "lavoro concluso"` del mock.
  Connettendosi a `/ws-console` (endpoint muto) si riceve solo ciò che spinge la regia
  manuale: l'immagine standalone non ha la UI, quindi qui si fa via admin API — l'`id` si
  legge dal catalogo (`curl http://localhost:8080/_admin/api/mocks`) e poi
  `curl -X POST http://localhost:8080/_admin/api/mocks/<id>/ws/push -H 'content-type: application/json' -d '{"data":{"message":"ciao"}}'`.
- **<http://localhost:8081/sse-tester.html>** — apre una EventSource verso l'URL indicato
  (default `http://localhost:8080/sse-script`) e logga gli eventi con tipo, payload e
  `lastEventId`. Gli eventi con `event:` nominato arrivano solo ai listener registrati per
  tipo: vanno elencati nel campo «eventi nominati» **prima** di connettersi (per
  `/sse-named`: `progress, done`). Con `/sse-close` si osserva il giro completo di
  chiusura dal server e riconnessione automatica di EventSource, annunciata nel log.

Entrambe partono dall'origin `:8081`, la stessa dei test: le prove manuali attraversano la
stessa topologia cross-origin della suite. Gli URL sono editabili, quindi si possono puntare
anche le altre istanze dello stack o mock creati al volo via admin API — con un distinguo:
l'EventSource è soggetta a CORS (contro l'istanza raw su `:8090` il browser la blocca), le
WebSocket no (l'handshake `ws://` non passa dal CORS e funziona anche lì). Le pagine sono
linkate anche da <http://localhost:8081/>.

## CI

Il workflow [`black-box.yml`](.github/workflows/black-box.yml) esegue l'intera suite su ogni
push/PR: checkout dei due repo affiancati, build dell'immagine standalone dal ref del motore
(default `main`), stack su, Playwright. Ogni run verde certifica la coppia «motore @ ref ×
suite @ commit». Con **Run workflow** (dispatch manuale) si può puntare un ref diverso del
motore — un tag, un branch di lavoro, uno SHA.

Se il repo del motore è **privato**, il checkout cross-repo richiede un fine-grained PAT con
permesso `contents: read` su `mockxy`, salvato nei secrets di questo repo come
`ENGINE_REPO_TOKEN`. Se è pubblico non serve nulla.

Su fallimento il workflow allega i log dei container e il report Playwright come artifact.

Esiste anche il **workflow speculare nel repo del motore** (`acceptance` in
`mockxy`): a ogni push sul motore lancia questa suite (al suo `main`, o al ref
scelto col dispatch) contro quel commit. I due workflow sono gemelli con il pinning
invertito: qui è fisso il commit della suite e si sceglie il motore, lì il contrario.

## Cosa copre oggi

| Area | Scenari |
|---|---|
| Smoke (`smoke.spec.js`) | mock servito cross-origin, proxy fallback, `x-mock-source` leggibile dal JS (⇒ `Expose-Headers`), la policy CORS del backend viene sovrascritta |
| CORS (`cors.spec.js`) | blocco reale a CORS spento, preflight su POST JSON, header custom a eco, precedenza del mock `OPTIONS` esplicito, forma della risposta di preflight |
| Cookie (`cookies.spec.js`) | login → cookie adattato → sessione che tiene; rimozione di `Domain`/`Secure`/`SameSite=None` e contrasto ad adattamento spento |
| Redirect (`redirects.spec.js`) | riscrittura del `Location` assoluto (il browser resta su Mockxy), relativi e host terzi intatti, contrasto a riscrittura spenta |
| WebSocket (`websocket.spec.js`) | passthrough dell'upgrade dal browser: push server→client e eco client→server attraverso il tunnel, round-trip del codice di chiusura applicativo; controllo in diretta sul backend per isolare i guasti |
| Mock WebSocket (`ws-mock.spec.js`) | mock ws con WebSocket vera del browser: copione consegnato progressivamente e che riparte a ogni connessione, regole di risposta (reply solo a chi ha parlato, match json-subset cadenzato, niente eco di default), `onEnd close` con codice/reason applicativi fino al browser, 426 sulla GET normale, push broadcast della console via admin API con transcript |
| Mock SSE (`sse-mock.spec.js`) | mock sse con EventSource vera: copione progressivo che riparte a ogni connessione, eventi nominati con `lastEventId`, chiusura dal server e riconnessione automatica, push della console via admin API |
| Sequenze (`sequences.spec.js`) | response `sequence` selezionata vista dall'immagine standalone: `times`, `forMs`, `stay`/`loop`, detail/state/reset; su un'istanza amministrabile con workspace in tmpfs anche create/select/disattivazione, identità di più sequence e `409` sui target referenziati (stateful ⇒ solo chromium, in serie) |
| Templating (`templating.spec.js`) | mock statici con `templated: true` attraverso l'immagine standalone: placeholder da richiesta e header, filtri di tipo, helper `now`, sorgente mancante ⇒ stringa vuota, escape `\{{` |
| Timeout (`timeouts.spec.js`) | 502 allo scadere di `REQUEST_TIMEOUT_MS` (senza aspettare il backend), risposta avviata mai troncata (il timeout copre solo fino ai primi header), backend lento ma entro il timeout servito normalmente |
| File dati (`data-files.spec.js`) | handler che legge un file dati con `data()` servito al browser dall'immagine standalone: copre il ponte `FILES_DIR` + bind mount di `workspace/files`, invisibile ai test jest |
| Stato runtime condiviso (`shared-state.spec.js`) | frontend reale cross-origin: GET dal seed → POST arbitraria → GET arricchita → reset → GET iniziale; opt-in filtri/paginazione e `X-Total-Count`; conflitto `seedKey` sanitizzato nel mock ma diagnosticabile dal Monitor; contratto Admin JSON `{}`. I casi sono seriali su Chromium e ogni setup resetta esplicitamente la risorsa |
| Contenuti (`content.spec.js`) | risposta gzip del backend integra al browser, mock file-backed binario byte-per-byte (firma PNG verificata anche dal browser), flusso SSE proxato consegnato progressivamente (timestamp distanziati ⇒ niente buffering) |
| Hot reload (`dev-watch.spec.js`) | immagine di sviluppo: modifica di un mock sul filesystem host applicata a caldo dal watcher nel container (bind mount scrivibile + polling), con ripristino idempotente della fixture |
| Latenza (`delay.spec.js`) | ritardo globale sui mock senza `delayMs` proprio e, con `npm_config_delay_all`, sulle richieste proxate; contrasto senza ritardo (minimo su più tentativi, robusto alla contesa) |
| Discovery (`discovery.spec.js`) | nell'immagine standalone: `/info`, `/config`, `/runtime/status` e `/openapi.yaml` letti dal container e validati sugli schemi dello spec servito (non quello del checkout host); versione del checkout costruito e `runtimeId` coerente; workspace e listener interni al container; `/config` uguale alle impostazioni dichiarate nel compose, senza override; operazioni e campi usati dagli scenari agent/API presenti nello spec; con admin spenta `404` dal motore anche col proxy fallback, `403` su Host estraneo, rotte opache al browser cross-origin anche con CORS attivo |
| Stream durante i reload (`stream-reload.spec.js`) | immagine di sviluppo con watcher e admin, file modificati nel container: SSE e WS aperte dal browser sopravvivono a descrizione, variante inattiva ed endpoint estraneo cambiati via API e a una modifica estranea vista dal watcher, senza riconnessioni nascoste (identità in console, aperture ed errori di EventSource, copione non ripetuto, push ricevuto); il copione SSE o WS cambiato chiude solo la connessione interessata; una nuova definizione SSE illeggibile lascia servito lo stream precedente (`degraded`, `serving: retained`, console e push funzionanti); un handler dal sorgente rotto resta servito finché la correzione non rimuove l'errore, con la revisione `diagnostics` che avanza |
| Setup ripetibile (`agent-setup.spec.js`) | helper esterno (`tests/agent-setup.js`) che verifica contratto servito e workspace, dichiara via `PATCH /config` CORS e ritardi, prepara i contenuti con la revisione letta, poi attiva e azzera; stesso esito da tre stati (alternativa selezionata, sequence consumata, ritardi e CORS spento; endpoint disabilitati e Proxy All; setup ripetuto senza ripristino), con fetch reali dalla pagina nginx e traffico letto a pagine dal Monitor dopo un cursore `since=latest`, senza gap; variante con `select: false` che non cambia risposta, selezione né cursore della sequence; `409 REVISION_CONFLICT` fra due client sulla stessa revisione; gap `cleared` dopo un clear del Monitor; errori di setup con codice, senza mutazioni né attese cieche |
| Configurazione effimera (`runtime-config.spec.js`, `runtime-config-restart.spec.js`) | `PATCH /config` nell'immagine distribuita: un override cambia `GET /config`, la revisione `config` e la richiesta successiva del browser (CORS acceso, spento, esplicito, tolto); `backendUrl: null` disattiva il backend (501 `backend-unconfigured`), `unset` ripristina quello di avvio; una richiesta già entrata (riga `Request received.` nel log del container) e ancora nel ritardo resta sul backend vecchio, verificato col contatore del backend dopo il cambio, mentre la successiva va sul nuovo; un tunnel WebSocket aperto resta sul backend di origine; il riavvio porta un nuovo `runtimeId`, elimina gli override e fa segnalare `runtime_changed` al vecchio cursore del Monitor |
| Cattura e riproduzione (`capture-replay.spec.js`) | risposta reale del backend (status 202, body e header `x-receipt-id`) generata dal browser, trovata col cursore del Monitor e letta per ID e `runtimeId`; `create-mocks` con scelte esplicite (`onConflict`, nessuna attivazione) ed esiti per elemento verificati anche con 201; mock scritto fedele, senza header di trasporto; endpoint spento finché non lo si attiva, poi servito dal mock senza chiamare il backend (contatore); `add-variant` su un endpoint esistente: variante identificabile e inattiva, comportamento invariato fino alla selezione; cattura binaria → bozza `incomplete` con `INCOMPLETE_CAPTURE` e descrizione `[da completare]`, non attiva; risposta persa dopo una creazione completata (proxy di test che consegna la richiesta al motore e chiude la risposta) → errore senza ripetizione: una sola richiesta, un endpoint con una variante |
| Admin API (`admin-api.spec.js`) | catalogo servito dal container, guardia DNS-rebinding (403 su Host estraneo, mock non filtrati), vettore CSRF text/plain respinto con 415 senza creare nulla, risposte admin opache al JS cross-origin anche con CORS attivo |
| Cache preflight (`preflight-cache.spec.js`) | il caveat di docs/CORS.md reso osservabile: a CORS spento a metà corsa, un preflight in cache fa ancora PARTIRE la richiesta (il backend la riceve, la risposta è bloccata), un contesto browser fresco non la manda proprio — col contatore del backend come discriminante |

## Idee per i prossimi passi

Il backlog iniziale è completato. Gli scenari del pilotaggio da agent (motore 1.4.1) sono
tracciati in [CHECKLIST-ACCEPTANCE-v1.4.1.md](CHECKLIST-ACCEPTANCE-v1.4.1.md). Possibili
estensioni future:

- **Preflight fuori dal Monitor** — il traffico nel Monitor è coperto da `agent-setup`; resta da
  verificare dall'esterno che i preflight CORS automatici NON vi compaiano.
- **Limiti SameSite cross-site** — il caso documentato "site diversi su http" (cookie non
  inviati, token Authorization sì): richiede alias host distinti (es. `/etc/hosts` in CI).
