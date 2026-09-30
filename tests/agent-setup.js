const YAML = require("yaml");
const { adminUrl } = require("./admin-client");

// Helper di setup esplicito via admin API, come lo userebbe un agente dall'esterno (piano
// agent/API, §13 C1, C4, C5, C6 e C8): identifica istanza e workspace, dichiara la configurazione
// runtime da cui dipende la prova, prepara i contenuti con la revisione letta, poi attiva e azzera.
// Non ripristina niente e non ritenta le scritture: ogni problema diventa un SetupError con un
// codice diagnostico. Le chiamate passano dal client HTTP di Playwright, mai dal browser.

// Tutte le operazioni del contratto servito che il setup e le sue verifiche usano, controllate
// prima di qualunque mutazione: un'operazione mancante non va scoperta a modifiche iniziate, né
// tramite scritture di prova. Chi aggiunge una chiamata all'helper la aggiunge qui.
const REQUIRED_OPERATIONS = [
  ["get", "/info"],
  ["patch", "/config"],
  ["get", "/mocks"],
  ["get", "/mocks/{id}"],
  ["put", "/mocks/{id}"],
  ["patch", "/mocks/enabled"],
  ["post", "/mocks/{id}/responses"],
  ["get", "/mocks/{id}/responses/{responseFileName}"],
  ["put", "/mocks/{id}/responses/{responseFileName}"],
  ["delete", "/mocks/{id}/responses/{responseFileName}"],
  ["get", "/mocks/{id}/sequence/state"],
  ["post", "/mocks/{id}/sequence/reset"],
  ["patch", "/server"],
  ["get", "/monitoring/requests"],
];

