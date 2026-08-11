const fs = require("fs");
const path = require("path");
const express = require("express");
const cron = require("node-cron");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const BASE_URL = "https://1xanimes.com";
const PORT = process.env.PORT || 5000;
cron.schedule("*/30 * * * *", () => {
  const { spawn } = require("child_process");

  console.log("AUTO SYNC: starting separate sync process");

  const child = spawn(
    process.execPath,
    ["sync-runner.js"],
    {
      cwd: __dirname,
      detached: false,
      stdio: "inherit"
    }
  );

  child.on("error", (error) => {
    console.error("AUTO SYNC PROCESS ERROR:", error.message);
  });

  child.on("exit", (code) => {
    console.log(`AUTO SYNC PROCESS EXIT: ${code}`);
  });
});

const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/120.0.0.0 Safari/537.36",
};

const client = axios.create({
  baseURL: BASE_URL,
  headers,
  timeout: 15000,
  maxRedirects: 5,
});

const streamCache = new Map();

const { startAutoSync } = require("./sync");
const STREAM_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// --------------------------------------------------
// Home
// --------------------------------------------------
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});
// --------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "online",
    timestamp: new Date().toISOString(),
  });
});

// --------------------------------------------------
// Home Anime List
// --------------------------------------------------

app.get("/api/home", async (req, res) => {
  try {
    const catalogFile = path.join(__dirname, "data", "catalog.json");

    if (!fs.existsSync(catalogFile)) {
      return res.status(404).json({
        success: false,
        message: "Catalog not found",
      });
    }

    const catalog = JSON.parse(
      fs.readFileSync(catalogFile, "utf8")
    );

    const results = Array.isArray(catalog.results)
      ? catalog.results
      : [];

    res.json({
      success: true,
      count: results.length,
      results,
    });

  } catch (error) {
    console.error("HOME ERROR:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to load local catalog",
    });
  }
});


// --------------------------------------------------
// Watch Stats
// --------------------------------------------------

const watchStatsFile = path.join(
  __dirname,
  "data",
  "watch-stats.json"
);

function readWatchStats() {
  try {
    if (!fs.existsSync(watchStatsFile)) {
      return {};
    }

    const data = JSON.parse(
      fs.readFileSync(watchStatsFile, "utf8")
    );

    return data && typeof data === "object"
      ? data
      : {};

  } catch (error) {
    console.error(
      "WATCH STATS READ ERROR:",
      error.message
    );

    return {};
  }
}

function writeWatchStats(stats) {
  fs.writeFileSync(
    watchStatsFile,
    JSON.stringify(stats, null, 2),
    "utf8"
  );
}

/*
 * Watch anti-spam:
 * Same anonymous visitor + same episode
 * is counted only once during the cooldown.
 */
const watchCooldown = new Map();

const WATCH_COOLDOWN_MS = 30 * 60 * 1000;

function canCountWatch(visitorId, slug, season, episode) {

  const key =
    String(visitorId || "anonymous") +
    "|" +
    String(slug || "") +
    "|S" +
    String(season || "") +
    "E" +
    String(episode || "");

  const now = Date.now();
  const previous = watchCooldown.get(key) || 0;

  if(now - previous < WATCH_COOLDOWN_MS){
    return false;
  }

  watchCooldown.set(key, now);

  return true;
}

app.post("/api/watch", (req, res) => {
  try {

    const slug = String(
      req.body?.slug || ""
    ).trim();

    const season = String(
      req.body?.season || ""
    ).trim();

    const episode = String(
      req.body?.episode || ""
    ).trim();

    const visitorId = String(
      req.body?.visitorId || "anonymous"
    ).trim();

    if (!slug) {
      return res.status(400).json({
        success: false,
        message: "Anime slug required"
      });
    }

    const stats = readWatchStats();

    const countThisWatch =
      canCountWatch(
        visitorId,
        slug,
        season,
        episode
      );

    if (!stats[slug]) {
      stats[slug] = {
        views: 0,
        episodes: {},
        lastWatchedAt: null
      };
    }

    if(countThisWatch){

      stats[slug].views =
        Number(stats[slug].views || 0) + 1;

      if (season && episode) {

        const key =
          "S" + season + "E" + episode;

        stats[slug].episodes[key] =
          Number(stats[slug].episodes[key] || 0) + 1;
      }

      stats[slug].lastWatchedAt =
        new Date().toISOString();
    }

    if (!countThisWatch && !stats[slug].lastWatchedAt) {
      stats[slug].lastWatchedAt =
        new Date().toISOString();
    }

    /* Prevent duplicate episode increment below. */
    if (false && season && episode) {

      const key =
        "S" + season + "E" + episode;

      stats[slug].episodes[key] =
        Number(stats[slug].episodes[key] || 0) + 1;
    }

    writeWatchStats(stats);

    res.json({
      success: true,
      slug,
      views: stats[slug].views,
      counted: countThisWatch
    });

  } catch (error) {

    console.error(
      "WATCH API ERROR:",
      error.message
    );

    res.status(500).json({
      success: false,
      message: "Unable to save watch"
    });
  }
});

