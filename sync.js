const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const DATA_DIR = path.join(__dirname, "data");
const CATALOG_FILE = path.join(DATA_DIR, "catalog.json");

const TOONSTREAM_BASE_URL = "https://toonstream.vip";
const TOONSTREAM_CATEGORY_URL =
  `${TOONSTREAM_BASE_URL}/category/anime-series?type=all&page=`;

const TOONSTREAM_MOVIE_CATEGORY_URL =
  `${TOONSTREAM_BASE_URL}/category/anime-movies?type=all&page=`;

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

function absoluteUrl(href) {
  if (!href) return "";

  try {
    return new URL(href, TOONSTREAM_BASE_URL).href;
  } catch {
    return "";
  }
}

function getSlugFromUrl(href) {
  try {
    const url = new URL(href, TOONSTREAM_BASE_URL);
    const parts = url.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || "";
  } catch {
    return "";
  }
}

function parseSeriesPage(html, seen) {
  const $ = cheerio.load(html);
  const results = [];

  $('a.lnk-blk[href^="/series/"]').each((_, el) => {
    const link = $(el).attr("href");
    if (!link) return;

    const fullLink = absoluteUrl(link);
    const slug = getSlugFromUrl(fullLink);

    if (!slug || seen.has(slug)) return;

    const article = $(el).closest("article.post");

    const title = cleanText(
      article.find("h2.entry-title").first().text()
    );

    if (!title) return;

    const image =
      article.find(".post-thumbnail img").first().attr("src") || "";

    const ratingText = cleanText(
      article
        .find(".vote")
        .first()
        .text()
        .replace(/TMDB/i, "")
    );

    const ratingNumber = Number(ratingText);

    seen.add(slug);

    results.push({
      slug,
      title,
      image: absoluteUrl(image),
      link: fullLink,
      rating: Number.isFinite(ratingNumber)
        ? ratingNumber
        : null,
      source: "toonstream",
      type: "series",
    });
  });

  return results;
}

function parseMoviePage(html, seen) {
  const $ = cheerio.load(html);
  const results = [];

  $('a.lnk-blk[href^="/movies/"]').each((_, el) => {
    const link = $(el).attr("href");
    if (!link) return;

    const fullLink = absoluteUrl(link);
    const slug = getSlugFromUrl(fullLink);

    if (!slug || seen.has(slug)) return;

    const article = $(el).closest("article.post");

    const title = cleanText(
      article.find("h2.entry-title").first().text()
    );

    if (!title) return;

    const image =
      article.find(".post-thumbnail img").first().attr("src") || "";

    const ratingText = cleanText(
      article
        .find(".vote")
        .first()
        .text()
        .replace(/TMDB/i, "")
    );

    const ratingNumber = Number(ratingText);

    seen.add(slug);

    results.push({
      slug,
      title,
      image: absoluteUrl(image),
      link: fullLink,
      rating: Number.isFinite(ratingNumber)
        ? ratingNumber
        : null,
      source: "toonstream",
      type: "movie",
    });
  });

  return results;
}

function detectMaxPage(html) {
  const $ = cheerio.load(html);
  let maxPage = 1;

  $('a[href*="/category/anime-series?type=all&page="]').each(
    (_, el) => {
      const href = $(el).attr("href") || "";

      try {
        const url = new URL(href, TOONSTREAM_BASE_URL);
        const page = Number(url.searchParams.get("page"));

        if (Number.isInteger(page) && page > maxPage) {
          maxPage = page;
        }
      } catch {}
    }
  );

  return maxPage;
}

async function fetchCategoryPage(page) {
  const url = `${TOONSTREAM_CATEGORY_URL}${page}`;

  console.log(`[${page}] ${url}`);

  const response = await axios.get(url, {
    timeout: REQUEST_TIMEOUT,
    headers: REQUEST_HEADERS,
    maxRedirects: 5,
  });

  return String(response.data || "");
}

async function fetchMovieCategoryPage(page) {
  const url = `${TOONSTREAM_MOVIE_CATEGORY_URL}${page}`;
  console.log(`[MOVIE ${page}] ${url}`);

  const response = await axios.get(url, {
    timeout: REQUEST_TIMEOUT,
    headers: REQUEST_HEADERS,
    maxRedirects: 5,
  });

  return String(response.data || "");
}

