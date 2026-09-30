module.exports = {
  async resolveResponse() {
    return { status: 200, jsonBody: { version: 1 } };
  },
};
