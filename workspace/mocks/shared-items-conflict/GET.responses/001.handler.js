module.exports = {
  async resolveResponse({ sharedState }) {
    await sharedState.open("shared-items", {
      seedKey: "shared-items@v2",
      initialize: () => [],
    });
    return { status: 200, jsonBody: [] };
  },
};
