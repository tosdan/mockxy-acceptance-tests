// Backend finto per i test esterni: simula uno staging reale dietro il proxy di Mockxy.
// Node puro, nessuna dipendenza. Le sue risposte sono volutamente "ostili" al viaggio
// attraverso un proxy locale: policy CORS di un'altra origin, Set-Cookie con attributi
// pensati per https/dominio proprio, redirect assoluti verso il proprio indirizzo.
// Sono esattamente le cose che Mockxy deve sovrascrivere/adattare/riscrivere.
const crypto = require("crypto");
const http = require("http");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 9000);
const OWN_ORIGIN = `http://backend:${PORT}`;
// Identità dell'istanza: lo stesso server gira come backend "a" e "b", per distinguere a quale
// backend Mockxy inoltra una richiesta o un tunnel WebSocket.
const BACKEND_ID = process.env.BACKEND_ID || "a";

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    // Policy CORS dello "staging": scritta per i SUOI frontend, non per il client dei test.
    // Se Mockxy (CORS attivo) non la sovrascrivesse, il browser bloccherebbe tutto.
    "access-control-allow-origin": "https://frontend-di-staging.example",
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

// Contatore delle POST /api/tracked: permette ai test di distinguere una richiesta
// bloccata dal browser PRIMA dell'invio (preflight fallito) da una inviata ma con
// risposta bloccata (preflight in cache): solo la seconda incrementa il contatore.
let trackedPostCount = 0;

// Arrivi per path sotto /identity/ e /capture/: dicono se, e quando, una richiesta ha raggiunto
// QUESTO backend (una richiesta ancora nel ritardo di Mockxy non è ancora arrivata; un mock
// attivo non chiama il backend).
const arrivals = new Map();
function countArrival(pathname) {
  const count = (arrivals.get(pathname) || 0) + 1;
  arrivals.set(pathname, count);
  return count;
}

// Primi byte di un PNG: un payload binario riconoscibile.
const BINARY_PAYLOAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, OWN_ORIGIN);
  const route = `${req.method} ${requestUrl.pathname}`;

  if (req.method === "GET" && requestUrl.pathname.startsWith("/identity/")) {
    countArrival(requestUrl.pathname);
    return sendJson(res, 200, { source: "backend", backend: BACKEND_ID, path: requestUrl.pathname });
  }

  // Risposta riconoscibile da catturare e riprodurre: status non banale, body con il numero
  // dell'arrivo su quel path e un header proprio, reso leggibile al JS cross-origin.
  if (req.method === "GET" && requestUrl.pathname.startsWith("/capture/receipt/")) {
    const receipt = `r-${countArrival(requestUrl.pathname)}`;
    return sendJson(res, 202, { source: "backend", receipt }, {
      "x-receipt-id": receipt,
      "access-control-expose-headers": "X-Receipt-Id",
    });
  }

  // Risposta binaria: il Monitor non la ricostruisce, la cattura è incompleta.
  if (req.method === "GET" && requestUrl.pathname.startsWith("/capture/binary/")) {
    countArrival(requestUrl.pathname);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "access-control-allow-origin": "https://frontend-di-staging.example",
    });
    return res.end(BINARY_PAYLOAD);
  }

  switch (route) {
    case "GET /api/arrivals": {
      const arrivalPath = requestUrl.searchParams.get("path") || "";
      return sendJson(res, 200, { backend: BACKEND_ID, path: arrivalPath, count: arrivals.get(arrivalPath) || 0 });
    }

    case "GET /api/ping":
      return sendJson(res, 200, { source: "backend", pong: true });

    case "POST /api/login":
      // Set-Cookie da staging: Domain/Secure/SameSite=None farebbero scartare il cookie
      // dal browser che parla con Mockxy su http. L'adattamento deve rimuoverli.
      return sendJson(res, 200, { source: "backend", loggedIn: true }, {
        "set-cookie":
          "session=backend-session-token; Domain=staging.example; Path=/; Secure; SameSite=None; HttpOnly",
      });

    case "GET /api/whoami":
      // Rimanda indietro il Cookie ricevuto: prova che il browser lo ha conservato e
      // che il proxy lo ha inoltrato.
      return sendJson(res, 200, {
        source: "backend",
        cookie: req.headers.cookie || null,
      });

    case "POST /api/echo-json": {
      const rawBody = await readBody(req);
      let parsedBody = null;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = rawBody;
      }
      return sendJson(res, 200, {
        source: "backend",
        received: parsedBody,
        contentType: req.headers["content-type"] || null,
        apiKey: req.headers["x-api-key"] || null,
      });
    }

    case "GET /api/redirect-absolute":
      // Location assoluta verso il PROPRIO indirizzo: dal browser dell'host non è nemmeno
      // risolvibile (rete interna di compose) — senza riscrittura il flusso muore qui.
      res.writeHead(302, { location: `${OWN_ORIGIN}/api/landing?from=redirect` });
      return res.end();

    case "GET /api/redirect-relative":
      res.writeHead(302, { location: "/api/landing" });
      return res.end();

    case "GET /api/redirect-third-party":
      // Host terzo (SSO, pagamenti...): NON va riscritto.
      res.writeHead(302, { location: "https://sso.example/authorize?client=mockxy" });
      return res.end();

    case "GET /api/landing":
      return sendJson(res, 200, {
        source: "backend",
        landed: true,
        from: requestUrl.searchParams.get("from"),
      });

    case "GET /api/slow": {
      // Aspetta PRIMA di mandare gli header: oltre il REQUEST_TIMEOUT_MS di Mockxy
      // deve produrre un 502 da timeout.
      const delayMs = Number(requestUrl.searchParams.get("ms") || 0);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return sendJson(res, 200, { source: "backend", sleptMs: delayMs });
    }

    case "POST /api/tracked":
      trackedPostCount += 1;
      return sendJson(res, 200, { source: "backend", tracked: trackedPostCount });

    case "GET /api/tracked-count":
      return sendJson(res, 200, { count: trackedPostCount });

    case "POST /api/tracked-reset":
      trackedPostCount = 0;
      return sendJson(res, 200, { count: trackedPostCount });

    case "GET /api/gzipped": {
      // Risposta compressa davvero: il proxy deve farla arrivare integra al browser.
      const compressed = zlib.gzipSync(JSON.stringify({ source: "backend", compressed: true }));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "access-control-allow-origin": "https://frontend-di-staging.example",
      });
      return res.end(compressed);
    }

    case "GET /api/sse": {
      // Stream di eventi SSE cadenzati: serve a verificare che il proxy consegni
      // PROGRESSIVAMENTE (niente buffering fino alla chiusura del backend).
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "access-control-allow-origin": "https://frontend-di-staging.example",
      });
      res.write("data: uno\n\n");
      await new Promise((resolve) => setTimeout(resolve, 700));
      res.write("data: due\n\n");
      await new Promise((resolve) => setTimeout(resolve, 700));
      res.write("data: tre\n\n");
      return res.end();
    }

    case "GET /api/slow-stream": {
      // Header e primo chunk SUBITO, chunk finale dopo il ritardo: il timeout del proxy
      // copre solo fino ai primi header, quindi questa risposta NON deve mai diventare 502
      // anche quando il ritardo supera REQUEST_TIMEOUT_MS.
      const delayMs = Number(requestUrl.searchParams.get("ms") || 0);
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"source":"backend","streamed":');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      res.write("true}");
      return res.end();
    }

    default:
      return sendJson(res, 404, { source: "backend", error: "not found", route });
  }
});

