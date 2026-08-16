function openItems({ sharedState, data }) {
  return sharedState.open("shared-items", {
    seedKey: "shared-items@v1",
    initialize: () => data("shared-items"),
  });
}

module.exports = {
  async resolveResponse(context) {
    const items = await openItems(context);
    return {
      status: 200,
      jsonBody: items.read(),
      applyListQuery: true,
    };
  },
};