app.get("/api/trending", (req, res) => {
  try {

    const stats = readWatchStats();
    const now = Date.now();

    const results = Object.entries(stats)
      .map(([slug, item]) => {

        const views =
          Number(item.views || 0);

        const lastWatched =
          Date.parse(item.lastWatchedAt || "");

        const hoursSinceWatch =
          lastWatched &&
          !Number.isNaN(lastWatched)
            ? Math.max(
                0,
                (now - lastWatched) / 3600000
              )
            : 9999;

        /*
         * Recent activity.
         * Fresh watches get a strong boost.
         * The boost slowly fades with time.
         */

        const recentScore =
          Math.max(
            0,
            100 - hoursSinceWatch * 4
          );

        /*
         * Popularity.
         * Prevent extremely high view counts
         * from completely dominating the list.
         */

        const viewScore =
          Math.min(
            200,
            views * 10
          );

        /*
         * Episode diversity.
         * Watching different episodes is a
         * small positive signal.
         */

        const episodeCount =
          item.episodes &&
          typeof item.episodes === "object"
            ? Object.keys(item.episodes).length
            : 0;

        const episodeScore =
          Math.min(
            30,
            episodeCount * 5
          );

        /*
         * Final Smart Watch Score v2.
         */

        const trendingScore =
          viewScore +
          recentScore +
          episodeScore;

        return {
          slug,
          views,
          episodeCount,
          lastWatchedAt:
            item.lastWatchedAt || null,
          trendingScore
        };

      })
      .sort((a, b) => {

        if(
          b.trendingScore !==
          a.trendingScore
        ){
          return (
            b.trendingScore -
            a.trendingScore
          );
        }

        return b.views - a.views;

      })
      .slice(0, 20);

    res.json({
      success: true,
      results
    });

  } catch (error) {

    console.error(
      "TRENDING API ERROR:",
      error.message
    );

    res.status(500).json({
      success: false,
      message: "Unable to load trending"
    });

  }
});

// --------------------------------------------------
// Search
// --------------------------------------------------

// --------------------------------------------------
// Search
// --------------------------------------------------

app.get("/api/search", async (req, res) => {
  const query = String(req.query.q || "").trim();

  if (!query) {
    return res.status(400).json({
      success: false,
      message: "Query required",
    });
  }

  try {
    const { data } = await client.get("/wp-json/wp/v2/search", {
      params: {
        search: query,
        per_page: 20,
      },
    });

    const results = await Promise.all(
      data.map(async (item) => {
        let image = "";

        try {
          const page = await client.get(new URL(item.url).pathname);
          const $ = cheerio.load(page.data);

          image =
            $("img")
              .map((i, el) => $(el).attr("src") || "")
              .get()
              .find((src) => src.includes("image.tmdb.org")) || "";
        } catch (imageError) {
          console.error(
            "IMAGE ERROR:",
            item.title,
            imageError.message
          );
        }

        return {
          title: item.title,
          image,
          link: item.url,
        };
      })
    );

    res.json({
      success: true,
      query,
      count: results.length,
      results,
    });
  } catch (error) {
    console.error("SEARCH ERROR:", error.message);

    res.status(500).json({
      success: false,
      message: "Search failed",
    });
  }
});

// --------------------------------------------------
// Anime Details

// --------------------------------------------------

app.get("/api/anime/:slug", async (req, res) => {
  try {
    const slug = req.params.slug;

    const { data } = await client.get(`/${slug}/`);
    const $ = cheerio.load(data);

    const title =
      $(".post-title").first().text().trim() ||
      $(".entry-title").first().text().trim() ||
      $("h1").first().text().trim() ||
      $("title").text().trim();

    const description =
      $(".description").first().text().trim() ||
      $(".entry-content p").first().text().trim() ||
      $('meta[name="description"]').attr("content") ||
      "";

    const image =
      $("img").map((i, el) => $(el).attr("src") || "").get()
        .find(src => src.includes("image.tmdb.org")) ||
      $("img").first().attr("src") ||
      $('meta[property="og:image"]').attr("content") ||
      "";

    const servers = await scrapeEpisodeServers(slug);

    res.json({
      success: true,
      anime: {
        slug,
        title,
        description,
        image,
        servers,
      },
    });
  } catch (error) {
    console.error("ANIME ERROR:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to load anime",
    });
  }
});

// --------------------------------------------------
// Decode Base64 player URL
// --------------------------------------------------

function decodeBase64Url(value) {
  if (!value) return null;

  try {
    const decoded = Buffer
      .from(value, "base64")
      .toString("utf8")
      .trim();

    if (
      decoded.startsWith("http://") ||
      decoded.startsWith("https://")
    ) {
      return decoded;
    }

    return null;
  } catch {
    return null;
  }
}

