const axios = require("axios");
const fs = require("fs");
const path = require("path");
const DATA_DIR = path.join(__dirname, "data");
const CATALOG_FILE = path.join(DATA_DIR, "catalog.json");
const cheerio = require("cheerio");

const BASE_URL = "https://1xanimes.com";

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  maxRedirects: 5,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/120.0.0.0 Safari/537.36",
  },
});
function saveCatalog(results) {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let oldResults = [];

  try {
    if (fs.existsSync(CATALOG_FILE)) {
      const oldData = JSON.parse(
        fs.readFileSync(CATALOG_FILE, "utf8")
      );

      oldResults = Array.isArray(oldData.results)
        ? oldData.results
        : [];
    }
  } catch (error) {
    console.log("OLD CATALOG READ WARNING:", error.message);
  }

  const oldBySlug = new Map(
    oldResults
      .filter(item => item && item.slug)
      .map(item => [item.slug, item])
  );

  const now = new Date().toISOString();

  const enrichedResults = results.map(item => {

    const old = oldBySlug.get(item.slug);

    return {
      ...item,
      firstSeenAt: old?.firstSeenAt || now,
      lastSeenAt: now,
    };
  });

  const payload = {
    updatedAt: now,
    count: enrichedResults.length,
    results: enrichedResults,
  };

  fs.writeFileSync(
    CATALOG_FILE,
    JSON.stringify(payload, null, 2),
    "utf8"
  );

  console.log("Catalog saved:", CATALOG_FILE);
}

async function getAnimeRating(url) {
  try {
    const { data } = await client.get(url);
    const $ = cheerio.load(data);

    const metaText = $(".nf-meta-row")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();

    const match = metaText.match(/★\s*(\d+(?:\.\d+)?)/);

    return match ? match[1] : "";
  } catch (error) {
    console.error(
      "RATING ERROR:",
      url,
      error.message
    );
    return "";
  }
}

async function scrapeHomePage(page = 1) {
  const url = page === 1 ? "/" : `/page/${page}/`;

  const { data } = await client.get(url);
  const $ = cheerio.load(data);

  const results = [];
  const seen = new Set();

  $('a[href*="/anime/"], a[href*="/series/"], .post-title a, article a')
    .each((_, el) => {
      let link = $(el).attr("href") || "";

      const title =
        $(el).text().trim() ||
        $(el).attr("title") ||
        $(el).find("img").attr("alt") ||
        "";

      const image =
        $(el).find("img").attr("src") ||
        $(el).find("img").attr("data-src") ||
        "";

      if (!link || !title || title.length < 3) return;

      if (link.startsWith("/")) {
        link = BASE_URL + link;
      }

      if (!link.startsWith(BASE_URL + "/")) return;

      let path;

      try {
        path = new URL(link).pathname;
      } catch {
        return;
      }

      if (
        path.startsWith("/category/") ||
        path.startsWith("/page/") ||
        path === "/a-to-z-navigation/" ||
        path.includes("/wp-")
      ) {
        return;
      }

      const slug = path.replace(/^\/|\/$/g, "");

      if (!slug || seen.has(slug)) return;

      seen.add(slug);

      results.push({
        slug,
        title: title.replace(/\s+/g, " ").trim(),
        image,
        link,
      });
    });
 return results;
}

async function discoverPages(maxPages = 17) {
  const pages = [];

  for (let page = 1; page <= maxPages; page++) {
    try {
      const url = page === 1 ? "/" : `/page/${page}/`;

      const response = await client.get(url);

      if (response.status >= 200 && response.status < 400) {
        pages.push(page);
      }
    } catch (error) {
      console.log(`Page ${page} unavailable`);
    }
  }

  return pages;
}

async function syncCatalog() {
  console.log("=================================");
  console.log("AUTO SYNC START");
  console.log(new Date().toISOString());
  console.log("=================================");

  const pages = await discoverPages();

  console.log("Pages discovered:", pages.join(", "));

  const all = new Map();

  for (const page of pages) {
    try {
      const items = await scrapeHomePage(page);

      console.log(
        `Page ${page}: ${items.length} anime candidates`
      );

      for (const item of items) {
        if (!all.has(item.slug)) {
          const rating = await getAnimeRating(item.link);

          all.set(item.slug, {
            ...item,
            rating,
          });
        }
      }
    } catch (error) {
      console.error(
        `Page ${page} failed:`,
        error.message
      );
    }
  }

  const results = [...all.values()];

  console.log("---------------------------------");
  console.log("TOTAL UNIQUE ANIME:", results.length);
  console.log("---------------------------------");
  saveCatalog(results);

  return results;
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
    console.log("BACKGROUND AUTO SYNC");
    console.log(new Date().toISOString());
    console.log("=================================");

    const results = await syncCatalog();

    console.log(
      `BACKGROUND SYNC COMPLETE: ${results.length} anime`
    );

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
  syncCatalog,
  startAutoSync,
  getAnimeRating,
};
