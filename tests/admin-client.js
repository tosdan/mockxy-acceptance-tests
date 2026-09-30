const Ajv2020 = require("ajv/dist/2020");
const YAML = require("yaml");
const { expect } = require("@playwright/test");

// Client amministrativo dei test: le chiamate all'admin API partono dal client HTTP di
// Playwright (Node), mai dal browser, che per costruzione non può leggerle cross-origin.
// Lo spec si scarica sempre dal container sotto test: il checkout host non compensa un file
// assente o diverso nell'immagine.

const ADMIN_PREFIX = "/_admin/api";

function adminUrl(baseUrl, route) {
  return `${baseUrl}${ADMIN_PREFIX}${route}`;
}

/** GET su una rotta admin che deve rispondere 200 JSON; il messaggio d'errore porta il body. */
async function adminJson(request, baseUrl, route) {
  const response = await request.get(adminUrl(baseUrl, route));
  expect(response.status(), `GET ${route}: ${await response.text()}`).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  return response.json();
}

/** Lo spec OpenAPI servito dal motore in esecuzione, già interpretato. */
async function fetchServedSpec(request, baseUrl) {
  const response = await request.get(adminUrl(baseUrl, "/openapi.yaml"));
  expect(response.status(), "GET /openapi.yaml").toBe(200);
  expect(response.headers()["content-type"]).toContain("application/yaml");
  return YAML.parse(await response.text());
}

/** Validatore di uno schema dei components dello spec servito (stesse opzioni dei test del motore). */
function schemaValidator(spec, schemaName) {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema({ $id: "served-admin-openapi", components: spec.components });
  const validate = ajv.compile({ $ref: `served-admin-openapi#/components/schemas/${schemaName}` });
  return (value) => {
    const valid = validate(value);
    return { valid, errors: valid ? [] : validate.errors };
  };
}

function resolveRef(spec, node) {
  if (node == null || typeof node.$ref !== "string") {
    return node;
  }
  return node.$ref
    .replace(/^#\//, "")
    .split("/")
    .reduce((current, key) => current?.[key], spec);
}

/** Nomi delle proprietà di primo livello di un corpo JSON, attraversando $ref e allOf. */
function requestBodyProperties(spec, operation) {
  const body = resolveRef(spec, operation.requestBody);
  const names = new Set();
  const visit = (schema) => {
    const resolved = resolveRef(spec, schema);
    if (resolved == null) {
      return;
    }
    Object.keys(resolved.properties ?? {}).forEach((name) => names.add(name));
    (resolved.allOf ?? []).forEach(visit);
  };
  visit(body?.content?.["application/json"]?.schema);
  return [...names];
}

module.exports = {
  ADMIN_PREFIX,
  adminUrl,
  adminJson,
  fetchServedSpec,
  schemaValidator,
  resolveRef,
  requestBodyProperties,
};
