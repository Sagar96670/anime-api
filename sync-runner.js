const { syncCatalog } = require("./sync");

(async () => {
  try {
    console.log("SYNC RUNNER START");

    const results = await syncCatalog();

    console.log(`SYNC RUNNER COMPLETE: ${results.length} anime`);
    process.exit(0);
  } catch (error) {
    console.error("SYNC RUNNER ERROR:", error.message);
    process.exit(1);
  }
})();
