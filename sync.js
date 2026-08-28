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
// AnimeSalt Movie Catalog Sync
// --------------------------------------------------

async function syncAnimeSaltMovies() {
  console.log("=================================");
  console.log("ANIMESALT MOVIE SYNC START");
  console.log(new Date().toISOString());
  console.log("=================================");

  const results = [];
  const seen = new Set();

  try {
    const firstUrl = `${ANIMESALT_BASE_URL}/movies/`;

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

    $first('a[href*="/movies/page/"]').each((_, el) => {
      const href = $first(el).attr("href") || "";
      const match = href.match(/\/movies\/page\/(\d+)\/?/i);

      if (match) {
        const page = Number(match[1]);
        if (Number.isFinite(page)) {
          maxPage = Math.max(maxPage, page);
        }
      }
    });

    console.log("ANIMESALT MOVIE PAGES FOUND:", maxPage);

    function parseMoviePage(html, pageNumber) {
      const $ = cheerio.load(html);

      $("article.post.movies").each((_, el) => {
        const title = $(el)
          .find("h2.entry-title")
          .first()
          .text()
          .replace(/\s+/g, " ")
          .trim();

        const href =
          $(el).find("a.lnk-blk").first().attr("href") ||
          $(el).find("a").first().attr("href") ||
          "";

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
          type: "movie"
        });
      });

      console.log(
        `ANIMESALT MOVIE PAGE ${pageNumber}: ${results.length} unique movies`
      );
    }

    parseMoviePage(firstHtml, 1);

    for (let page = 2; page <= maxPage; page++) {
      const url = `${ANIMESALT_BASE_URL}/movies/page/${page}/`;

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

        parseMoviePage(html, page);
      } catch (error) {
        console.error(
          `ANIMESALT MOVIE PAGE ${page} ERROR:`,
          error.message
        );
      }
    }

    console.log("---------------------------------");
    console.log("ANIMESALT UNIQUE MOVIES:", results.length);
    console.log("---------------------------------");

    return results;
  } catch (error) {
    console.error("ANIMESALT MOVIE CATALOG ERROR:", error.message);
    return [];
  }
}

// --------------------------------------------------
// AnimeSalt Episode Count Checker
// --------------------------------------------------

async function getAnimeSaltEpisodeCount(slug) {
  if (!slug) return 0;

  try {
    const seriesUrl = `${ANIMESALT_BASE_URL}/series/${slug}/`;

    const { data: html } = await axios.get(seriesUrl, {
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/120.0.0.0 Safari/537.36",
      },
    });

    const $ = cheerio.load(html);

    const seasons = [];

    $('a.season-btn[data-season][data-post]').each((_, el) => {
      const season = Number($(el).attr("data-season"));
      const post = String($(el).attr("data-post") || "").trim();

      if (Number.isFinite(season) && post) {
        seasons.push({ season, post });
      }
    });

    const uniqueSeasons = [
      ...new Map(seasons.map(x => [x.season, x])).values()
    ];

    if (!uniqueSeasons.length) {
      return 0;
    }

    const episodeKeys = new Set();

    for (const { season, post } of uniqueSeasons) {
      try {
        const ajaxUrl =
          `${ANIMESALT_BASE_URL}/wp-admin/admin-ajax.php` +
          `?action=action_select_season&season=${season}&post=${post}`;

        const { data: seasonHtml } = await axios.get(ajaxUrl, {
          timeout: 15000,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
              "AppleWebKit/537.36 (KHTML, like Gecko) " +
              "Chrome/120.0.0.0 Safari/537.36",
            "Referer": seriesUrl,
            "X-Requested-With": "XMLHttpRequest"
          }
        });

        const $$ = cheerio.load(seasonHtml);

        $$('a[href]').each((_, el) => {
          const href = $$(el).attr("href") || "";

          const match = href.match(
            /\/episode\/[^/]+-(\d+)x(\d+)\/?$/i
          );

          if (!match) return;

          const epSeason = Number(match[1]);
          const episode = Number(match[2]);

          if (
            Number.isFinite(epSeason) &&
            Number.isFinite(episode) &&
            epSeason === season
          ) {
            episodeKeys.add(
              `${epSeason}-${episode}`
            );
          }
        });

      } catch (error) {
        console.log(
          `EPISODE COUNT SEASON ERROR [${slug} S${season}]:`,
          error.message
        );
      }
    }

    return episodeKeys.size;

  } catch (error) {
    console.log(
      `EPISODE COUNT ERROR [${slug}]:`,
      error.message
    );

    return 0;
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

    const seriesResults = await syncAnimeSaltCatalog();
    const movieResults = await syncAnimeSaltMovies();

    const results = [...seriesResults, ...movieResults];

    // Preserve catalog history so Recently Updated / New Releases
    // continue working across automatic syncs.
    let oldCatalog = {
      results: []
    };

    try {
      if (fs.existsSync(CATALOG_FILE)) {
        oldCatalog = JSON.parse(
          fs.readFileSync(CATALOG_FILE, "utf8")
        );
      }
    } catch (error) {
      console.log(
        "OLD CATALOG READ ERROR:",
        error.message
      );
    }

    const oldItems = Array.isArray(oldCatalog.results)
      ? oldCatalog.results
      : [];

    const oldBySlug = new Map();

    for (const item of oldItems) {
      const key = String(item?.slug || "").trim().toLowerCase();

      if (key) {
        oldBySlug.set(key, item);
      }
    }

    const now = new Date().toISOString();

    const mergedResults = results.map(item => {
      const key = String(item?.slug || "").trim().toLowerCase();
      const old = oldBySlug.get(key);

      return {
        ...old,
        ...item,

        firstSeenAt:
          old?.firstSeenAt ||
          now,

        lastSeenAt:
          old?.lastSeenAt ||
          null
      };
    });

    // --------------------------------------------------
    // Detect newly added episodes
    // --------------------------------------------------

    let checked = 0;
    let changed = 0;

    for (const item of mergedResults) {

      // Movies do not have episode updates.
      if (
        !item ||
        item.type === "movie" ||
        !item.slug
      ) {
        continue;
      }

      try {
        const count =
          await getAnimeSaltEpisodeCount(item.slug);

        if (!count) {
          continue;
        }

        const previous =
          Number(item.latestEpisodeCount || 0);

        // First scan establishes the baseline only.
        if (!previous) {
          item.latestEpisodeCount = count;

          console.log(
            `EPISODE BASELINE: ${item.slug} = ${count}`
          );
        }

        // New episode detected.
        else if (count > previous) {
          item.latestEpisodeCount = count;
          item.episodeUpdatedAt = now;
          item.lastSeenAt = now;

          changed++;

          console.log(
            `NEW EPISODES: ${item.slug} ${previous} -> ${count}`
          );

          console.log(
            `RECENTLY UPDATED: ${item.slug} -> ${now}`
          );
        }

        checked++;

      } catch (error) {
        console.log(
          `EPISODE CHECK FAILED [${item.slug}]:`,
          error.message
        );
      }
    }

    console.log(
      `EPISODE UPDATE CHECK COMPLETE: ${checked} checked, ${changed} updated`
    );

    const payload = {
      updatedAt: now,
      count: mergedResults.length,
      results: mergedResults
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
  syncAnimeSaltMovies,
  runBackgroundSync,
  startAutoSync,
};
