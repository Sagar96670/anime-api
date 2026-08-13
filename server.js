require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const cron = require("node-cron");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

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

    const envFile =
      path.join(__dirname, ".env");

    let env =
      fs.readFileSync(envFile, "utf8");

    if(/^ADMIN_PASSWORD=/m.test(env)){
      env = env.replace(
        /^ADMIN_PASSWORD=.*$/m,
        `ADMIN_PASSWORD=${newPassword}`
      );
    }else{
      env += `\nADMIN_PASSWORD=${newPassword}\n`;
    }

    fs.writeFileSync(
      envFile,
      env,
      {
        encoding:"utf8",
        mode:0o600
      }
    );

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
    const results = await syncCatalog();

    res.json({
      success: true,
      count: Array.isArray(results) ? results.length : 0
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

const { startAutoSync, syncCatalog } = require("./sync");
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


    res.json({
      success: true,
      anime: {
        slug,
        title,
        description,
        image,
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

