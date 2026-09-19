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
// ANIMESALT STREAM SOURCES
// --------------------------------------------------

async function fetchAnimeSaltEpisodeSources(episodeUrl) {
  const response = await axios.get(episodeUrl, {
    headers,
    timeout: 15000,
  });

  const $ = cheerio.load(response.data);
  const sources = [];

  $("iframe").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src");
    if (!src) return;

    try {
      const url = new URL(src, episodeUrl).href;
      if (!sources.includes(url)) {
        sources.push(url);
      }
    } catch {}
  });

  return sources;
}

async function getAnimeSaltSeriesSources(slug) {
  const animeSaltSlugMap = {
    "oshi-no-ko": "【oshi-no-ko】"
  };

  const animeSaltSlug = animeSaltSlugMap[slug] || slug;
  const detailUrl = `https://animesalt.cx/series/${encodeURIComponent(animeSaltSlug)}/`;

  const response = await axios.get(detailUrl, {
    headers,
    timeout: 15000,
  });

  const $ = cheerio.load(response.data);
  const episodes = [];

  function addEpisodes(html, forcedSeason = null) {
    const $$ = cheerio.load(html);

    $$("#episode_by_temp article.episodes, article.episodes").each((_, el) => {
      const card = $$(el);
      const url = card.find("a.lnk-blk[href*='/episode/']").attr("href");

      if (!url) return;

      const title =
        card.find(".entry-title").first().text().trim() ||
        card.find(".num-epi").first().text().trim() ||
        "";

      const absoluteUrl = new URL(
        url,
        "https://animesalt.cx/"
      ).href;

      const match = absoluteUrl.match(/-(\d+)x(\d+)(?:\/|$)/i);

      if (!match) return;

      const season =
        forcedSeason != null
          ? Number(forcedSeason)
          : Number(match[1]);

      const episode = Number(match[2]);

      if (!Number.isFinite(season) || !Number.isFinite(episode)) {
        return;
      }

      const key = `${season}-${episode}`;

      if (!episodes.some(ep => `${ep.season}-${ep.episode}` === key)) {
        episodes.push({
          season,
          episode,
          title,
          sourceUrl: absoluteUrl,
        });
      }
    });
  }

  addEpisodes(response.data, 1);

  const postId =
    $("#episode_by_temp").attr("data-post") ||
    $("[data-post]").first().attr("data-post");

  const seasonValues = new Set();

  $("[data-season]").each((_, el) => {
    const value = $(el).attr("data-season");
    if (value) seasonValues.add(value);
  });

  if (postId) {
    for (const season of seasonValues) {
      try {
        const seasonResponse = await axios.get(
          "https://animesalt.cx/wp-admin/admin-ajax.php",
          {
            params: {
              action: "action_select_season",
              season,
              post: postId,
            },
            headers,
            timeout: 15000,
          }
        );

        addEpisodes(seasonResponse.data, season);
      } catch (error) {
        console.error(
          `ANIMESALT SEASON ${season} ERROR:`,
          error.message
        );
      }
    }
  }

  episodes.sort((a, b) =>
    Number(a.season) - Number(b.season) ||
    Number(a.episode) - Number(b.episode)
  );

  const concurrency = 8;
  const streamEpisodes = [];

  for (let i = 0; i < episodes.length; i += concurrency) {
    const batch = episodes.slice(i, i + concurrency);

    const results = await Promise.all(
      batch.map(async ep => {
        try {
          const sourceUrls = await fetchAnimeSaltEpisodeSources(
            ep.sourceUrl
          );

          return {
            ep,
            sourceUrls,
          };
        } catch (error) {
          console.error(
            `ANIMESALT EPISODE ${ep.season}x${ep.episode} ERROR:`,
            error.message
          );

          return {
            ep,
            sourceUrls: [],
          };
        }
      })
    );

    for (const { ep, sourceUrls } of results) {
      for (const sourceUrl of sourceUrls) {
        streamEpisodes.push({
          season: ep.season,
          episode: ep.episode,
          title: ep.title,
          url: sourceUrl,
        });
      }
    }

    console.log(
      `ANIMESALT STREAM SOURCES: ${Math.min(
        i + concurrency,
        episodes.length
      )}/${episodes.length}`
    );
  }

  if (!streamEpisodes.length) {
    return [];
  }

  return [
    {
      name: "AnimeSalt",
      type: "iframe",
      language: "Multi Audio",
      episodes: streamEpisodes,
    },
  ];
}

