const crypto = require("node:crypto");

function openItems({ sharedState, data }) {
  return sharedState.open("shared-items", {
    seedKey: "shared-items@v1",
    initialize: () => data("shared-items"),
  });
}

module.exports = {
  async resolveResponse(context) {
    if (context.jsonBody == null || typeof context.jsonBody !== "object" || Array.isArray(context.jsonBody)) {
      return { status: 400, jsonBody: { error: "item_must_be_an_object" } };
    }

    const items = await openItems(context);
    const created = items.mutate((draft) => {
      if (!Array.isArray(draft)) {
        throw new Error("shared-items must contain an array");
      }
      const item = {
        ...context.jsonBody,
        id: context.jsonBody.id ?? crypto.randomUUID(),
      };
      draft.push(item);
      return item;
    });
    return { status: 201, jsonBody: created };
  },
};
