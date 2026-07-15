// Handler minimale che referenzia un file dati del workspace: è la riga `await data(...)`
// sotto test — se il ponte verso workspace/files è rotto, l'esecuzione fallisce con 500.
module.exports = {
  async resolveResponse({ data }) {
    const mydata = await data("mydata");
    return { status: 200, jsonBody: mydata };
  },
};