async function syncToonStreamMovies() {
  console.log("=================================");
  console.log("TOONSTREAM MOVIE SYNC START");
  console.log(new Date().toISOString());
  console.log("=================================");

  try {
    const firstHtml = await fetchMovieCategoryPage(1);
    const maxPage = detectMovieMaxPage(firstHtml);

    console.log("---------------------------------");
    console.log("TOONSTREAM MOVIE CATEGORY PAGES:", maxPage);
    console.log("---------------------------------");

    const seen = new Set();
    const results = [];

    const firstResults = parseMoviePage(firstHtml, seen);
    results.push(...firstResults);

    console.log(
      `[MOVIE 1/${maxPage}] new movies: ${firstResults.length}`
    );

    for (let page = 2; page <= maxPage; page++) {
      try {
        const html = await fetchMovieCategoryPage(page);
        const pageResults = parseMoviePage(html, seen);

        results.push(...pageResults);

        console.log(
          `[MOVIE ${page}/${maxPage}] new movies: ${pageResults.length}`
        );
      } catch (error) {
        console.error(
          `[MOVIE ${page}/${maxPage}] PAGE ERROR:`,
          error.message
        );
      }
    }

    console.log("---------------------------------");
    console.log("TOONSTREAM MOVIES FOUND:", results.length);
    console.log("---------------------------------");

    return results;
  } catch (error) {
    console.error(
      "TOONSTREAM MOVIE SYNC ERROR:",
      error.message
    );
    return [];
  }
}

function detectMovieMaxPage(html) {
  const $ = cheerio.load(html);
  let maxPage = 1;

  $('a[href*="/category/anime-movies?type=all&page="]').each(
    (_, el) => {
      const href = $(el).attr("href") || "";

      try {
        const url = new URL(href, TOONSTREAM_BASE_URL);
        const page = Number(url.searchParams.get("page"));

        if (Number.isInteger(page) && page > maxPage) {
          maxPage = page;
        }
      } catch {}
    }
  );

  return maxPage;
}

async function syncToonStreamCatalog() {
  console.log("=================================");
  console.log("TOONSTREAM SERIES SYNC START");
  console.log(new Date().toISOString());
  console.log("=================================");

  try {
    const firstHtml = await fetchCategoryPage(1);

    const maxPage = detectMaxPage(firstHtml);

    console.log("---------------------------------");
    console.log("TOONSTREAM CATEGORY PAGES:", maxPage);
    console.log("---------------------------------");

    const seen = new Set();
    const results = [];

    const firstResults = parseSeriesPage(firstHtml, seen);

    results.push(...firstResults);

    console.log(
      `[1/${maxPage}] new series: ${firstResults.length}`
    );

    for (let page = 2; page <= maxPage; page++) {
      try {
        const html = await fetchCategoryPage(page);
        const pageResults = parseSeriesPage(html, seen);

        results.push(...pageResults);

        console.log(
          `[${page}/${maxPage}] new series: ${pageResults.length}`
        );
      } catch (error) {
        console.error(
          `[${page}/${maxPage}] PAGE ERROR:`,
          error.message
        );
      }
    }

    console.log("---------------------------------");
    console.log("TOONSTREAM SERIES FOUND:", results.length);
    console.log("---------------------------------");

    if (!results.length) {
      console.error(
        "TOONSTREAM ERROR: No public series cards found."
      );
      return [];
    }

    return results;
  } catch (error) {
    console.error(
      "TOONSTREAM CATALOG ERROR:",
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
  const seriesResults = await syncToonStreamCatalog();
  const movieResults = await syncToonStreamMovies();

  const results = [...seriesResults, ...movieResults];

  if (!results.length) {
    console.error(
      "TOONSTREAM AUTO SYNC ABORTED: empty catalog."
    );
    return [];
  }

  console.log("---------------------------------");
  console.log("TOONSTREAM SERIES:", seriesResults.length);
  console.log("TOONSTREAM MOVIES:", movieResults.length);
  console.log("TOONSTREAM TOTAL:", results.length);
  console.log("---------------------------------");

  await writeCatalog(results);

  console.log("---------------------------------");
  console.log("TOONSTREAM AUTO SYNC COMPLETE");
  console.log("---------------------------------");

  return results;
}

function startAutoSync() {
  const run = async () => {
    try {
      await runBackgroundSync();
    } catch (error) {
      console.error(
        "TOONSTREAM AUTO SYNC ERROR:",
        error.message
      );
    }
  };

  setInterval(run, 30 * 60 * 1000);

  console.log(
    "TOONSTREAM AUTO SYNC SCHEDULER: every 30 minutes"
  );
}

if (require.main === module) {
  runBackgroundSync()
    .then(() => {
      console.log(
        "TOONSTREAM SYNC PROCESS FINISHED"
      );
    })
    .catch((error) => {
      console.error(
        "TOONSTREAM SYNC FATAL ERROR:",
        error
      );
      process.exitCode = 1;
    });
}

module.exports = {
  TOONSTREAM_BASE_URL,
  TOONSTREAM_CATEGORY_URL,
  CATALOG_FILE,
  parseSeriesPage,
  parseMoviePage,
  syncToonStreamCatalog,
  syncToonStreamMovies,
  runBackgroundSync,
  startAutoSync,
  writeCatalog,
};