class SetupError extends Error {
  constructor(code, message, details = undefined) {
    super(`[${code}] ${message}`);
    this.name = "SetupError";
    this.code = code;
    this.details = details;
  }
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function parseBody(response) {
  const text = await response.text();
  if (text === "") {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

class AgentSetup {
  constructor(request, baseUrl) {
    this.request = request;
    this.baseUrl = baseUrl;
    this.runtimeId = null;
  }

  async call(method, route, data, { timeout } = {}) {
    const response = await this.request.fetch(adminUrl(this.baseUrl, route), { method, data, timeout });
    return { status: response.status(), ok: response.ok(), data: await parseBody(response) };
  }

  async read(route, what, options) {
    const res = await this.call("GET", route, undefined, options);
    if (!res.ok) {
      throw new SetupError("READ_FAILED", `${what}: ${res.status} — ${res.data?.message ?? JSON.stringify(res.data)}`, res.data?.details);
    }
    return res.data;
  }

  // Una mutazione riuscita è la barriera di applicazione: 2xx vuol dire file scritti e runtime
  // che serve l'effetto. Qualunque altro esito ferma il setup con il codice del server.
  async mutate(method, route, data, what, expectedStatus = 200) {
    const res = await this.call(method, route, data);
    if (res.status === expectedStatus) {
      return res.data;
    }
    const code = res.data?.details?.code;
    if (code === "REVISION_CONFLICT") {
      throw new SetupError("PRECONDITION_FAILED", `${what}: the resource changed since it was read; read it again and decide, do not overwrite.`, res.data.details);
    }
    throw new SetupError("NOT_APPLIED", `${what}: ${res.status}${code ? ` ${code}` : ""} — ${res.data?.message ?? JSON.stringify(res.data)}`, res.data?.details);
  }

  /**
   * 1. Contratto, identità e workspace dell'istanza, prima di qualunque mutazione. `mocksDir` è
   * la cartella dei mock che la prova si aspetta, come la riporta /info.
   */
  async connect({ mocksDir }) {
    const info = await this.call("GET", "/info");
    if (!info.ok || typeof info.data?.runtimeId !== "string") {
      throw new SetupError("CONTRACT_UNVERIFIABLE", `GET /info answered ${info.status}: nothing is changed.`);
    }
    const spec = await this.call("GET", "/openapi.yaml");
    if (!spec.ok || typeof spec.data !== "string") {
      throw new SetupError("CONTRACT_UNVERIFIABLE", `GET /openapi.yaml answered ${spec.status}: nothing is changed.`);
    }
    const paths = YAML.parse(spec.data)?.paths ?? {};
    const missing = REQUIRED_OPERATIONS.filter(([method, route]) => paths[route]?.[method] == null);
    if (missing.length > 0) {
      throw new SetupError("CONTRACT_UNVERIFIABLE", `Mockxy ${info.data.version} does not declare ${missing.map(([method, route]) => `${method.toUpperCase()} ${route}`).join(", ")}.`);
    }
    if (info.data.workspace?.mocksDir !== mocksDir) {
      throw new SetupError("WRONG_WORKSPACE", `The runtime serves ${info.data.workspace?.mocksDir}, not ${mocksDir}: refusing to change another workspace.`, { workspace: info.data.workspace });
    }
    this.runtimeId = info.data.runtimeId;
    return info.data;
  }

  /** 2. Configurazione runtime da cui dipende la prova, dichiarata e riletta come effettiva. */
  async declareConfig(settings) {
    const state = await this.mutate("PATCH", "/config", { set: settings }, "Declaring the runtime configuration");
    const mismatches = Object.entries(settings).filter(([key, value]) => !sameValue(state?.effective?.[key], value));
    if (mismatches.length > 0) {
      throw new SetupError("NOT_APPLIED", `Runtime configuration not applied: ${mismatches.map(([key]) => key).join(", ")}.`, { effective: state?.effective });
    }
    if (state.runtimeId !== this.runtimeId) {
      throw new SetupError("RUNTIME_CHANGED", `The runtime restarted during the setup (${this.runtimeId} → ${state.runtimeId}).`);
    }
    return state;
  }

  /** Un endpoint per metodo e path esatti, dal catalogo: mai per titolo né dalla selezione. */
  async findEndpoint(method, routePath) {
    const { items } = await this.read("/mocks", "Reading the catalog");
    const matches = items.filter((item) => item.method === method && item.path === routePath);
    if (matches.length !== 1) {
      throw new SetupError("RESOURCE_NOT_FOUND", `Expected exactly one ${method} ${routePath} in the catalog, found ${matches.length}.`);
    }
    return matches[0];
  }

  /** Le varianti su cui il setup lavora devono essere elencate dall'endpoint, per filename. */
  async requireVariants(endpointId, fileNames) {
    const detail = await this.read(`/mocks/${endpointId}`, "Reading the endpoint");
    const listed = new Set(detail.endpoint?.responseFiles ?? []);
    const missing = fileNames.filter((file) => !listed.has(file));
    if (missing.length > 0) {
      throw new SetupError("RESOURCE_NOT_FOUND", `${detail.method} ${detail.path} does not list ${missing.join(", ")}.`);
    }
    return detail;
  }

  readVariant(endpointId, fileName) {
    return this.read(`/mocks/${endpointId}/responses/${fileName}`, `Reading ${fileName}`);
  }

  /** Scrive una variante con la revisione letta: un 409 ferma il setup, nessuna sovrascrittura. */
  writeVariant(endpointId, fileName, content, revision) {
    return this.mutate("PUT", `/mocks/${endpointId}/responses/${fileName}`, { ...content, expectedRevision: revision }, `Updating ${fileName}`);
  }

  /**
   * 3. Prepara il contenuto di una variante esistente con la revisione appena letta. Riscrivere
   * una variante attiva (la selezionata o uno step della sequence selezionata) cambia lo scenario
   * in corso: va dichiarato con `allowActive`, quando il setup la riattiva e azzera subito dopo.
   */
  async prepareVariant(endpointId, fileName, content, { allowActive = false } = {}) {
    const variant = await this.readVariant(endpointId, fileName);
    if (variant.active && !allowActive) {
      throw new SetupError("ACTIVE_VARIANT", `${fileName} is being served (selected or a step of the selected sequence): prepare a separate variant.`);
    }
    return this.writeVariant(endpointId, fileName, content, variant.revision);
  }

  /** Crea una variante nuova senza attivarla e la rilegge per filename: deve risultare inattiva. */
  async createInactiveVariant(endpointId, content) {
    const created = await this.mutate("POST", `/mocks/${endpointId}/responses`, { ...content, select: false }, "Preparing an inactive variant", 201);
    const fileName = created?.createdResponseFile;
    if (typeof fileName !== "string") {
      throw new SetupError("NOT_APPLIED", "The created variant has no createdResponseFile.", created);
    }
    const variant = await this.readVariant(endpointId, fileName);
    if (variant.selected || variant.active) {
      throw new SetupError("NOT_APPLIED", `${fileName} was prepared with select: false but is ${variant.selected ? "selected" : "active"}.`);
    }
    return variant;
  }

  /** 4. Modalità mock: server acceso e Proxy All spento. */
  async serveMocks() {
    const state = await this.mutate("PATCH", "/server", { serverEnabled: true, proxyAll: false }, "Enabling mock mode");
    if (state?.serverEnabled !== true || state?.proxyAll !== false) {
      throw new SetupError("NOT_APPLIED", `Mock mode not applied: ${JSON.stringify(state)}.`);
    }
  }

  select(endpointId, fileName) {
    return this.mutate("PUT", `/mocks/${endpointId}`, { selectedResponseFile: fileName }, `Selecting ${fileName}`);
  }

  setEnabled(endpointIds, enabled) {
    return this.mutate("PATCH", "/mocks/enabled", { ids: endpointIds, enabled }, `${enabled ? "Enabling" : "Disabling"} endpoints`);
  }

  /** 5. La sequence riparte dal primo step anche se era già selezionata. */
  async resetSequence(endpointId) {
    const result = await this.mutate("POST", `/mocks/${endpointId}/sequence/reset`, {}, "Resetting the sequence");
    if (result?.sequenceState?.stepIndex !== 0 || result?.sequenceState?.servedInStep !== 0) {
      throw new SetupError("NOT_APPLIED", `The sequence did not restart from its first step: ${JSON.stringify(result?.sequenceState)}.`);
    }
    return result;
  }

  /** 6. Cursore del Monitor su "adesso", da prendere prima dell'azione del browser. */
  async monitorCursor(filters = {}) {
    const query = new URLSearchParams({ view: "page", since: "latest", ...filters });
    const page = await this.read(`/monitoring/requests?${query}`, "Reading the monitor cursor");
    if (page.cursor.runtimeId !== this.runtimeId) {
      throw new SetupError("RUNTIME_CHANGED", `The runtime restarted during the setup (${this.runtimeId} → ${page.cursor.runtimeId}).`);
    }
    return page.cursor;
  }

  /**
   * Il traffico successivo al cursore, con gli stessi filtri, finché `until(items)` è vero o
   * scade `timeoutMs`. Ogni pagina riusa runtimeId, generation e since del cursore precedente. Un
   * gap (riavvio, clear, espulsione) ferma la verifica: una lista vuota non vorrebbe dire nulla.
   * La scadenza vale per tutta l'attesa e limita anche ogni singola richiesta.
   */
  async readTraffic(cursor, filters = {}, { until = () => true, timeoutMs = 5000, intervalMs = 100, limit = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const items = [];
    const pages = [];
    const timedOut = () =>
      new SetupError("TRAFFIC_TIMEOUT", `The expected traffic did not show up within ${timeoutMs} ms after the cursor; seen: ${items.map((item) => `${item.method} ${item.path} ${item.status}`).join(", ") || "nothing"}.`, { pages: pages.length });
    let current = cursor;
    for (;;) {
      let hasMore = true;
      while (hasMore) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw timedOut();
        }
        const query = new URLSearchParams({
          view: "page",
          limit: String(limit),
          ...filters,
          since: current.since,
          runtimeId: current.runtimeId,
          generation: String(current.generation),
        });
        let page;
        try {
          page = await this.read(`/monitoring/requests?${query}`, "Reading the monitor", { timeout: remaining });
        } catch (error) {
          // La richiesta interrotta dalla scadenza è un timeout; ogni altro errore resta com'è.
          if (!(error instanceof SetupError) && Date.now() >= deadline) throw timedOut();
          throw error;
        }
        pages.push({ gap: page.gap, count: page.items.length, hasMore: page.hasMore });
        if (page.gap) {
          throw new SetupError("MONITOR_GAP", `Monitor traffic was lost since the cursor (${page.gapReason}): the check cannot conclude.`, { gapReason: page.gapReason, available: page.available });
        }
        items.push(...page.items);
        current = page.cursor;
        hasMore = page.hasMore;
      }
      if (until(items)) {
        return { items, pages, cursor: current };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw timedOut();
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
    }
  }
}

module.exports = { AgentSetup, SetupError, REQUIRED_OPERATIONS };
