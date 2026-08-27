require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const cron = require("node-cron");
const axios = require("axios");
const https = require("https");
const cheerio = require("cheerio");
const cors = require("cors");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 5000;
const BASE_URL = "https://1xanimes.com";
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



// --------------------------------------------------
// ADMIN PANEL
// --------------------------------------------------

const adminSessions = new Map();

function adminPasswordValid(password) {
  const actual = String(process.env.ADMIN_PASSWORD || "");
  const supplied = String(password || "");

  if (!actual || !supplied) return false;

  const a = Buffer.from(actual);
  const b = Buffer.from(supplied);

  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  const token = req.headers.cookie
    ?.split(";")
    .map(x => x.trim())
    .find(x => x.startsWith("anime_admin="))
    ?.split("=")[1];

  if (!token || !adminSessions.has(token)) {
    return res.status(401).json({
      success: false,
      message: "Admin login required"
    });
  }

  next();
}

app.post("/admin/api/login", (req, res) => {
  const password = req.body?.password;

  if (!adminPasswordValid(password)) {
    return res.status(401).json({
      success: false,
      message: "Invalid password"
    });
  }

  const token = crypto.randomBytes(32).toString("hex");

  adminSessions.set(token, {
    createdAt: Date.now()
  });

  res.setHeader(
    "Set-Cookie",
    `anime_admin=${token}; HttpOnly; SameSite=Strict; Path=/`
  );

  res.json({
    success: true
  });
});


// --------------------------------------------------
// ADMIN PASSWORD RECOVERY
// --------------------------------------------------

const recoveryFile = path.join(
  __dirname,
  "data",
  "admin-recovery.json"
);

function readRecoveryData(){
  try{
    if(!fs.existsSync(recoveryFile)) return null;

    return JSON.parse(
      fs.readFileSync(recoveryFile, "utf8")
    );
  }catch{
    return null;
  }
}

function writeRecoveryData(data){
  fs.mkdirSync(
    path.dirname(recoveryFile),
    { recursive: true }
  );

  fs.writeFileSync(
    recoveryFile,
    JSON.stringify(data, null, 2),
    {
      encoding: "utf8",
      mode: 0o600
    }
  );
}

function clearRecoveryData(){
  try{
    if(fs.existsSync(recoveryFile)){
      fs.unlinkSync(recoveryFile);
    }
  }catch(error){
    console.error(
      "RECOVERY FILE CLEANUP ERROR:",
      error.message
    );
  }
}

async function sendRecoveryEmail(to, otp){

  const apiKey =
    String(process.env.RESEND_API_KEY || "").trim();

  if(!apiKey){
    throw new Error("RESEND_API_KEY is not configured");
  }

  const response = await axios.post(
    "https://api.resend.com/emails",
    {
      from: "AnimeVerse <onboarding@resend.dev>",
      to: [to],
      subject: "AnimeVerse Admin Password Recovery",
      text:
        `Your AnimeVerse admin password recovery OTP is: ${otp}\n\n` +
        "This OTP expires in 10 minutes.\n" +
        "If you did not request this, ignore this email."
    },
    {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      timeout: 15000
    }
  );

  return response.data;
}

app.post("/admin/api/forgot-password", async (req, res) => {
  try{
    const recoveryEmail =
      String(process.env.RECOVERY_GMAIL || "").trim();

    if(!recoveryEmail){
      return res.status(500).json({
        success:false,
        message:"Recovery Gmail is not configured"
      });
    }

    const otp =
      String(crypto.randomInt(100000, 1000000));

    const otpHash =
      crypto
        .createHash("sha256")
        .update(otp)
        .digest("hex");

    writeRecoveryData({
      otpHash,
      expiresAt: Date.now() + 10 * 60 * 1000,
      attempts: 0
    });

    await sendRecoveryEmail(recoveryEmail, otp);

    res.json({
      success:true,
      message:"Recovery OTP sent to Gmail"
    });

  }catch(error){

    console.error(
      "PASSWORD RECOVERY EMAIL ERROR:",
      error.name,
      error.code || "",
      error.responseCode || "",
      error.command || "",
      error.message
    );

    res.status(500).json({
      success:false,
      message:"Failed to send recovery OTP"
    });
  }
});

