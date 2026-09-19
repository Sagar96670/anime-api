const { syncAnimeSaltCatalog } = require("./sync");
const fs = require("fs");
const path = require("path");

(async () => {
  try {
    console.log("SYNC RUNNER START");
    console.log("ANIMESALT SYNC START");

    const results = await syncAnimeSaltCatalog();

    if (!results.length) {
      throw new Error("AnimeSalt sync returned an empty catalog");
    }

    const catalogFile = path.join(
      __dirname,
      "data",
      "catalog.json"
    );

    const payload = {
      updatedAt: new Date().toISOString(),
      count: results.length,
      results
    };

    fs.mkdirSync(
      path.dirname(catalogFile),
      { recursive: true }
    );

    fs.writeFileSync(
      catalogFile,
      JSON.stringify(payload, null, 2),
      "utf8"
    );

    console.log("---------------------------------");
    console.log("ANIMESALT SYNC COMPLETE");
    console.log("ANIMESALT LIVE:", results.length);
    console.log("FINAL CATALOG:", results.length);
    console.log("CATALOG SAVED:", catalogFile);
    console.log("---------------------------------");

    process.exit(0);
  } catch (error) {
    console.error(
      "ANIMESALT SYNC ERROR:",
      error.message
    );
    process.exit(1);
  }
})();
