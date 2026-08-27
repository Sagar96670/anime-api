const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const DATA_DIR = path.join(__dirname, "data");
const CATALOG_FILE = path.join(DATA_DIR, "catalog.json");
// --------------------------------------------------
// AnimeSalt Catalog Sync
// --------------------------------------------------

const ANIMESALT_BASE_URL = "https://animesalt.cx";

async function syncAnimeSaltCatalog() {
  console.log("=================================");
  console.log("ANIMESALT CATALOG SYNC START");
  console.log(new Date().toISOString());
  console.log("=================================");

  const results = [];
  const seen = new Set();

  try {
    const firstUrl = `${ANIMESALT_BASE_URL}/series/`;

    const { data: firstHtml } = await axios.get(firstUrl, {
      timeout: 60000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/120.0.0.0 Safari/537.36",
      },
    });

    const $first = cheerio.load(firstHtml);

    let maxPage = 1;

    $first('a[href*="/series/page/"]').each((_, el) => {
      const href = $first(el).attr("href") || "";
      const match = href.match(/\/series\/page\/(\d+)\/?/i);

      if (match) {
        const page = Number(match[1]);
        if (Number.isFinite(page)) {
          maxPage = Math.max(maxPage, page);
        }
      }
    });

    console.log("ANIMESALT PAGES FOUND:", maxPage);

    async function parsePage(html, pageNumber) {
      const $ = cheerio.load(html);

      $("article.post").each((_, el) => {
        const title = $(el)
          .find("h2.entry-title")
          .first()
          .text()
          .replace(/\s+/g, " ")
          .trim();

        const href =
          $(el).find("a.lnk-blk").first().attr("href") || "";

        const image =
          $(el).find("img").first().attr("data-src") ||
          $(el).find("img").first().attr("src") ||
          "";

        if (!title || !href) return;

        let slug = "";

        try {
          const url = new URL(href);
          const parts = url.pathname.split("/").filter(Boolean);
          slug = parts[parts.length - 1] || "";
        } catch {
          return;
        }

        if (!slug || seen.has(slug)) return;

        seen.add(slug);

        results.push({
          slug,
          title,
          image: image.startsWith("//")
            ? `https:${image}`
            : image,
          link: href,
          source: "animesalt",
        });
      });

      console.log(
        `ANIMESALT PAGE ${pageNumber}: ${results.length} unique series`
      );
    }

    await parsePage(firstHtml, 1);

    for (let page = 2; page <= maxPage; page++) {
      const url = `${ANIMESALT_BASE_URL}/series/page/${page}/`;

      try {
        const { data: html } = await axios.get(url, {
          timeout: 60000,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
              "AppleWebKit/537.36 (KHTML, like Gecko) " +
              "Chrome/120.0.0.0 Safari/537.36",
          },
        });

        await parsePage(html, page);
      } catch (error) {
        console.error(
          `ANIMESALT PAGE ${page} ERROR:`,
          error.message
        );
      }
    }

    console.log("---------------------------------");
    console.log("ANIMESALT UNIQUE SERIES:", results.length);
    console.log("---------------------------------");

    return results;
  } catch (error) {
    console.error("ANIMESALT CATALOG ERROR:", error.message);
    return [];
  }
}

// --------------------------------------------------
// Automatic Background Sync
// --------------------------------------------------

const SYNC_INTERVAL = 30 * 60 * 1000; // 30 minutes

let syncRunning = false;

async function runBackgroundSync() {
  if (syncRunning) {
    console.log("SYNC ALREADY RUNNING - SKIP");
    return;
  }

  syncRunning = true;

  try {
    console.log("=================================");
    console.log("BACKGROUND AUTO SYNC - ANIMESALT");
    console.log(new Date().toISOString());
    console.log("=================================");

    const results = await syncAnimeSaltCatalog();

    const payload = {
      updatedAt: new Date().toISOString(),
      count: results.length,
      results
    };

    fs.mkdirSync(DATA_DIR, { recursive: true });

    fs.writeFileSync(
      CATALOG_FILE,
      JSON.stringify(payload, null, 2),
      "utf8"
    );

    console.log("---------------------------------");
    console.log("ANIMESALT AUTO SYNC COMPLETE");
    console.log("ANIMESALT LIVE:", results.length);
    console.log("CATALOG SAVED:", CATALOG_FILE);
    console.log("---------------------------------");
  } catch (error) {
    console.error(
      "BACKGROUND SYNC ERROR:",
      error.message
    );
  } finally {
    syncRunning = false;
  }
}

function startAutoSync() {
  console.log(
    `AUTO SYNC SCHEDULER: every ${SYNC_INTERVAL / 60000} minutes`
  );

  setInterval(runBackgroundSync, SYNC_INTERVAL);
}

module.exports = {
  syncAnimeSaltCatalog,
  runBackgroundSync,
  startAutoSync,
};