app.post("/admin/api/reset-password", (req, res) => {
  try{
    const otp =
      String(req.body?.otp || "").trim();

    const newPassword =
      String(req.body?.newPassword || "");

    const recoveryData =
      readRecoveryData();

    if(!recoveryData){
      return res.status(400).json({
        success:false,
        message:"Recovery OTP not requested"
      });
    }

    if(Date.now() > recoveryData.expiresAt){
      clearRecoveryData();

      return res.status(400).json({
        success:false,
        message:"OTP expired"
      });
    }

    if(!/^\d{6}$/.test(otp)){
      return res.status(400).json({
        success:false,
        message:"Invalid OTP"
      });
    }

    recoveryData.attempts =
      Number(recoveryData.attempts || 0) + 1;

    if(recoveryData.attempts > 5){
      clearRecoveryData();

      return res.status(400).json({
        success:false,
        message:"Too many invalid OTP attempts"
      });
    }

    writeRecoveryData(recoveryData);

    const otpHash =
      crypto
        .createHash("sha256")
        .update(otp)
        .digest("hex");

    const expected =
      Buffer.from(recoveryData.otpHash);

    const supplied =
      Buffer.from(otpHash);

    if(
      expected.length !== supplied.length ||
      !crypto.timingSafeEqual(expected, supplied)
    ){
      return res.status(400).json({
        success:false,
        message:"Invalid OTP"
      });
    }

    if(newPassword.length < 7){
      return res.status(400).json({
        success:false,
        message:"Password must be at least 7 characters"
      });
    }

    process.env.ADMIN_PASSWORD = newPassword;

    clearRecoveryData();

    adminSessions.clear();

    res.json({
      success:true,
      message:
        "Admin password changed successfully. Restart server before login."
    });

  }catch(error){

    console.error(
      "PASSWORD RESET ERROR:",
      error.message
    );

    res.status(500).json({
      success:false,
      message:"Failed to reset password"
    });
  }
});

app.post("/admin/api/logout", requireAdmin, (req, res) => {
  const token = req.headers.cookie
    ?.split(";")
    .map(x => x.trim())
    .find(x => x.startsWith("anime_admin="))
    ?.split("=")[1];

  if (token) adminSessions.delete(token);

  res.setHeader(
    "Set-Cookie",
    "anime_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
  );

  res.json({
    success: true
  });
});

app.get("/api/settings", (req, res) => {
  try {
    const settingsFile = path.join(
      __dirname,
      "data",
      "site-settings.json"
    );

    if (!fs.existsSync(settingsFile)) {
      return res.status(404).json({
        success: false,
        message: "Settings file not found"
      });
    }

    const settings = JSON.parse(
      fs.readFileSync(settingsFile, "utf-8")
    );

    res.json({
      success: true,
      settings: {
        telegramLink:
          String(settings.telegramLink || ""),

        ads: {
          enabled:
            Boolean(settings.ads?.enabled),

          provider:
            String(settings.ads?.provider || "")
        }
      }
    });

  } catch (error) {
    console.error(
      "PUBLIC SETTINGS READ ERROR:",
      error.message
    );

    res.status(500).json({
      success: false,
      message: "Failed to read settings"
    });
  }
});

