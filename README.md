# Test esterni black-box di Mockxy

Suite di test **di sistema** che esercita Mockxy dall'esterno, come lo vede un consumatore
reale: l'**immagine Docker standalone** (costruita da `../mockxy`, non una copia del
codice) nella topologia completa «browser → Mockxy → backend», con un **browser vero**
(Playwright/Chromium) come client.

## Perché esistono, e cosa NON sono

I test interni del progetto (jest, 400+) coprono la logica del motore a livello HTTP, ma tre
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
paginazione, CRUD dell'admin API…): sono una dozzina di scenari mirati alle tre classi sopra.
Quando un comportamento è testabile bene da jest, va testato lì.

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
                    mockxy-toggle (:8060) ─────┘  (CORS commutabile a runtime dal test
                                                   della cache dei preflight)
```

L'istanza principale espone anche l'**admin API** (`ADMIN_API_ENABLED=true` +
`ADMIN_ALLOWED_HOSTS=localhost`, che attiva la guardia DNS-rebinding sul bind di rete).

- Il **backend finto** (`backend/server.js`) è volutamente "ostile" al viaggio attraverso un
  proxy locale: policy CORS di un'altra origin, `Set-Cookie` con `Domain`/`Secure`/
  `SameSite=None`, redirect assoluti verso il proprio indirizzo interno. Sono esattamente le
  cose che Mockxy deve sovrascrivere, adattare e riscrivere.
- La **pagina client** (`client/index.html`) è il minimo indispensabile: un helper `callApi`
  che riporta esito, header leggibili e body — o `blocked: true` quando il browser rifiuta —
  più gli helper WebSocket/SSE usati dai test. Accanto ci sono due micro app autocontenute
  per le **prove manuali** a stack su: `http://localhost:8081/ws-tester.html` (connessione,
  transcript bidirezionale e composer verso i mock WebSocket) e
  `http://localhost:8081/sse-tester.html` (EventSource con eventi nominati e log degli
  eventi verso i mock SSE).
- I **mock di fixture** stanno in `workspace/mocks/` e arrivano al container via bind mount
  read-only, come nell'uso documentato dell'immagine standalone.

## Come si lancia

Prerequisiti: Docker Desktop attivo, Node ≥ 20.

```bash
npm install                       # solo la prima volta
npx playwright install chromium   # solo la prima volta
npm run stack:up                  # costruisce l'immagine e avvia i 4 container
npm test                          # esegue la suite Playwright
npm run stack:down                # spegne lo stack
```

Lo stack resta su tra un run e l'altro: in iterazione basta `npm test`. Se i container non
sono su, il setup globale fallisce subito con un messaggio esplicito. Per vedere il browser:
`npm run test:headed`. Log dei container: `npm run stack:logs`.

La suite gira su **tre motori browser** (Chromium, Firefox, WebKit): le semantiche sotto
test — CORS, cookie, preflight, SSE — sono proprio quelle che divergono tra i motori. I due
test stateful (hot reload, cache dei preflight) si autolimitano a Chromium perché mutano
stato condiviso mentre i project girano in parallelo. Per il primo run:
`npx playwright install chromium firefox webkit`. In CI c'è un retry automatico
(`retries: 1` solo con `CI` impostata); in locale la flakiness resta visibile.

**Nota di versioning**: la suite testa l'immagine costruita dal checkout corrente di
`../mockxy`. Dopo modifiche al motore serve `npm run stack:up` (ri-build) per testare la
versione nuova; annotare nei commit di questo repo contro quale commit del motore si è verde.

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
`mockxy`): a ogni push sul motore lancia questa suite (al suo `master`, o al ref
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
| Timeout (`timeouts.spec.js`) | 502 allo scadere di `REQUEST_TIMEOUT_MS` (senza aspettare il backend), risposta avviata mai troncata (il timeout copre solo fino ai primi header), backend lento ma entro il timeout servito normalmente |
| File dati (`data-files.spec.js`) | handler che legge un file dati con `data()` servito al browser dall'immagine standalone: copre il ponte `FILES_DIR` + bind mount di `workspace/files`, invisibile ai test jest |
| Contenuti (`content.spec.js`) | risposta gzip del backend integra al browser, mock file-backed binario byte-per-byte (firma PNG verificata anche dal browser), flusso SSE proxato consegnato progressivamente (timestamp distanziati ⇒ niente buffering) |
| Hot reload (`dev-watch.spec.js`) | immagine di sviluppo: modifica di un mock sul filesystem host applicata a caldo dal watcher nel container (bind mount scrivibile + polling), con ripristino idempotente della fixture |
| Latenza (`delay.spec.js`) | ritardo globale sui mock senza `delayMs` proprio e, con `npm_config_delay_all`, sulle richieste proxate; contrasto senza ritardo (minimo su più tentativi, robusto alla contesa) |
| Admin API (`admin-api.spec.js`) | catalogo servito dal container, guardia DNS-rebinding (403 su Host estraneo, mock non filtrati), vettore CSRF text/plain respinto con 415 senza creare nulla, risposte admin opache al JS cross-origin anche con CORS attivo |
| Cache preflight (`preflight-cache.spec.js`) | il caveat di docs/CORS.md reso osservabile: a CORS spento a metà corsa, un preflight in cache fa ancora PARTIRE la richiesta (il backend la riceve, la risposta è bloccata), un contesto browser fresco non la manda proprio — col contatore del backend come discriminante |

## Idee per i prossimi passi

Il backlog iniziale è completato. Possibili estensioni future:

- **Monitor via admin API** — con l'admin ora esposta sull'istanza principale: verificare
  che il traffico dei test compaia nel monitor (e che i preflight automatici NON compaiano).
- **Limiti SameSite cross-site** — il caso documentato "site diversi su http" (cookie non
  inviati, token Authorization sì): richiede alias host distinti (es. `/etc/hosts` in CI).