// --------------------------------------------------
// Extract v28D from page
// --------------------------------------------------

async function scrapeEpisodeServers(slug) {
  const { data } = await client.get(`/${slug}/`);
  const $ = cheerio.load(data);

  let v28D = null;

  $("script").each((_, el) => {
    const text = $(el).html() || "";

    const match = text.match(
      /var\s+v28D\s*=\s*(\[[\s\S]*?\]);/
    );

    if (match) {
      try {
        v28D = JSON.parse(match[1]);
      } catch (error) {
        console.error("v28D JSON ERROR:", error.message);
      }
    }
  });

  if (!Array.isArray(v28D)) {
    return [];
  }

  return v28D.map((server) => ({
    name: server.name || "Unknown Server",
    type: server.type || "series",

    episodes: (server.episodes || []).map((ep) => ({
      episode: Number(ep.num),
      season: Number(ep.s),
      type: "iframe",
      url: decodeBase64Url(ep.url),
    })),
  }));
}


// --------------------------------------------------
// Episode Update Detection
// --------------------------------------------------

function getEpisodeCount(servers){

  if(!Array.isArray(servers)){
    return 0;
  }

  const seen = new Set();

  for(const server of servers){

    for(const ep of (server.episodes || [])){

      if(
        ep &&
        ep.season != null &&
        ep.episode != null
      ){
        seen.add(
          String(ep.season) + "-" +
          String(ep.episode)
        );
      }

    }

  }

  return seen.size;
}


function updateEpisodeMetadata(slug, servers){

  if(!slug || !Array.isArray(servers)){
    return;
  }

  const catalogFile =
    path.join(__dirname, "data", "catalog.json");

  try{

    if(!fs.existsSync(catalogFile)){
      return;
    }

    const catalog =
      JSON.parse(
        fs.readFileSync(catalogFile, "utf8")
      );

    if(!Array.isArray(catalog.results)){
      return;
    }

    const item =
      catalog.results.find(
        anime => anime && anime.slug === slug
      );

    if(!item){
      return;
    }

    const count = getEpisodeCount(servers);

    if(!count){
      return;
    }

    const previous =
      Number(item.latestEpisodeCount || 0);

    // First stream scan: establish baseline only.
    if(!previous){

      item.latestEpisodeCount = count;

      fs.writeFileSync(
        catalogFile,
        JSON.stringify(catalog, null, 2),
        "utf8"
      );

      console.log(
        `EPISODE BASELINE: ${slug} = ${count}`
      );

      return;
    }

    // Only mark as updated when episode count increases.
    if(count > previous){

      item.latestEpisodeCount = count;
      item.episodeUpdatedAt =
        new Date().toISOString();

      fs.writeFileSync(
        catalogFile,
        JSON.stringify(catalog, null, 2),
        "utf8"
      );

      console.log(
        `NEW EPISODES: ${slug} ${previous} -> ${count}`
      );

    }

  }catch(error){

    console.error(
      "EPISODE METADATA ERROR:",
      error.message
    );

  }

}


// --------------------------------------------------
// Automatic Servers + Episodes
// --------------------------------------------------

app.get("/api/streams/:slug", async (req, res) => {
  try {
    const slug = req.params.slug;

    if (streamCache.has(slug)) {
      const cached = streamCache.get(slug);

      if (Date.now() - cached.updatedAt < STREAM_CACHE_TTL) {
        return res.json({
          success: true,
          animeSlug: slug,
          cached: true,
          servers: cached.servers,
        });
      }

      console.log(`STREAM CACHE EXPIRED: ${slug}`);
      streamCache.delete(slug);
    }

    const servers = await scrapeEpisodeServers(slug);

    updateEpisodeMetadata(slug, servers);

    if (!servers.length) {
      return res.status(404).json({
        success: false,
        message: "No authorized player sources found",
        animeSlug: slug,
      });
    }

    streamCache.set(slug, {
      updatedAt: Date.now(),
      servers,
    });

    res.json({
      success: true,
      animeSlug: slug,
      cached: false,
      serverCount: servers.length,
      servers,
    });
  } catch (error) {
    console.error("STREAM ERROR:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to load player sources",
      error: error.message,
    });
  }
});

// --------------------------------------------------
// Clear stream cache
// --------------------------------------------------

app.delete("/api/cache/:slug", (req, res) => {
  const slug = req.params.slug;

  const deleted = streamCache.delete(slug);

  res.json({
    success: true,
    deleted,
    animeSlug: slug,
  });
});

// --------------------------------------------------
// 404
// --------------------------------------------------

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Endpoint not found",
  });
});

// --------------------------------------------------
// Start
// --------------------------------------------------

startAutoSync();

app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});