app.get("/admin/api/settings", requireAdmin, (req, res) => {
  try {
    const settingsFile = path.join(
      __dirname,
      "data",
      "site-settings.json"
    );

    if (!fs.existsSync(settingsFile)) {
      return res.status(404).json({
        success: false,
        message: "Settings file not found"
      });
    }

    const settings = JSON.parse(
      fs.readFileSync(settingsFile, "utf-8")
    );

    res.json({
      success: true,
      settings: {
        telegramLink:
          String(settings.telegramLink || "")
      }
    });

  } catch (error) {
    console.error("ADMIN SETTINGS READ ERROR:", error.message);

    res.status(500).json({
      success: false,
      message: "Failed to read settings"
    });
  }
});

app.post("/admin/api/settings", requireAdmin, (req, res) => {
  try {
    const settingsFile = path.join(
      __dirname,
      "data",
      "site-settings.json"
    );

    let telegramLink =
      String(req.body?.telegramLink || "").trim();

    if (!telegramLink) {
      return res.status(400).json({
        success: false,
        message: "Telegram link is required"
      });
    }

    if (!/^https:\/\/t\.me\/[A-Za-z0-9_]+\/?$/.test(telegramLink)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Telegram link"
      });
    }

    const settings = {
      telegramLink
    };

    fs.writeFileSync(
      settingsFile,
      JSON.stringify(settings, null, 2),
      "utf-8"
    );

    res.json({
      success: true,
      message: "Telegram link saved",
      settings
    });

  } catch (error) {
    console.error("ADMIN SETTINGS SAVE ERROR:", error.message);

    res.status(500).json({
      success: false,
      message: "Failed to save settings"
    });
  }
});


// --------------------------------------------------
// ADMIN AD MANAGEMENT
// --------------------------------------------------

app.get("/admin/api/ads", requireAdmin, (req, res) => {
  try {
    const settingsFile = path.join(
      __dirname,
      "data",
      "site-settings.json"
    );

    const settings = fs.existsSync(settingsFile)
      ? JSON.parse(fs.readFileSync(settingsFile, "utf8"))
      : {};

    res.json({
      success: true,
      ads: {
        enabled: Boolean(settings.ads?.enabled),
        provider: String(settings.ads?.provider || ""),
        homeCode: String(settings.ads?.homeCode || ""),
        animeCode: String(settings.ads?.animeCode || ""),
        episodeCode: String(settings.ads?.episodeCode || ""),
        verificationCode: String(settings.ads?.verificationCode || "")
      }
    });

  } catch (error) {
    console.error("ADMIN ADS READ ERROR:", error.message);

    res.status(500).json({
      success: false,
      message: "Failed to read ad settings"
    });
  }
});


app.post("/admin/api/ads", requireAdmin, (req, res) => {
  try {
    const settingsFile = path.join(
      __dirname,
      "data",
      "site-settings.json"
    );

    const settings = fs.existsSync(settingsFile)
      ? JSON.parse(fs.readFileSync(settingsFile, "utf8"))
      : {};

    const enabled =
      Boolean(req.body?.enabled);

    const provider =
      String(req.body?.provider || "").trim();

    const homeCode =
      String(req.body?.homeCode || "");

    const animeCode =
      String(req.body?.animeCode || "");

    const episodeCode =
      String(req.body?.episodeCode || "");

    const verificationCode =
      String(req.body?.verificationCode || "");

    settings.ads = {
      enabled,
      provider,
      homeCode,
      animeCode,
      episodeCode,
      verificationCode
    };

    fs.writeFileSync(
      settingsFile,
      JSON.stringify(settings, null, 2),
      {
        encoding: "utf8",
        mode: 0o600
      }
    );

    res.json({
      success: true,
      message: "Ad settings saved",
      ads: settings.ads
    });

  } catch (error) {
    console.error("ADMIN ADS SAVE ERROR:", error.message);

    res.status(500).json({
      success: false,
      message: "Failed to save ad settings"
    });
  }
});

