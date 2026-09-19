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
const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/120.0.0.0 Safari/537.36",
};

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
    const catalogFile =
      path.join(__dirname, "data", "catalog.json");

    if (!fs.existsSync(catalogFile)) {
      return res.status(500).json({
        success: false,
        message: "Catalog not found",
      });
    }

    const catalog =
      JSON.parse(fs.readFileSync(catalogFile, "utf8"));

    const items = Array.isArray(catalog.results)
      ? catalog.results
      : [];

    const q = query.toLowerCase();

    const results = items
      .filter((item) => {
        if (!item) return false;

        const title = String(item.title || "").toLowerCase();
        const slug = String(item.slug || "").toLowerCase();

        return title.includes(q) || slug.includes(q);
      })
      .slice(0, 20)
      .map((item) => ({
        title: item.title || "",
        image: item.image || "",
        link: item.link || "",
        slug: item.slug || "",
        type: item.type || "",
      }));

    return res.json({
      success: true,
      query,
      count: results.length,
      results,
    });
  } catch (error) {
    console.error("SEARCH ERROR:", error.message);

    return res.status(500).json({
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

    const catalogPath =
      path.join(__dirname, "data", "catalog.json");

    const catalogData =
      JSON.parse(fs.readFileSync(catalogPath, "utf8"));

    const item =
      (catalogData.results || []).find(x => x.slug === slug);

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
    const type = item.type || "";

    let description = item.description || "";

    if (String(type).toLowerCase() === "movie") {
      description = String(description)
        .split(/Watch\/Download Links/i)[0]
        .split(/Winding Up/i)[0]
        .split(/Thanks for visiting/i)[0]
        .trim();
    }

    const seasons = item.seasons ?? null;
    const episodes = item.episodes ?? null;
    const genres = Array.isArray(item.genres) ? item.genres : [];
    const audio = Array.isArray(item.audio) ? item.audio : [];
    const languages = Array.isArray(item.languages) ? item.languages : [];

    const tmdbId = item.tmdbId ?? null;
    const tmdbType = item.tmdbType || "";

    const quality = item.quality || "";
    const status = item.status || "";
    const released = item.released || "";
    const duration = item.duration || "";

    return res.json({
      success: true,
      anime: {
        slug,
        title: catalogTitle,
        tmdbId,
        tmdbType,
        description,
        image: catalogImage,
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

    return res.status(500).json({
      success: false,
      message: "Unable to load anime",
    });
  }
});

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

    // Save season/episode metadata from the available player sources.
    const seasonSet = new Set();
    const episodeSet = new Set();

    for(const server of servers){
      for(const ep of (server.episodes || [])){
        if(!ep || ep.season == null || ep.episode == null){
          continue;
        }

        const season = Number(ep.season);
        const episode = Number(ep.episode);

        if(!Number.isFinite(season) || !Number.isFinite(episode)){
          continue;
        }

        seasonSet.add(season);
        episodeSet.add(`${season}-${episode}`);
      }
    }

    const newSeasons = seasonSet.size;
    const newEpisodes = episodeSet.size;

    const metadataChanged =
      Number(item.seasons || 0) !== newSeasons ||
      Number(item.episodes || 0) !== newEpisodes;

    item.seasons = newSeasons;
    item.episodes = newEpisodes;

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

    // Save metadata even when the episode count did not increase.
    if(metadataChanged){
      fs.writeFileSync(
        catalogFile,
        JSON.stringify(catalog, null, 2),
        "utf8"
      );

      console.log(
        `EPISODE METADATA SAVED: ${slug} seasons=${newSeasons} episodes=${newEpisodes}`
      );
    }

    // Only mark as updated when episode count increases.
    if(count > previous){

      const now = new Date().toISOString();

      item.latestEpisodeCount = count;
      item.episodeUpdatedAt = now;
      item.lastSeenAt = now;

      fs.writeFileSync(
        catalogFile,
        JSON.stringify(catalog, null, 2),
        "utf8"
      );

      console.log(
        `NEW EPISODES: ${slug} ${previous} -> ${count}`
      );

      console.log(
        `RECENTLY UPDATED: ${slug} -> ${now}`
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

// --------------------------------------------------
// AnimeSalt Public Iframe Streams
// --------------------------------------------------

const ANIMESALT_BASE_URL = "https://animesalt.cx";

function animeSaltCleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

const ANIMESALT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

const animeSaltClient = axios.create({
  baseURL: ANIMESALT_BASE_URL,
  headers: ANIMESALT_HEADERS,
  timeout: 30000,
  maxRedirects: 5,
});

function animeSaltAbsoluteUrl(url) {
  if (!url) return "";
  try {
    return new URL(url, ANIMESALT_BASE_URL).href;
  } catch {
    return "";
  }
}

function parseAnimeSaltEpisodeNumber(text) {
  const match = String(text || "").match(
    /(?:^|\s)(\d+)\s*x\s*(\d+)(?:\s|$)/i
  );

  if (!match) {
    return {
      season: 1,
      episode: 1,
    };
  }

  return {
    season: Number(match[1]),
    episode: Number(match[2]),
  };
}

async function fetchAnimeSaltPage(url) {
  const response = await animeSaltClient.get(url);
  return response.data;
}

function parseAnimeSaltEpisodeLinks(html) {
  const $ = cheerio.load(html);
  const episodes = [];
  const seen = new Set();

  $("article.post.episodes, article.episodes, article.post").each(
    (_, el) => {
      const card = $(el);

      const href =
        card.find('a[href*="/episode/"]').first().attr("href") || "";

      if (!href) return;

      const url = animeSaltAbsoluteUrl(href);

      if (!url || !url.includes("/episode/")) return;

      if (seen.has(url)) return;
      seen.add(url);

      const title = animeSaltCleanText(
        card.find("h2.entry-title, h3.entry-title")
          .first()
          .text() ||
        card.find(".entry-title")
          .first()
          .text()
      );

      const numbers = parseAnimeSaltEpisodeNumber(title || url);

      episodes.push({
        season: numbers.season,
        episode: numbers.episode,
        pageUrl: url,
        title: title || "",
      });
    }
  );

  return episodes.sort((a, b) => {
    if (a.season !== b.season) {
      return a.season - b.season;
    }

    return a.episode - b.episode;
  });
}

function parseAnimeSaltPublicIframes(html) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $("iframe").each((_, el) => {
    const iframe = $(el);

    const src =
      iframe.attr("data-src") ||
      iframe.attr("src") ||
      "";

    if (!src) return;

    const url = animeSaltAbsoluteUrl(src);

    if (!url) return;

    // Only use the openly exposed AnimeSalt MyStream iframe.
    // Do not unwrap protected/hidden media URLs.
    if (!url.startsWith("https://as-cdn26.top/video/")) {
      return;
    }

    if (seen.has(url)) return;
    seen.add(url);

    results.push(url);
  });

  return results;
}

async function getAnimeSaltSeriesSources(slug) {
  const seriesUrl =
    `${ANIMESALT_BASE_URL}/series/${slug}/`;

  const seriesHtml = await fetchAnimeSaltPage(seriesUrl);

  // Season 1 is present directly in the series HTML.
  const firstSeasonEpisodes =
    parseAnimeSaltEpisodeLinks(seriesHtml);

  // Read the public season selector from the same page.
  // AnimeSalt loads additional seasons through its public AJAX endpoint.
  const $ = cheerio.load(seriesHtml);

  const seasonButtons = [];

  $(".season-btn").each((_, el) => {
    const btn = $(el);

    const postId = btn.attr("data-post");
    const season = Number(btn.attr("data-season"));

    if (!postId || !Number.isInteger(season) || season < 1) {
      return;
    }

    const key = `${postId}:${season}`;

    if (
      seasonButtons.some(
        item => `${item.postId}:${item.season}` === key
      )
    ) {
      return;
    }

    seasonButtons.push({
      postId,
      season,
    });
  });

  const allEpisodeLinks = [];
  const seenEpisodeLinks = new Set();

  for (const item of firstSeasonEpisodes) {
    if (seenEpisodeLinks.has(item.pageUrl)) {
      continue;
    }

    seenEpisodeLinks.add(item.pageUrl);
    allEpisodeLinks.push(item);
  }

  // Fetch every publicly exposed season through AnimeSalt's
  // normal season-selection AJAX endpoint.
  for (const seasonButton of seasonButtons) {
    if (seasonButton.season === 1) {
      continue;
    }

    try {
      const ajaxUrl =
        `${ANIMESALT_BASE_URL}/wp-admin/admin-ajax.php` +
        `?action=action_select_season` +
        `&season=${seasonButton.season}` +
        `&post=${seasonButton.postId}`;

      const seasonHtml =
        await fetchAnimeSaltPage(ajaxUrl);

      const seasonEpisodes =
        parseAnimeSaltEpisodeLinks(seasonHtml);

      console.log(
        `ANIMESALT SEASON ${seasonButton.season}: ` +
        `${seasonEpisodes.length} episodes`
      );

      for (const episode of seasonEpisodes) {
        if (seenEpisodeLinks.has(episode.pageUrl)) {
          continue;
        }

        seenEpisodeLinks.add(episode.pageUrl);
        allEpisodeLinks.push(episode);
      }
    } catch (error) {
      console.error(
        `ANIMESALT SEASON ${seasonButton.season} ERROR:`,
        error.message
      );
    }
  }

  allEpisodeLinks.sort((a, b) => {
    if (a.season !== b.season) {
      return a.season - b.season;
    }

    return a.episode - b.episode;
  });

  if (!allEpisodeLinks.length) {
    return [];
  }

  const episodes = [];

  for (const item of allEpisodeLinks) {
    try {
      const html =
        await fetchAnimeSaltPage(item.pageUrl);

      const iframes =
        parseAnimeSaltPublicIframes(html);

      if (!iframes.length) {
        continue;
      }

      episodes.push({
        season: item.season,
        episode: item.episode,
        type: "iframe",
        url: iframes[0],
        language: "Hindi",
        title: item.title,
      });
    } catch (error) {
      console.error(
        `ANIMESALT EPISODE ERROR ${item.season}x${item.episode}:`,
        error.message
      );
    }
  }

  if (!episodes.length) {
    return [];
  }

  return [
    {
      name: "MyStream",
      type: "iframe",
      episodes,
    },
  ];
}
async function getAnimeSaltMovieSources(slug) {
  const movieUrl =
    `${ANIMESALT_BASE_URL}/movies/${slug}/`;

  const html = await fetchAnimeSaltPage(movieUrl);

  const iframes =
    parseAnimeSaltPublicIframes(html);

  if (!iframes.length) {
    return [];
  }

  return [
    {
      name: "MyStream",
      type: "iframe",
      episodes: [
        {
          season: 1,
          episode: 1,
          type: "iframe",
          url: iframes[0],
          language: "Hindi",
          title: slug,
        },
      ],
    },
  ];
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
          type: cached.type || "series",
          cached: true,
          serverCount: cached.servers.length,
          servers: cached.servers,
        });
      }

      console.log(`STREAM CACHE EXPIRED: ${slug}`);
      streamCache.delete(slug);
    }

    const catalogFile = path.join(
      __dirname,
      "data",
      "catalog.json"
    );

    let animeType = "series";

    try {
      const catalogData = JSON.parse(
        fs.readFileSync(catalogFile, "utf8")
      );

      const catalog = Array.isArray(catalogData)
        ? catalogData
        : catalogData.results || [];

      const anime = catalog.find(item => {
        if (!item || !item.slug) return false;

        if (item.slug === slug) return true;

        try {
          return decodeURIComponent(item.slug) === slug;
        } catch {
          return false;
        }
      });

      if (!anime) {
        return res.status(404).json({
          success: false,
          message: "Anime not found in catalog",
          animeSlug: slug,
        });
      }

      animeType = anime.type || "series";
    } catch (error) {
      console.error(
        "CATALOG READ ERROR:",
        error.message
      );
    }

    const servers =
      animeType === "movie"
        ? await getAnimeSaltMovieSources(slug)
        : await getAnimeSaltSeriesSources(slug);

    if (!servers.length) {
      return res.status(404).json({
        success: false,
        message: "No public AnimeSalt iframe sources found",
        animeSlug: slug,
        type: animeType,
      });
    }

    streamCache.set(slug, {
      updatedAt: Date.now(),
      type: animeType,
      servers,
    });

    res.json({
      success: true,
      animeSlug: slug,
      type: animeType,
      cached: false,
      serverCount: servers.length,
      servers,
    });

  } catch (error) {
    console.error(
      "ANIMESALT STREAM ERROR:",
      error.message
    );

    res.status(500).json({
      success: false,
      message: "Unable to load AnimeSalt episode sources",
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

// --------------------------------------------------
// MEDIA STREAM NORMALIZER
// --------------------------------------------------
function normalizeMediaStream(htmlContent, baseUrl) {
  const mediaRegex =
    /(?:https?:\/\/|\/|\.{1,2}\/)?[^\s"'<>\\]+?\.(mp4|m3u8)(?:[?#][^\s"'<>\\]*)?/gi;

  const match = mediaRegex.exec(String(htmlContent || ""));

  if (!match) {
    return {
      type: "iframe",
      url: baseUrl
    };
  }

  const rawUrl = match[0]
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");

  try {
    const resolvedUrl = new URL(rawUrl, baseUrl).href;

    return {
      type: /\.m3u8(?:[?#]|$)/i.test(resolvedUrl)
        ? "hls"
        : "direct",
      url: resolvedUrl
    };
  } catch {
    return {
      type: "iframe",
      url: baseUrl
    };
  }
}

// --------------------------------------------------
// PUBLIC MEDIA SOURCE PARSER
// Finds openly exposed MP4/M3U8 URLs in an HTML page.
// Does not bypass protected/tokenized media sources.
// --------------------------------------------------
function parseOpenMediaSources(html, baseUrl) {
  const urls = new Set();

  // Absolute URLs inside HTML/JavaScript.
  const absoluteRegex =
    /https?:\/\/[^\s"'<>\\]+?\.(?:mp4|m3u8)(?:[?#][^\s"'<>\\]*)?/gi;

  for (const match of html.matchAll(absoluteRegex)) {
    urls.add(
      match[0]
        .replace(/\\\//g, "/")
        .replace(/&amp;/g, "&")
    );
  }

  const $ = cheerio.load(html);

  function addUrl(value) {
    if (!value) return;

    try {
      const absolute = new URL(value, baseUrl).href;

      if (/\.(?:mp4|m3u8)(?:[?#]|$)/i.test(absolute)) {
        urls.add(absolute);
      }
    } catch {
      // Ignore malformed URLs.
    }
  }

  $("video[src]").each((_, el) => {
    addUrl($(el).attr("src"));
  });

  $("source[src]").each((_, el) => {
    addUrl($(el).attr("src"));
  });

  $("[data-src], [data-url], [data-file]").each((_, el) => {
    addUrl($(el).attr("data-src"));
    addUrl($(el).attr("data-url"));
    addUrl($(el).attr("data-file"));
  });

  return [...urls];
}

function getOpenMediaFormat(url) {
  return /\.m3u8(?:[?#]|$)/i.test(url) ? "m3u8" : "mp4";
}

app.get("/api/parse-stream", async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({
      success: false,
      error: "Missing required query parameter: url"
    });
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(targetUrl);

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Invalid protocol");
    }
  } catch {
    return res.status(400).json({
      success: false,
      error: "Invalid URL"
    });
  }

  try {
    const response = await axios.get(parsedUrl.href, {
      timeout: 15000,
      maxRedirects: 5,
      responseType: "text",
      headers: {
        "User-Agent": headers["User-Agent"],
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": parsedUrl.href
      }
    });

    const sources = parseOpenMediaSources(
      response.data,
      parsedUrl.href
    );

    if (!sources.length) {
      return res.status(404).json({
        success: false,
        error: "No open MP4 or M3U8 media URL found"
      });
    }

    const streamUrl = sources[0];

    return res.json({
      success: true,
      streamUrl,
      format: getOpenMediaFormat(streamUrl)
    });

  } catch (error) {
    console.error(
      "[parse-stream]",
      error.code || "",
      error.message
    );

    if (error.response) {
      return res.status(500).json({
        success: false,
        error: `Source returned HTTP ${error.response.status}`
      });
    }

    if (error.code === "ECONNABORTED") {
      return res.status(500).json({
        success: false,
        error: "Source request timed out"
      });
    }

    return res.status(500).json({
      success: false,
      error: "Failed to fetch source URL"
    });
  }
});


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