async function getAnimeSaltMovieSources(slug) {
  const detailUrl = `https://animesalt.cx/movies/${encodeURIComponent(slug)}/`;

  const response = await axios.get(detailUrl, {
    headers,
    timeout: 15000,
  });

  const $ = cheerio.load(response.data);
  const sources = [];

  $("iframe").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src");
    if (!src) return;

    try {
      const url = new URL(src, detailUrl).href;
      if (!sources.includes(url)) sources.push(url);
    } catch {}
  });

  return sources.map((url) => ({
    name: "AnimeSalt",
    type: "iframe",
    language: "Multi Audio",
    url,
  }));
}


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
  const detailText = (value) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .trim();

  try {
    const slug = String(req.params.slug || "").trim();

    const catalogPath = path.join(
      __dirname,
      "data",
      "catalog.json"
    );

    const catalogData = JSON.parse(
      fs.readFileSync(catalogPath, "utf8")
    );

    const normalizedSlug = decodeURIComponent(slug).toLowerCase();

    const item = (catalogData.results || []).find(x => {
      const itemSlug = String(x?.slug || "");
      const itemTitle = String(x?.title || "");

      return (
        itemSlug === slug ||
        decodeURIComponent(itemSlug).toLowerCase() === normalizedSlug ||
        itemTitle.toLowerCase() === normalizedSlug ||
        (
          normalizedSlug === "oshi-no-ko" &&
          itemTitle === "【OSHI NO KO】"
        )
      );
    });

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Anime not found",
        animeSlug: slug
      });
    }

    let title = item.title || "";
    let image = item.image || "";
    let rating = item.rating || "";
    let type = item.type || "";

    let description = item.description || "";
    let seasons = item.seasons ?? null;
    let episodes = item.episodes ?? null;
    let genres = Array.isArray(item.genres) ? item.genres : [];
    let audio = Array.isArray(item.audio) ? item.audio : [];
    let languages = Array.isArray(item.languages)
      ? item.languages
      : [];

    let quality = item.quality || "";
    let status = item.status || "";
    let released = item.released || "";
    let duration = item.duration || "";

    let episodeList = [];

    try {
      const detailUrl =
        item.link ||
        `https://animesalt.cx/series/${encodeURIComponent(slug)}/`;

      const detailResponse = await axios.get(detailUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/120.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        },
        timeout: 20000
      });

      const $ = cheerio.load(detailResponse.data);

      const pageTitle =
        detailText($("h1").first().text()) || title;

      if (pageTitle) {
        title = pageTitle;
      }

      const poster =
        $("img[alt*='Image ']").first().attr("data-src") ||
        $("img[alt*='Image ']").first().attr("src") ||
        "";

      if (
        poster &&
        !poster.startsWith("data:image/")
      ) {
        image = new URL(
          poster,
          "https://animesalt.cx/"
        ).href;
      }

      const overview =
        detailText($("#overview-text p").first().text()) ||
        detailText($(".overview p").first().text());

      if (overview) {
        description = overview;
      }

      const infoText = detailText(
        $(".bd").first().text()
      );

      const seasonsMatch =
        infoText.match(/(\d+)\s+Seasons?/i);

      const episodesMatch =
        infoText.match(/(\d+)\s+Episodes?/i);

      const durationMatch =
        infoText.match(/(\d+)\s+min\b/i);

      const yearMatch =
        infoText.match(/\b(19\d{2}|20\d{2})\b/);

      if (seasonsMatch) {
        seasons = Number(seasonsMatch[1]);
      }

      if (episodesMatch) {
        episodes = Number(episodesMatch[1]);
      }

      if (durationMatch) {
        duration = `${durationMatch[1]} min`;
      }

      if (yearMatch) {
        released = yearMatch[1];
      }

      const qualityText =
        detailText(
          $("meta[name='description']").attr("content") ||
          $("meta[property='og:description']").attr("content") ||
          ""
        );

      const qualityMatches =
        qualityText.match(/\b(?:480p|720p|1080p|2160p)\b/gi) || [];

      quality = [...new Set(qualityMatches)].join(", ");

      const genreBox = $("h4").filter(function () {
        return detailText($(this).text()).toLowerCase() === "genres";
      }).first().parent();

      const languageBox = $("h4").filter(function () {
        return detailText($(this).text()).toLowerCase() === "languages";
      }).first().parent();

      const parsedGenres = genreBox.find("a").map((_, el) =>
        detailText($(el).text())
      ).get().filter(Boolean);

      const parsedLanguages = languageBox.find("a").map((_, el) =>
        detailText($(el).text())
      ).get().filter(Boolean);

      if (parsedGenres.length) {
        genres = [...new Set(parsedGenres)];
      }

      if (parsedLanguages.length) {
        languages = [...new Set(parsedLanguages)];
        audio = [...new Set(parsedLanguages)];
      }

      const parseEpisodeCards = (html, forcedSeason = null) => {
        const $season = cheerio.load(html);

        return $season("#episode_by_temp article.episodes, article.episodes")
          .map((_, el) => {
            const card = $season(el);

            const numberText =
              detailText(card.find(".num-epi").first().text());

            const episodeTitle =
              detailText(card.find(".entry-title").first().text());

            const link =
              card.find("a.lnk-blk[href*='/episode/']")
                .first()
                .attr("href") || "";

            const thumbnail =
              card.find("img").first().attr("data-src") ||
              card.find("img").first().attr("src") ||
              "";

            const number = Number(numberText);

            const href = link
              ? new URL(link, "https://animesalt.cx/").href
              : "";

            const seasonEpisode =
              href.match(/\/episode\/[^/]+-(\d+)x(\d+)\/?$/i);

            const parsedSeason = seasonEpisode
              ? Number(seasonEpisode[1])
              : forcedSeason;

            const parsedEpisode = seasonEpisode
              ? Number(seasonEpisode[2])
              : (Number.isFinite(number) ? number : null);

            return {
              episode: Number.isFinite(number)
                ? number
                : parsedEpisode,
              title: episodeTitle,
              url: href,
              image: thumbnail
                ? new URL(
                    thumbnail,
                    "https://animesalt.cx/"
                  ).href
                : "",
              season: parsedSeason,
              episodeNumber: parsedEpisode
            };
          })
          .get()
          .filter(item => item.url);
      };

      // Parse Season 1 episodes from the main detail page.
      episodeList = parseEpisodeCards(detailResponse.data);

      const episodeMap = new Map();

      for (const item of episodeList) {
        const key = `${item.season}:${item.episodeNumber}`;

        if (!episodeMap.has(key)) {
          episodeMap.set(key, item);
        }
      }

      const postIdMatch =
        detailResponse.data.match(/data-post=["'](\d+)["']/i);

      const postId =
        postIdMatch ? postIdMatch[1] : null;

      const seasonsToLoad = [
        ...new Set(
          [...detailResponse.data.matchAll(
            /class=["'][^"']*season-btn[^"']*["'][^>]*data-season=["'](\d+)["'][^>]*>/gi
          )]
            .map(match => Number(match[1]))
            .filter(season =>
              Number.isFinite(season) && season > 1
            )
        )
      ];

      // Fallback: AnimeSalt may place data-post/data-season
      // attributes in a different order.
      if (!seasonsToLoad.length) {
        const seasonAttrMatches = [
          ...detailResponse.data.matchAll(
            /data-season=["'](\d+)["']/gi
          )
        ];

        for (const match of seasonAttrMatches) {
          const season = Number(match[1]);

          if (
            Number.isFinite(season) &&
            season > 1 &&
            !seasonsToLoad.includes(season)
          ) {
            seasonsToLoad.push(season);
          }
        }
      }

      if (postId && seasonsToLoad.length) {
        for (const season of seasonsToLoad) {
          try {
            const ajaxUrl =
              "https://animesalt.cx/wp-admin/admin-ajax.php" +
              `?action=action_select_season&season=${season}&post=${postId}`;

            const ajaxResponse =
              await axios.get(ajaxUrl, {
                headers: {
                  "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                    "AppleWebKit/537.36 (KHTML, like Gecko) " +
                    "Chrome/120.0.0.0 Safari/537.36",
                  Accept:
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
                },
                timeout: 20000
              });

            const seasonEpisodes =
              parseEpisodeCards(
                ajaxResponse.data,
                season
              );

            for (const item of seasonEpisodes) {
              const key =
                `${item.season}:${item.episodeNumber}`;

              if (!episodeMap.has(key)) {
                episodeMap.set(key, item);
              }
            }

            console.log(
              `ANIMESALT SEASON ${season}: ${seasonEpisodes.length} episodes`
            );
          } catch (seasonError) {
            console.error(
              `ANIMESALT SEASON ${season} ERROR:`,
              seasonError.message
            );
          }
        }
      }

      episodeList = [...episodeMap.values()].sort((a, b) => {
        const seasonA = Number(a.season) || 0;
        const seasonB = Number(b.season) || 0;

        if (seasonA !== seasonB) {
          return seasonA - seasonB;
        }

        return (
          (Number(a.episodeNumber) || 0) -
          (Number(b.episodeNumber) || 0)
        );
      });

      if (episodeList.length) {
        episodes = episodeList.length;
      }

    } catch (detailError) {
      console.error(
        "ANIMESALT DETAIL ERROR:",
        detailError.message
      );
    }

    if (String(type).toLowerCase() === "movie") {
      description = String(description)
        .split(/Watch\/Download Links/i)[0]
        .split(/Winding Up/i)[0]
        .split(/Thanks for visiting/i)[0]
        .trim();
    }

    return res.json({
      success: true,
      anime: {
        slug,
        title,
        tmdbId: item.tmdbId ?? null,
        tmdbType: item.tmdbType || "",
        description,
        image,
        type,
        rating,
        seasons,
        episodes,
        genres,
        audio,
        languages,
        quality,
        status,
        released,
        duration,
        episodeList
      }
    });

  } catch (error) {
    console.error("ANIME ERROR:", error.message);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

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

      const normalizeCatalogSlug = value =>
        String(value || "")
          .normalize("NFKC")
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "");

      const normalizedSlug = normalizeCatalogSlug(slug);

      const catalogSlugAliases = {
        "oshi-no-ko": "【oshi-no-ko】"
      };

      const lookupSlug =
        catalogSlugAliases[slug.toLowerCase()] || slug;

      const normalizedLookupSlug = normalizeCatalogSlug(lookupSlug);

      const anime = catalog.find(item => {
        if (!item || !item.slug) return false;

        try {
          const itemSlug = String(item.slug);
          const decodedItemSlug = decodeURIComponent(itemSlug);

          return (
            normalizeCatalogSlug(itemSlug) === normalizedSlug ||
            normalizeCatalogSlug(decodedItemSlug) === normalizedSlug ||
            normalizeCatalogSlug(itemSlug) === normalizedLookupSlug ||
            normalizeCatalogSlug(decodedItemSlug) === normalizedLookupSlug
          );
        } catch {
          return (
            normalizeCatalogSlug(item.slug) === normalizedSlug ||
            normalizeCatalogSlug(item.slug) === normalizedLookupSlug
          );
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