// --- Echo WebSocket senza dipendenze (RFC 6455, il minimo per i test) ---------------------
// Gestisce solo ciò che serve al passthrough: handshake, frame di testo non frammentati,
// ping/pong e close con eco del payload (così lo status code del client fa il giro completo).
// Niente frammentazione né payload > 64KB: i messaggi dei test sono piccoli.

const WS_HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function readWsFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }
  const opcode = buffer[0] & 0x0f;
  const isMasked = (buffer[1] & 0x80) !== 0;
  let payloadLength = buffer[1] & 0x7f;
  let headerLength = 2;
  if (payloadLength === 126) {
    if (buffer.length < 4) {
      return null;
    }
    payloadLength = buffer.readUInt16BE(2);
    headerLength = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) {
      return null;
    }
    payloadLength = Number(buffer.readBigUInt64BE(2));
    headerLength = 10;
  }
  const maskLength = isMasked ? 4 : 0;
  const frameLength = headerLength + maskLength + payloadLength;
  if (buffer.length < frameLength) {
    return null;
  }
  let payload = buffer.subarray(headerLength + maskLength, frameLength);
  if (isMasked) {
    const mask = buffer.subarray(headerLength, headerLength + 4);
    const unmasked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) {
      unmasked[i] = payload[i] ^ mask[i % 4];
    }
    payload = unmasked;
  }
  return { opcode, payload, frameLength };
}

function encodeWsFrame(opcode, payload) {
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeWsTextFrame(text) {
  return encodeWsFrame(0x1, Buffer.from(text, "utf8"));
}

server.on("upgrade", (req, socket) => {
  const requestUrl = new URL(req.url, OWN_ORIGIN);
  const key = req.headers["sec-websocket-key"];
  const identity = requestUrl.pathname === "/ws/identity";
  if ((requestUrl.pathname !== "/ws/echo" && !identity) || !key) {
    socket.destroy();
    return;
  }

  const accept = crypto.createHash("sha1").update(key + WS_HANDSHAKE_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  // Push iniziato dal server: prova che il tunnel funziona anche nel verso backend → client.
  // /ws/identity dichiara anche quale backend risponde, nel saluto e in ogni eco.
  socket.write(encodeWsTextFrame(identity ? `hello from backend ${BACKEND_ID}` : "hello from backend ws"));
  const echoPrefix = identity ? `echo from ${BACKEND_ID}: ` : "echo: ";

  let pending = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    let frame;
    while ((frame = readWsFrame(pending)) !== null) {
      pending = pending.subarray(frame.frameLength);
      if (frame.opcode === 0x8) {
        // Close: eco del payload (status code + reason) così il codice del client round-trippa.
        socket.write(encodeWsFrame(0x8, frame.payload));
        socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        socket.write(encodeWsFrame(0xa, frame.payload));
        continue;
      }
      if (frame.opcode === 0x1) {
        socket.write(encodeWsTextFrame(`${echoPrefix}${frame.payload.toString("utf8")}`));
      }
    }
  });
  socket.on("error", () => socket.destroy());
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`backend finto in ascolto su :${PORT}`);
});
