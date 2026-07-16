const { test, expect } = require("@playwright/test");
const stack = require("./stack");

// Il templating dei mock statici (templated: true) esercitato attraverso l'immagine
// standalone: ogni richiesta rende il template con i PROPRI valori — i test sono
// stateless e girano in parallelo su tutti i project.
test.describe("templating dei mock statici", () => {
  test("params, query, header e helper vengono risolti per richiesta", async ({ request }) => {
    const response = await request.get(`${stack.mockxyBaseUrl}/greet/42?lang=it`, {
      headers: { "x-client-tag": "collaudo-esterno" },
    });

    expect(response.status()).toBe(200);
    // Il templating copre anche gli header di risposta.
    expect(response.headers()["x-greeted-id"]).toBe("42");

    const body = await response.json();
    // Filtro dei tipi: l'intero valore è un placeholder con | number → numero nudo.
    expect(body.id).toBe(42);
    expect(body.nome).toBe("Utente 42");
    expect(body.lingua).toBe("it");
    expect(body.clientHeader).toBe("collaudo-esterno");
    // Helper now: un ISO 8601 recente, non la stringa placeholder.
    const requestedAt = Date.parse(body.richiestoAlle);
    expect(Number.isNaN(requestedAt)).toBe(false);
    expect(Math.abs(Date.now() - requestedAt)).toBeLessThan(60_000);
  });

  test("placeholder non risolto ed escape non rompono la risposta", async ({ request }) => {
    const response = await request.get(`${stack.mockxyBaseUrl}/greet/7`);

    expect(response.status()).toBe(200);
    const body = await response.json();
    // Sorgente mancante → stringa vuota (la risposta esce comunque, warning solo nel log).
    expect(body.campoInesistente).toBe("");
    // \{{ produce il letterale {{...}}, senza sostituzione.
    expect(body.letterale).toBe("{{non-sono-un-placeholder}}");
  });

  test("il filtro number su un valore non numerico produce null", async ({ request }) => {
    const response = await request.get(`${stack.mockxyBaseUrl}/greet/abc`);

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.id).toBe(null);
    expect(body.nome).toBe("Utente abc");
  });

  test("il body JSON della richiesta alimenta placeholder e filtro json", async ({ request }) => {
    const response = await request.post(`${stack.mockxyBaseUrl}/order-echo`, {
      data: {
        ordine: {
          codice: "ORD-77",
          quantita: "3",
          righe: [{ sku: "A1" }, { sku: "B2" }],
        },
      },
    });

    expect(response.status()).toBe(201);
    // Header di risposta templato dal body della richiesta.
    expect(response.headers()["location"]).toBe("/order-echo/ORD-77");

    const body = await response.json();
    expect(body.codice).toBe("ORD-77");
    expect(body.quantita).toBe(3);
    // | json rimette il sotto-albero della richiesta così com'è, non la sua stringa.
    expect(body.righe).toEqual([{ sku: "A1" }, { sku: "B2" }]);
    expect(body.ricevuto).toBe(true);
  });

  test("dal browser cross-origin il body templato arriva come a un client reale", async ({ page }) => {
    await page.goto("/");

    const result = await page.evaluate(
      (url) => window.callApi(url),
      `${stack.mockxyBaseUrl}/greet/9?lang=en`
    );

    expect(result.blocked).toBe(false);
    expect(result.status).toBe(200);
    expect(result.body.id).toBe(9);
    expect(result.body.lingua).toBe("en");
  });
});
