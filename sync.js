const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const DATA_DIR = path.join(__dirname, "data");
const CATALOG_FILE = path.join(DATA_DIR, "catalog.json");

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

const REQUEST_TIMEOUT = 60000;

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchAnimeSaltListPage(url) {
  const response = await axios.get(url, {
    headers: REQUEST_HEADERS,
    timeout: REQUEST_TIMEOUT,
  });

  return response.data;
}

function parseAnimeSaltSeriesListPage(html) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $("li.series, article.series, article.post.series").each((_, el) => {
    const card = $(el);

    const link =
      card.find('a[href*="/series/"]').first().attr("href") || "";

    if (!link) return;

    const fullLink = new URL(
      link,
      "https://animesalt.cx/"
    ).href;

    const slugMatch = fullLink.match(
      /\/series\/([^/?#]+)\/?$/
    );

    if (!slugMatch) return;

    const slug = slugMatch[1];

    if (seen.has(slug)) return;
    seen.add(slug);

    const title = cleanText(
      card.find("h2.entry-title, h3.entry-title").first().text() ||
      card.find(".entry-title").first().text()
    );

    const image =
      card.find("img").first().attr("data-src") ||
      card.find("img").first().attr("src") ||
      "";

    results.push({
      slug,
      title: title || slug,
      image: image
        ? new URL(image, "https://animesalt.cx/").href
        : "",
      link: fullLink,
      rating: null,
      source: "animesalt",
      type: "series",
    });
  });

  return results;
}

function parseAnimeSaltMovieListPage(html) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $("article.movies, article.post.movies, li.movie").each((_, el) => {
    const card = $(el);

    const link =
      card.find('a[href*="/movies/"]').first().attr("href") || "";

    if (!link) return;

    const fullLink = new URL(
      link,
      "https://animesalt.cx/"
    ).href;

    const slugMatch = fullLink.match(
      /\/movies\/([^/?#]+)\/?$/
    );

    if (!slugMatch) return;

    const slug = slugMatch[1];

    if (seen.has(slug)) return;
    seen.add(slug);

    const title = cleanText(
      card.find("h2.entry-title, h3.entry-title").first().text() ||
      card.find(".entry-title").first().text()
    );

    const image =
      card.find("img").first().attr("data-src") ||
      card.find("img").first().attr("src") ||
      "";

    results.push({
      slug,
      title: title || slug,
      image: image
        ? new URL(image, "https://animesalt.cx/").href
        : "",
      link: fullLink,
      rating: null,
      source: "animesalt",
      type: "movie",
    });
  });

  return results;
}

async function syncAnimeSaltCatalog() {
  console.log("=================================");
  console.log("ANIMESALT FULL CATALOG SYNC START");
  console.log(new Date().toISOString());
  console.log("=================================");

  const allSeries = [];
  const allMovies = [];

  try {
    for (let page = 1; page <= 38; page++) {
      const url =
        page === 1
          ? "https://animesalt.cx/series/"
          : `https://animesalt.cx/series/page/${page}/`;

      try {
        const html = await fetchAnimeSaltListPage(url);
        const results = parseAnimeSaltSeriesListPage(html);

        allSeries.push(...results);

        console.log(
          `ANIMESALT SERIES ${page}/38: ${results.length}`
        );
      } catch (error) {
        console.error(
          `ANIMESALT SERIES ${page}/38 ERROR:`,
          error.message
        );
      }
    }

    for (let page = 1; page <= 23; page++) {
      const url =
        page === 1
          ? "https://animesalt.cx/movies/"
          : `https://animesalt.cx/movies/page/${page}/`;

      try {
        const html = await fetchAnimeSaltListPage(url);
        const results = parseAnimeSaltMovieListPage(html);

        allMovies.push(...results);

        console.log(
          `ANIMESALT MOVIES ${page}/23: ${results.length}`
        );
      } catch (error) {
        console.error(
          `ANIMESALT MOVIES ${page}/23 ERROR:`,
          error.message
        );
      }
    }

    const unique = new Map();

    for (const item of [...allSeries, ...allMovies]) {
      const key = `${item.type}:${item.slug}`;

      if (!unique.has(key)) {
        unique.set(key, item);
      }
    }

    const results = [...unique.values()];

    console.log("---------------------------------");
    console.log("ANIMESALT SERIES:", allSeries.length);
    console.log("ANIMESALT MOVIES:", allMovies.length);
    console.log("ANIMESALT UNIQUE:", results.length);
    console.log("---------------------------------");

    if (!results.length) {
      console.error(
        "ANIMESALT ERROR: No catalog items found."
      );
      return [];
    }

    return results;
  } catch (error) {
    console.error(
      "ANIMESALT CATALOG ERROR:",
      error.message
    );

    return [];
  }
}

async function writeCatalog(results) {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const payload = {
    updatedAt: new Date().toISOString(),
    count: results.length,
    results,
  };

  fs.writeFileSync(
    CATALOG_FILE,
    JSON.stringify(payload, null, 2),
    "utf8"
  );

  console.log("CATALOG WRITTEN:", CATALOG_FILE);
  console.log("CATALOG COUNT:", results.length);

  return payload;
}

async function runBackgroundSync() {
  const results = await syncAnimeSaltCatalog();

  if (!results.length) {
    console.error(
      "ANIMESALT AUTO SYNC ABORTED: empty catalog."
    );
    return [];
  }

  const seriesCount = results.filter(
    (item) => item.type === "series"
  ).length;

  const movieCount = results.filter(
    (item) => item.type === "movie"
  ).length;

  console.log("---------------------------------");
  console.log("ANIMESALT SERIES:", seriesCount);
  console.log("ANIMESALT MOVIES:", movieCount);
  console.log("ANIMESALT TOTAL:", results.length);
  console.log("---------------------------------");

  await writeCatalog(results);

  console.log("---------------------------------");
  console.log("ANIMESALT AUTO SYNC COMPLETE");
  console.log("---------------------------------");

  return results;
}

function startAutoSync() {
  const run = async () => {
    try {
      await runBackgroundSync();
    } catch (error) {
      console.error(
        "ANIMESALT AUTO SYNC ERROR:",
        error.message
      );
    }
  };

  setInterval(run, 30 * 60 * 1000);

  console.log(
    "ANIMESALT AUTO SYNC SCHEDULER: every 30 minutes"
  );
}

if (require.main === module) {
  runBackgroundSync()
    .then(() => {
      console.log(
        "ANIMESALT SYNC PROCESS FINISHED"
      );
    })
    .catch((error) => {
      console.error(
        "ANIMESALT SYNC FATAL ERROR:",
        error
      );
      process.exitCode = 1;
    });
}

module.exports = {
  CATALOG_FILE,
  syncAnimeSaltCatalog,
  runBackgroundSync,
  startAutoSync,
  writeCatalog,
};