app.get("/admin/api/anime", requireAdmin, (req, res) => {
  try {
    const catalogFile = path.join(
      __dirname,
      "data",
      "catalog.json"
    );

    if (!fs.existsSync(catalogFile)) {
      return res.status(404).json({
        success: false,
        message: "Catalog not found"
      });
    }

    const catalog = JSON.parse(
      fs.readFileSync(catalogFile, "utf-8")
    );

    const items = Array.isArray(catalog.results)
      ? catalog.results
      : [];

    res.json({
      success: true,
      count: items.length,
      results: items
    });

  } catch (error) {
    console.error("ADMIN ANIME API ERROR:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.post("/admin/api/sync", requireAdmin, async (req, res) => {
  try {
    const { syncAnimeSaltCatalog } = require("./sync");
    const results = await syncAnimeSaltCatalog();

    const catalogFile = path.join(__dirname, "data", "catalog.json");

    const currentCatalog = fs.existsSync(catalogFile)
      ? JSON.parse(fs.readFileSync(catalogFile, "utf8"))
      : {};

    const existing = Array.isArray(currentCatalog.results)
      ? currentCatalog.results
      : [];

    const bySlug = new Map();

    for (const item of existing) {
      const slug = String(item?.slug || "").trim().toLowerCase();
      if (slug) bySlug.set(slug, item);
    }

    for (const item of results) {
      const slug = String(item?.slug || "").trim().toLowerCase();
      if (slug) bySlug.set(slug, item);
    }

    const mergedResults = [...bySlug.values()];

    fs.writeFileSync(
      catalogFile,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        count: mergedResults.length,
        results: mergedResults
      }, null, 2),
      "utf8"
    );

    res.json({
      success: true,
      count: mergedResults.length
    });
  } catch (error) {
    console.error("ADMIN MANUAL SYNC ERROR:", error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get("/admin/api/dashboard", requireAdmin, (req, res) => {
  try {
    const catalogFile = path.join(
      __dirname,
      "data",
      "catalog.json"
    );

    const catalog = fs.existsSync(catalogFile)
      ? JSON.parse(fs.readFileSync(catalogFile, "utf8"))
      : { results: [] };

    const items = Array.isArray(catalog.results)
      ? catalog.results
      : [];

    const ratings = items.filter(
      item => item && item.rating
    ).length;

    const updated = items.filter(
      item => item && item.lastSeenAt
    ).length;

    const releases = items.filter(
      item => item && item.firstSeenAt
    ).length;

    res.json({
      success: true,
      stats: {
        totalAnime: items.length,
        ratings,
        recentlyUpdated: updated,
        newReleases: releases,
        uptime: Math.floor(process.uptime()),
        serverTime: new Date().toISOString()
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.get("/admin", (req, res) => {
  res.sendFile(
    path.join(__dirname, "admin.html")
  );
});

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
          image: tmdbPoster || catalogImage,
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

    const catalogPath = path.join(__dirname, "data", "catalog.json");
    const catalogData = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    const item = (catalogData.results || []).find(x => x.slug === slug);

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Anime not found",
        animeSlug: slug
      });
    }

    const catalogTitle = item.title || "";
    const catalogImage = item.image || "";
    const catalogRating = item.rating || "";

    const description = item.description || "";
    const type = item.type || "";
    const seasons = item.seasons ?? null;
    const episodes = item.episodes ?? null;
    const genres = Array.isArray(item.genres) ? item.genres : [];
    const audio = Array.isArray(item.audio) ? item.audio : [];
    const languages = Array.isArray(item.languages) ? item.languages : [];

    // ------------------------------------------
    // TMDB metadata lookup + Blakite fallback
    // ------------------------------------------

    let tmdbId = null;
    let tmdbType = "";
    let tmdbPoster = "";

    // 1. Try direct TMDB API first
    try {
      const tmdbApiKey = String(process.env.TMDB_API_KEY || "").trim();

      if (tmdbApiKey && catalogTitle) {
        const tmdbRes = await axios.get(
          "https://api.themoviedb.org/3/search/multi",
          {
            params: {
              api_key: tmdbApiKey,
              query: catalogTitle,
              language: "en-US"
            },
            timeout: 10000
          }
        );

        const results = Array.isArray(tmdbRes.data?.results)
          ? tmdbRes.data.results
          : [];

        const match = results.find(item =>
          (item.media_type === "tv" || item.media_type === "movie") &&
          item.id
        );

        if (match) {
          tmdbId = Number(match.id);
          tmdbType = match.media_type;

          if (match.poster_path) {
            tmdbPoster =
              "https://image.tmdb.org/t/p/w500" + match.poster_path;
          }

          console.log(
            `TMDB MATCH: ${catalogTitle} -> ${tmdbType}/${tmdbId}`
          );
        }
      }
    } catch (tmdbError) {
      console.log(
        "TMDB LOOKUP unavailable, trying Blakite:",
        tmdbError.message
      );
    }

    // 2. Blakite fallback
    //    Used when direct TMDB lookup is unavailable or has no match.
    if (!tmdbId || !tmdbPoster) {
      try {
        const blakiteRes = await axios.get(
          "https://blakiteapi.xyz/api/getAllAnime.php",
          {
            headers,
            timeout: 20000,
            maxRedirects: 5
          }
        );

        const blakiteData = blakiteRes.data?.data;

        if (blakiteData && typeof blakiteData === "object") {
          const datasets = [
            blakiteData.movies,
            blakiteData.series,
            blakiteData.dramas
          ];

          let blakiteItem = null;

          // First try exact TMDB ID if catalog already has one.
          for (const dataset of datasets) {
            if (!dataset || typeof dataset !== "object") continue;

            const found = Object.values(dataset).find(x =>
              x &&
              String(x.tmdbId || "") === String(item.tmdbId || "")
            );

            if (found) {
              blakiteItem = found;
              break;
            }
          }

          // Otherwise match by normalized title.
          if (!blakiteItem && catalogTitle) {
            const normalize = value =>
              String(value || "")
                .toLowerCase()
                .replace(/\([^)]*\)/g, " ")
                .replace(/[^a-z0-9]+/g, " ")
                .replace(/\s+/g, " ")
                .trim();

            const wantedTitle = normalize(catalogTitle);

            for (const dataset of datasets) {
              if (!dataset || typeof dataset !== "object") continue;

              const found = Object.values(dataset).find(x => {
                if (!x || !x.title) return false;

                const candidate = normalize(x.title);

                return (
                  candidate === wantedTitle ||
                  candidate.includes(wantedTitle) ||
                  wantedTitle.includes(candidate)
                );
              });

              if (found) {
                blakiteItem = found;
                break;
              }
            }
          }

          if (blakiteItem) {
            if (!tmdbId && blakiteItem.tmdbId) {
              tmdbId = Number(blakiteItem.tmdbId);
            }

            if (!tmdbType && blakiteItem.type) {
              tmdbType =
                String(blakiteItem.type).toLowerCase() === "movie"
                  ? "movie"
                  : "tv";
            }

            const blakitePoster =
              blakiteItem.IMAGES?.poster ||
              blakiteItem.IMAGES?.thumbnail ||
              "";

            if (!tmdbPoster && blakitePoster) {
              tmdbPoster = blakitePoster;
            }

            console.log(
              `BLAKITE MATCH: ${catalogTitle} -> ${tmdbType}/${tmdbId}`
            );

            console.log(
              `BLAKITE POSTER: ${tmdbPoster || "none"}`
            );
          } else {
            console.log(
              `BLAKITE MATCH NOT FOUND: ${catalogTitle}`
            );
          }
        }
      } catch (blakiteError) {
        console.log(
          "BLAKITE LOOKUP unavailable:",
          blakiteError.message
        );
      }
    }

    // ------------------------------------------
    // Extra metadata from authorized metadata source
    // ------------------------------------------

    let quality = "";
    let status = "";
    let released = "";
    let duration = "";

    try {
      const rareUrl =
        `https://www.rareanimes.mov/${encodeURIComponent(slug)}/`;

      const rareRes = await axios.get(rareUrl, {
        headers,
        maxRedirects: 5,
        timeout: 10000
      });

      const rareHtml = String(rareRes.data || "");

      // Status: completed category
      if (/category-completed/i.test(rareHtml)) {
        status = "Completed";
      }

      // Convert relevant HTML to readable text
      const rare$ = cheerio.load(rareHtml);
      const rareText = rare$("body")
        .text()
        .replace(/\s+/g, " ")
        .trim();

      // Duration
      const durationMatch =
        rareText.match(/RunTime\s*:\s*([^🎞]+)/i);

      if (durationMatch) {
        duration = durationMatch[1].trim();
      }

      // Released / Year
      const releasedMatch =
        rareText.match(/Year\s*:\s*([^🔊]+)/i);

      if (releasedMatch) {
        released = releasedMatch[1].trim();
      }

      // Quality
      const qualityMatch =
        rareText.match(/Quality\s*:\s*\(([^)]+)\)/i);

      if (qualityMatch) {
        quality = qualityMatch[1].trim();
      }

    } catch (metadataError) {
      console.log(
        "EXTRA METADATA unavailable:",
        metadataError.message
      );
    }

    res.json({
      success: true,
      anime: {
        slug,
        title: catalogTitle,
        tmdbId,
        tmdbType,
        description,
        image: catalogImage || tmdbPoster,
        type,
        rating: catalogRating,
        seasons,
        episodes,
        genres,
        audio,
        languages,
        quality,
        status,
        released,
        duration
      }
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

const ANIMESALT_BASE_URL = "https://animesalt.cx";

const animeSaltHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 20,
  maxFreeSockets: 10,
  timeout: 15000
});

async function scrapeAnimeSaltEpisode(episodeUrl, season, episode) {
  try {
    const { data: html } = await axios.get(episodeUrl, {
      headers,
      timeout: 15000,
      maxRedirects: 5,
      httpsAgent: animeSaltHttpsAgent
    });

    const $ = cheerio.load(html);

    const results = [];

    // --------------------------------------------------
    // AnimeSalt CDN player
    // --------------------------------------------------
    let cdnUrl = null;

    $("iframe").each((_, el) => {
      const candidates = [
        $(el).attr("src"),
        $(el).attr("data-src"),
        $(el).attr("data-url")
      ].filter(Boolean);

      for (const value of candidates) {
        if (/^https?:\/\/as-cdn26\.top\/video\//i.test(value)) {
          cdnUrl = value;
          return false;
        }
      }
    });

    if (cdnUrl) {
      console.log(
        `ANIMESALT CDN [S${season}E${episode}]: ${cdnUrl}`
      );

      results.push({
        episode: Number(episode),
        season: Number(season),
        type: "iframe",
        url: cdnUrl,
        language: "Hindi"
      });
    } else {
      console.log(
        `ANIMESALT CDN NOT FOUND: S${season}E${episode}`
      );
    }

    // --------------------------------------------------
    // AnimeSalt multi-language player
    // --------------------------------------------------
    let playerUrl = null;

    $("iframe").each((_, el) => {
      const candidates = [
        $(el).attr("src"),
        $(el).attr("data-src"),
        $(el).attr("data-url")
      ].filter(Boolean);

      for (const value of candidates) {
        if (
          value.includes("/multi-lang-plyr/player.php?data=")
        ) {
          playerUrl = value;
          return false;
        }
      }
    });

    if (!playerUrl) {
      const match = html.match(
        /https?:\/\/animesalt\.cx\/multi-lang-plyr\/player\.php\?data=[^"'<> \t\r\n]+/
      );

      if (match) {
        playerUrl = match[0];
      }
    }

    if (!playerUrl) {
      console.log(
        `ANIMESALT MULTI PLAYER NOT FOUND: S${season}E${episode}`
      );
      return results;
    }

    const dataMatch = playerUrl.match(
      /[?&]data=([^&"'<> \t\r\n]+)/
    );

    if (!dataMatch) {
      return results;
    }

    const encoded = decodeURIComponent(dataMatch[1]);

    let decoded;

    try {
      decoded = Buffer
        .from(encoded, "base64")
        .toString("utf8")
        .trim();
    } catch {
      return results;
    }

    let languages;

    try {
      languages = JSON.parse(decoded);
    } catch {
      console.log(
        `ANIMESALT JSON ERROR: S${season}E${episode}`
      );
      return results;
    }

    if (!Array.isArray(languages)) {
      return results;
    }

    for (const item of languages) {
      const language = String(item?.language || "").trim();
      const link = String(item?.link || "").trim();

      if (!language || !link) continue;

      if (!/^https?:\/\//i.test(link)) {
        continue;
      }

      console.log(
        `ANIMESALT LINK [S${season}E${episode} ${language}]: ${link}`
      );

      results.push({
        episode: Number(episode),
        season: Number(season),
        type: "iframe",
        url: link,
        language
      });
    }

    return results;

  } catch (error) {
    console.error(
      `ANIMESALT EPISODE ERROR [S${season}E${episode}]:`,
      error.message
    );

    return [];
  }
}

async function scrapeAnimeSaltEpisodes(slug) {
  try {
    const seriesUrl = `${ANIMESALT_BASE_URL}/series/${slug}/`;
    console.log(`ANIMESALT SERIES: ${seriesUrl}`);

    const { data: html } = await axios.get(seriesUrl, {
      headers,
      timeout: 15000,
      maxRedirects: 5,
      httpsAgent: animeSaltHttpsAgent
    });

    const $ = cheerio.load(html);

    // AnimeSalt exposes all seasons through its season buttons.
    const seasons = [];

    $('a.season-btn[data-season][data-post]').each((_, el) => {
      const season = Number($(el).attr('data-season'));
      const post = String($(el).attr('data-post') || '').trim();

      if (Number.isFinite(season) && post) {
        seasons.push({ season, post });
      }
    });

    const uniqueSeasons = [
      ...new Map(seasons.map(x => [x.season, x])).values()
    ].sort((a, b) => a.season - b.season);

    console.log(
      `ANIMESALT SEASONS FOUND: ${slug} (${uniqueSeasons.map(x => x.season).join(", ")})`
    );

    if (!uniqueSeasons.length) {
      return [];
    }

    const episodeLinks = new Map();

    // Get the complete episode list for EVERY season through AnimeSalt AJAX.
    for (const { season, post } of uniqueSeasons) {
      try {
        const ajaxUrl =
          `${ANIMESALT_BASE_URL}/wp-admin/admin-ajax.php` +
          `?action=action_select_season&season=${season}&post=${post}`;

        const { data: seasonHtml } = await axios.get(ajaxUrl, {
          headers: {
            ...headers,
            "Referer": seriesUrl,
            "X-Requested-With": "XMLHttpRequest"
          },
          timeout: 15000,
          maxRedirects: 5,
          httpsAgent: animeSaltHttpsAgent
        });

        const $$ = cheerio.load(seasonHtml);
        let foundCount = 0;

        $$('a[href]').each((_, el) => {
          const href = $$(el).attr('href');
          if (!href) return;

          const match = href.match(
            /\/episode\/[^/]+-(\d+)x(\d+)\/?$/i
          );

          if (!match) return;

          const epSeason = Number(match[1]);
          const episode = Number(match[2]);

          if (
            !Number.isFinite(epSeason) ||
            !Number.isFinite(episode) ||
            epSeason !== season
          ) {
            return;
          }

          const url = new URL(href, ANIMESALT_BASE_URL).href;

          episodeLinks.set(
            `${epSeason}-${episode}`,
            {
              url,
              season: epSeason,
              episode
            }
          );

          foundCount++;
        });

        console.log(
          `ANIMESALT AJAX SEASON ${season}: ${foundCount} episode links`
        );
      } catch (error) {
        console.error(
          `ANIMESALT AJAX SEASON ERROR S${season}:`,
          error.message
        );
      }
    }

    const links = [...episodeLinks.values()].sort((a, b) => {
      if (a.season !== b.season) {
        return a.season - b.season;
      }
      return a.episode - b.episode;
    });

    console.log(
      `ANIMESALT COMPLETE EPISODE LINKS: ${slug} (${links.length})`
    );

    if (!links.length) {
      return [];
    }

    const episodes = [];
    const BATCH_SIZE = 8;

    for (let i = 0; i < links.length; i += BATCH_SIZE) {
      const batch = links.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(item =>
          scrapeAnimeSaltEpisode(
            item.url,
            item.season,
            item.episode
          )
        )
      );

      for (const found of batchResults) {
        episodes.push(...found);
      }

      console.log(
        `ANIMESALT EPISODE BATCH: ${Math.min(
          i + BATCH_SIZE,
          links.length
        )}/${links.length}`
      );
    }

    const unique = [
      ...new Map(
        episodes.map(ep => [
          `${ep.season}-${ep.episode}-${ep.language}-${ep.url}`,
          ep
        ])
      ).values()
    ];

    console.log(
      `ANIMESALT EPISODES FOUND: ${slug} (${unique.length} language entries)`
    );

    const cdnEpisodes = unique.filter(ep =>
      /^https?:\/\/as-cdn26\.top\/video\//i.test(ep.url)
    );

    const servers = [];

    if (cdnEpisodes.length) {
      servers.push({
        name: "AnimeSalt CDN",
        type: "series",
        episodes: cdnEpisodes
      });
    }

    console.log(
      `ANIMESALT SERVER BUILT: ${slug} (CDN: ${cdnEpisodes.length})`
    );

    return servers;
  } catch (error) {
    console.error(
      `ANIMESALT ERROR [${slug}]:`,
      error.message
    );
    return [];
  }
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

    // --------------------------------------------------
    // ANIMESALT MOVIE DATA
    // --------------------------------------------------
    try {
      const movieFile = path.join(
        __dirname,
        "animesalt-movie-streams.json"
      );

      if (fs.existsSync(movieFile)) {
        const movieData = JSON.parse(
          fs.readFileSync(movieFile, "utf8")
        );

        const movie = Array.isArray(movieData)
          ? movieData.find(item => item && item.slug === slug)
          : null;

        if (movie && Array.isArray(movie.servers) && movie.servers.length) {
          console.log(
            `ANIMESALT MOVIE DATA: ${slug} (${movie.servers.length} server(s))`
          );

          return res.json({
            success: true,
            animeSlug: slug,
            type: "movie",
            cached: false,
            serverCount: movie.servers.length,
            servers: movie.servers
          });
        }
      }
    } catch (error) {
      console.log(
        `ANIMESALT MOVIE DATA FAILED [${slug}]: ${error.message}`
      );
    }


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

    // Authorized player sources
    let servers = [];

    // Add AnimeSalt episodes when available
    try {
      const animeSaltServers = await scrapeAnimeSaltEpisodes(slug);

      if (animeSaltServers.length) {
        servers.push(...animeSaltServers);
        console.log(
          `ANIMESALT ADDED: ${slug} (${animeSaltServers[0].episodes.length} language entries)`
        );
      }
    } catch (error) {
      console.log(`ANIMESALT FAILED [${slug}]: ${error.message}`);
    }

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
// FRONTEND ROUTES
// --------------------------------------------------

app.get("/anime/:slug", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/watch/:slug/:episode", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
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

