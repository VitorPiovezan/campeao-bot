import { spawn, execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { PassThrough, Readable } from "node:stream";
import { promisify } from "node:util";
import { Client, Events, GatewayIntentBits } from "discord.js";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
} from "@discordjs/voice";
import prism from "prism-media";

const execFileP = promisify(execFile);
const TOKEN = process.env.DISCORD_TOKEN;
const POT_URL = process.env.POT_PROVIDER_URL;
const GROQ_KEY = process.env.GROQ_API_KEY;
const COOKIES_FILE = "/data/cookies.txt";
const hasCookies = existsSync(COOKIES_FILE);
const YTDLP_BASE = [
  "--js-runtimes", "node",
  "--remote-components", "ejs:github",
  ...(hasCookies ? ["--cookies", COOKIES_FILE] : []),
  ...(POT_URL ? ["--extractor-args", `youtubepot-bgutilhttp:base_url=${POT_URL}`] : []),
];
const LOW_PRIO = ["--idle", "0", "nice", "-n", "19"];
const spawnLow = (cmd, args) => spawn("chrt", [...LOW_PRIO, cmd, ...args]);
const STT_URL = "http://127.0.0.1:5005/";
const WAKE_WORDS = ["campeao", "campiao", "capiao", "campeaum", "campeon"];
const ATTENTION_MS = 2500;
const DUCK_VOLUME = 0.15;
const DUCK_TIMEOUT_MS = 8000;
const BEEP_FILE = "/tmp/beep.pcm";
const CACHE_DIR = "/data/tracks";
const INFO_DIR = "/tmp/info";
const CACHE_MAX_FILES = 40;
const INFO_TTL_MS = 3 * 60 * 60 * 1000;
mkdirSync(CACHE_DIR, { recursive: true });
mkdirSync(INFO_DIR, { recursive: true });

const guilds = new Map();

function ensureBeep() {
  if (existsSync(BEEP_FILE)) return;
  execFileSync("ffmpeg", [
    "-f", "lavfi", "-i", "sine=frequency=740:duration=0.13",
    "-f", "lavfi", "-i", "sine=frequency=988:duration=0.13",
    "-filter_complex",
    "[0:a][1:a]concat=n=2:v=0:a=1,volume=0.35,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo",
    "-f", "s16le", "-y", BEEP_FILE,
  ], { stdio: "ignore" });
}

function getState(guildId) {
  if (!guilds.has(guildId)) {
    guilds.set(guildId, {
      guildId,
      connection: null,
      player: null,
      queue: [],
      current: null,
      currentResource: null,
      procs: [],
      textChannel: null,
      listening: new Set(),
      attention: new Map(),
      duckTimer: null,
      seqCounter: 0,
      recentEnqueued: new Map(),
      recentCommands: new Map(),
      hotUsers: new Map(),
      lastGateAt: new Map(),
      dead: false,
      radio: false,
      radioFilling: false,
      played: new Set(),
      vetoed: new Set(),
      lastActivity: Date.now(),
      guild: null,
      nowPlayingMessage: null,
    });
  }
  return guilds.get(guildId);
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

const isWakeWord = (w) => WAKE_WORDS.includes(w) || (w.length >= 6 && editDistance(w, "campeao") <= 2);

const PLAY_VERBS = ["toca", "tocar", "toque", "coloca", "colocar", "bota", "botar", "poe", "play", "manda", "mandar"];
const SKIP_VERBS = ["pula", "pular", "proxima", "passa", "passar", "skip", "next"];
const PAUSE_VERBS = ["pausa", "pausar", "pause"];
const RESUME_VERBS = ["continua", "continuar", "volta", "voltar", "despausa", "resume"];
const STOP_VERBS = ["para", "parar", "pare", "stop", "chega"];
const LEAVE_VERBS = ["sai", "sair", "vaza", "tchau", "xau", "embora"];
const matchVerb = (w, verbs) =>
  verbs.some((v) => w === v || (w.length >= 4 && v.length >= 4 && editDistance(w, v) <= 1));

const norm = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function killProcs(gs) {
  for (const p of gs.procs) {
    try { p.kill("SIGKILL"); } catch {}
  }
  gs.procs = [];
}

function parseSource(raw) {
  const m = raw.match(/\s+(?:no|na|do|da|em|pelo|pela)\s+(youtube|you tube|iutubi|soundcloud|sound cloud|saundclaud|deezer|dizer|diser|spotify|spotifai)$/);
  if (!m) return { query: raw, source: "auto" };
  const word = m[1].replace(/\s/g, "");
  const source = word.startsWith("sound") || word.startsWith("saund")
    ? "soundcloud"
    : word.startsWith("you") || word.startsWith("iutu")
      ? "youtube"
      : "deezer";
  return { query: raw.slice(0, m.index).trim(), source };
}

async function deezerLookup(query) {
  try {
    const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=1`, {
      signal: AbortSignal.timeout(8000),
    });
    const track = (await res.json()).data?.[0];
    if (!track?.title) return null;
    return {
      artist: track.artist?.name ?? "",
      title: track.title,
      label: `${track.artist?.name} - ${track.title}`,
      duration: track.duration || null,
      cover: track.album?.cover_big ?? null,
    };
  } catch (e) {
    console.log("[deezer] erro:", e.message);
    return null;
  }
}

async function runYtdlp(args, opts = {}) {
  try {
    const { stdout } = await execFileP("chrt", [...LOW_PRIO, "yt-dlp", ...YTDLP_BASE, ...args], {
      timeout: 60000,
      maxBuffer: 64 * 1024 * 1024,
      ...opts,
    });
    return stdout;
  } catch (e) {
    if (e.stdout?.trim()) return e.stdout;
    throw e;
  }
}

const PRINT_FULL = ["--print", "%(title)s\t%(webpage_url)s\t%(channel)s\t%(duration)s\t%(thumbnail)s"];
const PRINT_FLAT = ["--print", "%(title)s\t%(url)s\t%(channel)s\t%(duration)s\t%(thumbnail)s"];

function parseCandidates(stdout) {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [title, url, channel, duration, thumbnail] = line.split("\t");
      return {
        title,
        url,
        channel: channel === "NA" ? "" : (channel ?? ""),
        duration: Number.parseFloat(duration) || null,
        thumbnail: thumbnail && thumbnail !== "NA" ? thumbnail : null,
      };
    })
    .filter((c) => c.url);
}

const REMIX_WORDS = [
  "remix", "slowed", "reverb", "sped up", "speed up", "nightcore", "8d",
  "cover", "karaoke", "instrumental", "live", "ao vivo", "mashup",
  "bass boost", "loop", "1 hour", "10 hour", "tiktok",
];

function scoreCandidate(c, want, opts = {}) {
  let score = 0;
  const title = norm(c.title ?? "");
  const channel = norm(c.channel ?? "");
  const query = norm(want.query);
  if (channel.endsWith("topic")) score += 5;
  if (channel.includes("vevo")) score += 4;
  if (channel.length >= 4 && query.includes(channel)) score += 2;
  if (!opts.soundcloud && /\b(official|oficial)\b/.test(title)) score += 2;
  if (/tiktok|\d{4,}/.test(channel)) score -= 3;
  for (const w of REMIX_WORDS) {
    if (title.includes(w) && !query.includes(w)) score -= 4;
  }
  if (want.duration && c.duration) {
    const diff = Math.abs(c.duration - want.duration);
    if (diff <= 5) score += 6;
    else if (diff <= 15) score += 3;
    else if (diff > 25) score -= 8;
  }
  for (const w of query.split(" ")) {
    if (w.length >= 3 && title.includes(w)) score += 0.5;
  }
  return score;
}

const shortErr = (e) => (e.stderr || e.message || "").toString().replace(/\s+/g, " ").slice(0, 250);

async function resolveTrack(query, source = "auto") {
  if (/^https?:\/\//.test(query)) {
    try {
      const c = parseCandidates(await runYtdlp(["--no-playlist", "-f", "bestaudio/best", ...PRINT_FULL, query]))[0];
      return c
        ? { title: c.title, url: c.url, source: "url", thumb: c.thumbnail, duration: c.duration, resolvedAt: Date.now() }
        : null;
    } catch (e) {
      console.log(`[busca] url falhou: ${shortErr(e)}`);
      return null;
    }
  }
  let forcedTitle = null;
  let dzMeta = null;
  let want = { query, duration: null };
  if (source !== "youtube" && source !== "soundcloud") {
    dzMeta = await deezerLookup(query);
    if (dzMeta) {
      forcedTitle = dzMeta.label;
      want = { query: `${dzMeta.artist} ${dzMeta.title}`, duration: dzMeta.duration };
      console.log(`[busca] deezer refinou: "${query}" -> "${want.query}" (${dzMeta.duration}s)`);
    }
  }
  if (source !== "soundcloud") {
    try {
      const flat = parseCandidates(await runYtdlp(["-i", "--flat-playlist", ...PRINT_FLAT, `ytsearch6:${want.query}`]))
        .map((c) => ({ ...c, score: scoreCandidate(c, want) }))
        .sort((a, b) => b.score - a.score);
      console.log(`[busca] youtube: ${flat.map((c) => `${c.score.toFixed(1)} ${c.title?.slice(0, 45)}`).join(" | ")}`);
      for (const cand of flat.slice(0, 3)) {
        try {
          const raw = await runYtdlp(["--no-playlist", "-f", "bestaudio/best", "-J", cand.url]);
          const info = JSON.parse(raw.trim().split("\n").filter(Boolean)[0]);
          if (info?.webpage_url) {
            const infoFile = `${INFO_DIR}/${cacheKey(info.webpage_url)}.info.json`;
            writeFileSync(infoFile, JSON.stringify(info));
            pruneInfo();
            return {
              title: forcedTitle ?? info.title,
              url: info.webpage_url,
              source: "youtube",
              thumb: dzMeta?.cover ?? info.thumbnail,
              duration: dzMeta?.duration ?? info.duration,
              infoFile,
              resolvedAt: Date.now(),
            };
          }
        } catch (e) {
          const err = shortErr(e);
          console.log(`[busca] validação falhou: ${err}`);
          if (/sign in|not a bot/i.test(err)) break;
        }
      }
    } catch (e) {
      console.log(`[busca] youtube falhou: ${shortErr(e)}`);
    }
  }
  if (source !== "youtube") {
    try {
      const candidates = parseCandidates(await runYtdlp(["-i", "-f", "bestaudio/best", ...PRINT_FULL, `scsearch5:${want.query}`]))
        .map((c) => ({ ...c, score: scoreCandidate(c, want, { soundcloud: true }) }))
        .sort((a, b) => b.score - a.score);
      const best = candidates[0];
      if (best) {
        console.log(`[busca] soundcloud: ${candidates.map((c) => `${c.score.toFixed(1)} ${c.title?.slice(0, 45)}`).join(" | ")}`);
        return {
          title: forcedTitle ?? best.title,
          url: best.url,
          source: "soundcloud",
          thumb: dzMeta?.cover ?? best.thumbnail,
          duration: dzMeta?.duration ?? best.duration,
          resolvedAt: Date.now(),
        };
      }
    } catch (e) {
      console.log(`[busca] soundcloud falhou: ${shortErr(e)}`);
    }
  }
  return null;
}

const cacheKey = (url) => createHash("sha1").update(url).digest("hex").slice(0, 16);

function cacheLookup(url) {
  const key = cacheKey(url);
  const found = readdirSync(CACHE_DIR).find((f) => f.startsWith(key) && !f.endsWith(".part"));
  return found ? `${CACHE_DIR}/${found}` : null;
}

function cacheCleanPartials(url) {
  const key = cacheKey(url);
  for (const f of readdirSync(CACHE_DIR)) {
    if (f.startsWith(key) && (f.endsWith(".part") || f.includes(".part-"))) {
      try { rmSync(`${CACHE_DIR}/${f}`, { force: true }); } catch {}
    }
  }
}

function cacheEvict() {
  const files = readdirSync(CACHE_DIR)
    .filter((f) => !f.endsWith(".part"))
    .map((f) => {
      const st = statSync(`${CACHE_DIR}/${f}`);
      return st.isFile() ? { f, t: st.mtimeMs } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
  for (const { f } of files.slice(0, Math.max(0, files.length - CACHE_MAX_FILES))) {
    try { rmSync(`${CACHE_DIR}/${f}`, { force: true }); } catch {}
    console.log(`[cache] removido: ${f}`);
  }
}

function dropTrackFile(track) {
  if (track?.prefetchProc) {
    try { track.prefetchProc.kill("SIGKILL"); } catch {}
    track.prefetchProc = null;
    if (track.url) cacheCleanPartials(track.url);
  }
}

function pruneInfo() {
  for (const f of readdirSync(INFO_DIR)) {
    try {
      if (Date.now() - statSync(`${INFO_DIR}/${f}`).mtimeMs > INFO_TTL_MS) rmSync(`${INFO_DIR}/${f}`, { force: true });
    } catch {}
  }
}

function infoFresh(track) {
  return track.infoFile && existsSync(track.infoFile) && Date.now() - (track.resolvedAt ?? 0) < INFO_TTL_MS;
}

const sourceArgs = (track) =>
  infoFresh(track) ? ["--load-info-json", track.infoFile] : ["--no-playlist", track.url];

function prefetch(track, tag = "preload") {
  const hit = cacheLookup(track.url);
  if (hit) {
    track.file = hit;
    console.log(`[${tag}] já em cache: ${track.title}`);
    return;
  }
  if (track.prefetchProc) return;
  const key = cacheKey(track.url);
  const proc = spawnLow("yt-dlp", [
    ...YTDLP_BASE, "-f", "bestaudio/best", "-q",
    "-o", `${CACHE_DIR}/${key}.%(ext)s`, ...sourceArgs(track),
  ]);
  track.prefetchProc = proc;
  proc.on("error", () => {});
  proc.on("exit", (code) => {
    track.prefetchProc = null;
    if (code === null) return;
    const done = code === 0 ? cacheLookup(track.url) : null;
    if (done) {
      track.file = done;
      cacheEvict();
      console.log(`[${tag}] pronto: ${track.title}`);
    } else {
      cacheCleanPartials(track.url);
      console.log(`[${tag}] falhou (${code}): ${track.title}`);
    }
  });
}

const FF_FAST = ["-analyzeduration", "0", "-probesize", "500K"];
const FF_OUT = ["-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"];
const JITTER_BYTES = 20 * 48000 * 2 * 2;

function startPlayback(gs, track, mode) {
  killProcs(gs);
  let ff;
  if (mode === "cache") {
    console.log(`[player] tocando (cache): ${track.title}`);
    ff = spawn("ffmpeg", ["-loglevel", "quiet", ...FF_FAST, "-i", track.file, ...FF_OUT]);
    gs.procs = [ff];
  } else {
    const reusing = mode === "info" && infoFresh(track);
    console.log(`[player] tocando (${reusing ? "info reaproveitado" : "extração completa"}): ${track.title}`);
    const args = reusing ? ["--load-info-json", track.infoFile] : ["--no-playlist", track.url];
    const ytdlp = spawn("yt-dlp", [...YTDLP_BASE, "-f", "bestaudio/best", "-q", "-o", "-", ...args]);
    ff = spawn("ffmpeg", ["-loglevel", "quiet", "-i", "pipe:0", ...FF_OUT]);
    ytdlp.stderr.on("data", (d) => console.log(`[yt-dlp] ${d.toString().trim().slice(0, 200)}`));
    ytdlp.stdout.pipe(ff.stdin);
    ff.stdin.on("error", () => {});
    ytdlp.on("error", (e) => console.log("[yt-dlp] erro:", e.message));
    gs.procs = [ytdlp, ff];
    prefetch(track, "cache");
  }
  ff.on("error", (e) => console.log("[ffmpeg] erro:", e.message));
  const jitter = new PassThrough({ highWaterMark: JITTER_BYTES });
  jitter.on("error", () => {});
  ff.stdout.pipe(jitter);
  const resource = createAudioResource(jitter, { inputType: StreamType.Raw, inlineVolume: true });
  gs.currentResource = resource;
  gs.player.play(resource);
}

function playNext(gs) {
  killProcs(gs);
  unduck(gs);
  const next = gs.queue.shift();
  gs.current = next ?? null;
  gs.currentResource = null;
  if (!next) {
    if (gs.radio) radioFill(gs, true);
    return;
  }
  gs.played.add(next.url);
  gs.lastActivity = Date.now();
  const cached = next.file && existsSync(next.file) ? next.file : cacheLookup(next.url);
  if (cached) next.file = cached;
  startPlayback(gs, next, cached ? "cache" : "info");
  sendNowPlaying(gs, next);
  if (gs.radio && gs.queue.length === 0) radioFill(gs, false);
}

const videoIdOf = (url) => url?.match(/[?&]v=([\w-]{11})/)?.[1] ?? null;

function radioSeed(gs) {
  const url = [gs.current?.url, ...[...gs.played].reverse()].filter(Boolean).find(videoIdOf);
  return url ? { url } : null;
}

async function radioFill(gs, playNow) {
  if (!gs.radio || gs.radioFilling || gs.dead) return;
  const seed = radioSeed(gs);
  if (!seed) return;
  gs.radioFilling = true;
  try {
    const id = videoIdOf(seed.url);
    const mix = parseCandidates(
      await runYtdlp(["-i", "--flat-playlist", "--playlist-end", "30", ...PRINT_FLAT, `https://www.youtube.com/watch?v=${id}&list=RD${id}`]),
    );
    const pick = mix.find((c) => {
      const t = norm(c.title ?? "");
      if (!c.url || gs.played.has(c.url) || gs.queue.some((q) => q.url === c.url)) return false;
      if ([...gs.vetoed].some((v) => t.includes(v))) return false;
      return !REMIX_WORDS.some((w) => t.includes(w));
    });
    if (!pick) {
      console.log("[radio] nenhuma sugestão nova no mix");
      return;
    }
    console.log(`[radio] sugestão: ${pick.title}`);
    const track = {
      title: pick.title,
      url: pick.url,
      source: "youtube",
      thumb: pick.thumbnail,
      duration: pick.duration,
      by: "Rádio",
      radio: true,
      seq: ++gs.seqCounter,
    };
    gs.queue.push(track);
    prefetch(track, "radio");
    if (playNow && !gs.current) playNext(gs);
  } catch (e) {
    console.log(`[radio] falhou: ${shortErr(e)}`);
  } finally {
    gs.radioFilling = false;
  }
}

const GOLD = 0xd4a017;
const GRAY = 0x4f545c;
const SOURCE_NAMES = { youtube: "YouTube", soundcloud: "SoundCloud", url: "Link direto" };

const fmtDur = (s) =>
  s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : null;

function nowPlayingEmbed(track) {
  const fields = [
    { name: track.radio ? "Sugestão do rádio" : "Pedido por", value: track.by, inline: true },
    { name: "Fonte", value: SOURCE_NAMES[track.source] ?? "—", inline: true },
  ];
  const dur = fmtDur(track.duration);
  if (dur) fields.push({ name: "Duração", value: dur, inline: true });
  return {
    author: { name: track.radio ? "Tocando agora · Rádio" : "Tocando agora" },
    title: track.title,
    url: track.url,
    color: track.radio ? 0x5865f2 : GOLD,
    thumbnail: track.thumb ? { url: track.thumb } : undefined,
    fields,
    footer: { text: "Campeão" },
  };
}

const BTN = { PRIMARY: 1, SECONDARY: 2, DANGER: 4 };

function controlRows(gs) {
  const paused = gs.player?.state?.status === AudioPlayerStatus.Paused;
  return [
    {
      type: 1,
      components: [
        { type: 2, style: BTN.SECONDARY, custom_id: "cmp:pause", label: paused ? "Retomar" : "Pausar" },
        { type: 2, style: BTN.SECONDARY, custom_id: "cmp:skip", label: "Pular" },
        { type: 2, style: BTN.SECONDARY, custom_id: "cmp:veto", label: "Não curti" },
        { type: 2, style: BTN.DANGER, custom_id: "cmp:stop", label: "Parar" },
      ],
    },
    {
      type: 1,
      components: [
        { type: 2, style: gs.radio ? BTN.PRIMARY : BTN.SECONDARY, custom_id: "cmp:radio", label: gs.radio ? "Rádio ligado" : "Ligar rádio" },
        { type: 2, style: BTN.SECONDARY, custom_id: "cmp:queue", label: "Ver fila" },
      ],
    },
  ];
}

async function sendNowPlaying(gs, track) {
  const previous = gs.nowPlayingMessage;
  gs.nowPlayingMessage = null;
  if (previous) previous.edit({ components: [] }).catch(() => {});
  try {
    gs.nowPlayingMessage = await gs.textChannel?.send({ embeds: [nowPlayingEmbed(track)], components: controlRows(gs) });
  } catch (e) {
    console.log("[discord] falha ao enviar card:", e.message);
  }
}

function refreshControls(gs) {
  gs.nowPlayingMessage?.edit({ components: controlRows(gs) }).catch(() => {});
}

function queueText(gs) {
  const lines = [
    gs.current ? `**Agora** · [${gs.current.title}](${gs.current.url})` : "Nada tocando.",
    ...gs.queue.map((t, i) => `**${i + 1}** · ${t.title}${t.radio ? " · rádio" : ""}`),
  ];
  return lines.join("\n").slice(0, 1900);
}

function queuedEmbed(track, position) {
  return {
    description: `**Na fila #${position}** · [${track.title}](${track.url}) · pedido por ${track.by}`,
    color: GRAY,
    thumbnail: track.thumb ? { url: track.thumb } : undefined,
  };
}

function playBeep(gs) {
  if (gs.current) {
    duck(gs);
    return;
  }
  try {
    const resource = createAudioResource(Readable.from([readFileSync(BEEP_FILE)]), {
      inputType: StreamType.Raw,
    });
    gs.player.play(resource);
  } catch (e) {
    console.log("[beep] falhou:", e.message);
  }
}

function duck(gs) {
  if (!gs.currentResource?.volume) return;
  gs.currentResource.volume.setVolume(DUCK_VOLUME);
  if (gs.duckTimer) clearTimeout(gs.duckTimer);
  gs.duckTimer = setTimeout(() => unduck(gs), DUCK_TIMEOUT_MS);
}

function unduck(gs) {
  if (gs.duckTimer) clearTimeout(gs.duckTimer);
  gs.duckTimer = null;
  gs.currentResource?.volume?.setVolume(1);
}

async function enqueue(gs, rawQuery, by) {
  const { query, source } = parseSource(rawQuery);
  const seq = ++gs.seqCounter;
  const track = await resolveTrack(query, source);
  if (!track) {
    gs.textChannel?.send(`-# Nada encontrado para “${query}”`).catch(() => {});
    return;
  }
  track.by = by;
  track.seq = seq;
  const recentTs = gs.recentEnqueued.get(track.url);
  const isDupe =
    gs.current?.url === track.url ||
    gs.queue.some((t) => t.url === track.url) ||
    (recentTs && Date.now() - recentTs < 60000);
  if (isDupe) {
    console.log(`[fila] duplicata ignorada: ${track.title}`);
    return;
  }
  gs.recentEnqueued.set(track.url, Date.now());
  if (gs.recentEnqueued.size > 50) {
    const oldest = gs.recentEnqueued.keys().next().value;
    gs.recentEnqueued.delete(oldest);
  }
  const idx = gs.queue.findIndex((t) => t.seq > seq);
  if (idx === -1) gs.queue.push(track);
  else gs.queue.splice(idx, 0, track);
  if (gs.player.state.status === AudioPlayerStatus.Idle || !gs.current) {
    playNext(gs);
  } else {
    prefetch(track);
    gs.textChannel?.send({ embeds: [queuedEmbed(track, gs.queue.indexOf(track) + 1)] }).catch(() => {});
  }
}

function stopAll(gs) {
  for (const t of [gs.current, ...gs.queue]) dropTrackFile(t);
  gs.queue = [];
  gs.current = null;
  gs.currentResource = null;
  killProcs(gs);
  unduck(gs);
  gs.player.stop();
  gs.nowPlayingMessage?.edit({ components: [] }).catch(() => {});
  gs.nowPlayingMessage = null;
}

function setRadio(gs, on, by) {
  gs.radio = on;
  gs.lastActivity = Date.now();
  if (on) {
    gs.textChannel?.send(`-# Rádio ligado por ${by} — quando a fila acabar eu sigo tocando parecidas`).catch(() => {});
    if (!gs.current) radioFill(gs, true);
    else if (gs.queue.length === 0) radioFill(gs, false);
  } else {
    gs.queue = gs.queue.filter((t) => !t.radio);
    gs.textChannel?.send(`-# Rádio desligado por ${by}`).catch(() => {});
  }
}

function vetoCurrent(gs, by) {
  const cur = gs.current;
  if (!cur) return;
  const key = norm(cur.title).split(" ").slice(0, 3).join(" ");
  if (key) gs.vetoed.add(key);
  gs.textChannel?.send(`-# ${by} vetou **${cur.title}** — não repito nesta sessão`).catch(() => {});
  playNext(gs);
}

function humansInChannel(gs) {
  try {
    const chId = gs.connection?.joinConfig?.channelId;
    const ch = gs.guild?.channels?.cache?.get(chId);
    return ch ? ch.members.filter((m) => !m.user.bot).size : 1;
  } catch {
    return 1;
  }
}

const IDLE_MS = 5 * 60 * 1000;
const EMPTY_MS = 60 * 1000;

function checkIdle(gs) {
  if (gs.dead) return;
  const alone = humansInChannel(gs) === 0;
  if (alone) {
    gs.emptySince ??= Date.now();
    if (Date.now() - gs.emptySince > EMPTY_MS) {
      gs.textChannel?.send("-# Canal vazio, saindo").catch(() => {});
      console.log("[idle] canal vazio, saindo");
      leave(gs);
    }
    return;
  }
  gs.emptySince = null;
  const idle = !gs.current && Date.now() - gs.lastActivity > IDLE_MS;
  if (idle) {
    gs.textChannel?.send("-# 5 minutos sem música e sem comando, vou nessa. Chame com `!entra`").catch(() => {});
    console.log("[idle] ocioso 5min, saindo");
    leave(gs);
  }
}

function teardown(gs) {
  if (gs.idleTimer) clearInterval(gs.idleTimer);
  gs.nowPlayingMessage?.edit({ components: [] }).catch(() => {});
  gs.nowPlayingMessage = null;
  if (guilds.get(gs.guildId) === gs) guilds.delete(gs.guildId);
  gs.dead = true;
  try {
    for (const t of [gs.current, ...gs.queue]) dropTrackFile(t);
    gs.queue = [];
    gs.current = null;
    killProcs(gs);
    gs.player?.stop();
  } catch {}
  try {
    if (gs.connection && gs.connection.state.status !== "destroyed") gs.connection.destroy();
  } catch {}
}

function leave(gs) {
  teardown(gs);
}

function to16kMono(pcm) {
  const frames = Math.floor(pcm.length / 4);
  const out = Buffer.alloc(Math.floor(frames / 3) * 2);
  let o = 0;
  for (let i = 0; i + 2 < frames; i += 3) {
    const l = pcm.readInt16LE(i * 4);
    const r = pcm.readInt16LE(i * 4 + 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, (l + r) >> 1)), o);
    o += 2;
  }
  return out;
}

let sttPending = 0;

function wavFrom(pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const groqHits = [];
function groqSlotFree() {
  const cutoff = Date.now() - 60000;
  while (groqHits.length && groqHits[0] < cutoff) groqHits.shift();
  return groqHits.length < 18;
}

async function groqTranscribe(pcm) {
  groqHits.push(Date.now());
  const fd = new FormData();
  fd.append("file", new Blob([wavFrom(pcm)], { type: "audio/wav" }), "audio.wav");
  fd.append("model", "whisper-large-v3-turbo");
  fd.append("language", "pt");
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${GROQ_KEY}` },
    body: fd,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    console.log("[stt] groq resposta", res.status, (await res.text()).slice(0, 120));
    if (res.status === 429 || res.status >= 500) return localTranscribe(pcm);
    return null;
  }
  return ((await res.json()).text ?? "").trim() || null;
}

async function localTranscribe(pcm, path = "") {
  try {
    const res = await fetch(`${STT_URL}${path.replace(/^\//, "")}`, {
      method: "POST",
      body: pcm,
      headers: { "content-type": "application/octet-stream" },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.log("[stt] local resposta", res.status);
      return null;
    }
    return (await res.json()).text;
  } catch (e) {
    console.log("[stt] local erro:", e.message);
    return null;
  }
}

async function transcribe(pcm, priority = false) {
  const limit = GROQ_KEY ? 4 : 1;
  if (!priority && sttPending >= limit) {
    console.log("[stt] ocupado, descartando fala");
    return null;
  }
  sttPending++;
  const startedAt = Date.now();
  try {
    if (!GROQ_KEY) return await localTranscribe(pcm);
    if (!groqSlotFree()) {
      console.log("[stt] cota da groq no limite, usando whisper local");
      return await localTranscribe(pcm);
    }
    return await groqTranscribe(pcm);
  } catch (e) {
    console.log("[stt] erro:", e.message);
    return null;
  } finally {
    gateStats.groqMs.push(Date.now() - startedAt);
    sttPending--;
  }
}

const GATE_SECONDS = 1.5;
const GATE_CONCURRENCY = 1;
const RESUBSCRIBE_COOLDOWN_MS = 1500;
const GATE_QUEUE_TIMEOUT_MS = 2500;
const GATE_MIN_INTERVAL_MS = 1200;
const GATE_MIN_INTERVAL_BUSY_MS = 3000;
const HOT_USER_MS = 60000;
const MAX_UTTERANCE_SECONDS = 8;
const COMMAND_MAX_SECONDS = 8;
const gateStats = { pass: 0, block: 0, busy: 0, throttled: 0, gateMs: [], groqMs: [] };

const sliceSeconds = (pcm, seconds) =>
  pcm.subarray(0, Math.min(pcm.length, Math.floor(seconds * 48000) * 4));

const avg = (list) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : 0);

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  acquire(timeoutMs) {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiter = {};
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(false);
      }, timeoutMs);
      waiter.grant = () => {
        clearTimeout(waiter.timer);
        this.active++;
        resolve(true);
      };
      this.waiters.push(waiter);
    });
  }

  release() {
    this.active--;
    this.waiters.shift()?.grant();
  }

  get saturated() {
    return this.active >= this.limit;
  }
}

const gateSem = new Semaphore(GATE_CONCURRENCY);

function gateAllowed(gs, userId) {
  const minInterval = gateSem.saturated ? GATE_MIN_INTERVAL_BUSY_MS : GATE_MIN_INTERVAL_MS;
  const last = gs.lastGateAt.get(userId) ?? 0;
  if (Date.now() - last < minInterval) return false;
  gs.lastGateAt.set(userId, Date.now());
  return true;
}

const GATE_STOP = new Set([
  "campo", "campos", "campanha", "compra", "comprar", "comprei", "compras", "compro",
  "compilei", "compilar", "compila", "computador", "companhia", "comparar", "compara",
  "completo", "completa", "completou", "complicado", "compromisso", "competir",
  "competencia", "comportamento", "comprido", "compreendi", "compreender", "compensa",
  "componente", "composto", "comprovar", "campeonato",
]);

function gateHasWake(text) {
  const t = norm(text ?? "");
  if (!t) return false;
  return t.split(" ").some((w) => {
    if (GATE_STOP.has(w)) return false;
    if (/peao|piao/.test(w)) return true;
    if (/^(c[ao]mp|kamp)/.test(w)) return true;
    return w.length >= 5 && editDistance(w, "campeao") <= 3;
  });
}

async function gateWake(pcm16, who) {
  const queuedAt = Date.now();
  const slot = await gateSem.acquire(GATE_QUEUE_TIMEOUT_MS);
  if (!slot) {
    gateStats.busy++;
    console.log(`[gate] ${who}: fila cheia por ${GATE_QUEUE_TIMEOUT_MS}ms, fala descartada`);
    return false;
  }
  const waited = Date.now() - queuedAt;
  try {
    const startedAt = Date.now();
    const text = await localTranscribe(pcm16, "/gate");
    gateStats.gateMs.push(Date.now() - startedAt + waited);
    const ok = gateHasWake(text);
    if (ok) {
      gateStats.pass++;
      console.log(
        `[gate] ${who}: passou em ${Date.now() - queuedAt}ms${waited > 50 ? ` (fila ${waited}ms)` : ""} ("${(text ?? "").trim().slice(0, 40)}")`
      );
    } else {
      gateStats.block++;
    }
    return ok;
  } catch (e) {
    console.log("[gate] erro, deixando passar:", e.message);
    return true;
  } finally {
    gateSem.release();
  }
}

const LOOP_TICK_MS = 50;
const LOOP_STALL_MS = 40;
const loopLag = { max: 0, sum: 0, stalls: 0, ticks: 0 };
let loopLastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = now - loopLastTick - LOOP_TICK_MS;
  loopLastTick = now;
  loopLag.ticks++;
  if (lag <= 0) return;
  loopLag.sum += lag;
  if (lag > loopLag.max) loopLag.max = lag;
  if (lag >= LOOP_STALL_MS) loopLag.stalls++;
}, LOOP_TICK_MS).unref();

setInterval(() => {
  if (loopLag.ticks > 0) {
    console.log(
      `[loop] 5min: lag médio ${(loopLag.sum / loopLag.ticks).toFixed(1)}ms, máx ${loopLag.max}ms, ` +
        `${loopLag.stalls} travadas acima de ${LOOP_STALL_MS}ms`
    );
    loopLag.max = 0;
    loopLag.sum = 0;
    loopLag.stalls = 0;
    loopLag.ticks = 0;
  }
  const { pass, block, busy, throttled, gateMs, groqMs } = gateStats;
  if (pass + block + busy + throttled > 0) {
    console.log(
      `[gate] 5min: ${pass} p/ groq, ${block} barradas, ${throttled} throttled, ${busy} perdidas na fila ` +
        `| porteiro ${avg(gateMs)}ms (máx ${Math.max(0, ...gateMs)}ms) | groq ${avg(groqMs)}ms`
    );
    gateStats.pass = 0;
    gateStats.block = 0;
    gateStats.busy = 0;
    gateStats.throttled = 0;
    gateStats.gateMs = [];
    gateStats.groqMs = [];
  }
}, 5 * 60 * 1000);

function captureUtterance(gs, userId) {
  if (gs.dead || guilds.get(gs.guildId) !== gs) return;
  if (gs.listening.has(userId)) return;
  const user = client.users.cache.get(userId);
  if (user?.bot) return;
  gs.listening.add(userId);
  const startedAt = Date.now();
  const opus = gs.connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 600 },
  });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const chunks = [];
  let bytes = 0;
  let aborted = false;
  opus.pipe(decoder);
  decoder.on("data", (c) => {
    if (aborted) return;
    bytes += c.length;
    if (bytes > MAX_UTTERANCE_SECONDS * 48000 * 2 * 2) {
      aborted = true;
      chunks.length = 0;
      console.log(`[voz] fala passou de ${MAX_UTTERANCE_SECONDS}s, cortando captura`);
      opus.destroy();
      decoder.destroy();
      setTimeout(() => gs.listening.delete(userId), RESUBSCRIBE_COOLDOWN_MS);
      return;
    }
    chunks.push(c);
  });
  const cleanup = (e) => {
    if (e) console.log("[voz] erro no stream:", e.message);
    if (!aborted) gs.listening.delete(userId);
  };
  decoder.on("end", async () => {
    gs.listening.delete(userId);
    const pcm = Buffer.concat(chunks);
    const secs = pcm.length / (48000 * 2 * 2);
    if (secs < 0.6) return;
    const finishedAt = Date.now();
    const attentive = (gs.attention.get(userId) ?? 0) > startedAt;
    if (attentive) playBeep(gs);
    const hot = (gs.hotUsers.get(userId) ?? 0) > Date.now();
    const priority = attentive || hot;
    const who = user?.username ?? userId;

    if (!priority && GROQ_KEY) {
      if (!gateAllowed(gs, userId)) {
        gateStats.throttled++;
        return;
      }
      const head = to16kMono(sliceSeconds(pcm, GATE_SECONDS));
      if (!(await gateWake(head, who))) return;
    }

    const pcm16 = to16kMono(sliceSeconds(pcm, COMMAND_MAX_SECONDS));
    const text = await transcribe(pcm16, priority);
    console.log(`[stt] ${who}${hot && !attentive ? " (atalho)" : ""}: "${text}" [${Date.now() - finishedAt}ms]`);
    if (text) handleVoice(gs, userId, text, startedAt);
  });
  decoder.on("error", cleanup);
  opus.on("error", cleanup);
}

function handleVoice(gs, userId, raw, startedAt) {
  if (gs.dead || guilds.get(gs.guildId) !== gs) return;
  const text = norm(raw);
  if (!text) return;
  const dupeKey = `${userId}:${text}`;
  if (Date.now() - (gs.recentCommands.get(dupeKey) ?? 0) < 6000) {
    console.log(`[wake] comando repetido ignorado: "${text}"`);
    return;
  }
  gs.recentCommands.set(dupeKey, Date.now());
  if (gs.recentCommands.size > 40) gs.recentCommands.delete(gs.recentCommands.keys().next().value);
  const words = text.split(" ");
  const wakeIdx = words.findIndex(isWakeWord);
  const attentive = (gs.attention.get(userId) ?? 0) > startedAt;
  let rest;
  if (wakeIdx !== -1 && wakeIdx <= 4) {
    rest = words.slice(wakeIdx + 1).join(" ");
  } else if (attentive) {
    rest = text;
  } else {
    return;
  }
  gs.attention.delete(userId);
  gs.lastActivity = Date.now();
  gs.hotUsers.set(userId, Date.now() + HOT_USER_MS);
  console.log(`[wake] comando: "${rest}"`);
  const mention = `<@${userId}>`;

  if (rest === "" || /^(oi|ola|fala|ei)$/.test(rest)) {
    gs.attention.set(userId, Date.now() + ATTENTION_MS);
    playBeep(gs);
    return;
  }


  const restWords = rest.split(" ").filter((w) => !["ai", "ei", "vai", "ow", "o"].includes(w));
  const head = restWords[0] ?? "";
  const tail = restWords.slice(1).join(" ");
  const mentionsRadio = restWords.length <= 2 && restWords.some((w) => matchVerb(w, ["radio"]));

  if (mentionsRadio) {
    const off = ["para", "parar", "desliga", "desligar", "tira", "encerra", "cancela"].some((v) => matchVerb(head, [v]));
    setRadio(gs, !off, mention);
    return;
  }
  if (/^(essa|esta|essa nao|nao gostei|tira essa|veta|odeio)/.test(rest) && /(nao|gostei|tira|veta|odeio)/.test(rest)) {
    vetoCurrent(gs, mention);
    return;
  }

  if (matchVerb(head, PLAY_VERBS)) {
    const query = tail
      .replace(/^(a musica |o som |a |um |uma )/, "")
      .replace(/\s+(ai|por favor|pra mim|pra gente|rapidao|agora)$/, "")
      .trim();
    if (!query) return;
    unduck(gs);
    gs.textChannel?.send(`-# ${mention} pediu “${query}” — buscando…`).catch(() => {});
    enqueue(gs, query, mention);
    return;
  }
  if (matchVerb(head, SKIP_VERBS)) {
    unduck(gs);
    gs.textChannel?.send(`-# Pulada por ${mention}`).catch(() => {});
    playNext(gs);
    return;
  }
  if (matchVerb(head, PAUSE_VERBS)) {
    gs.player.pause();
    gs.textChannel?.send(`-# Pausada por ${mention}`).catch(() => {});
    refreshControls(gs);
    return;
  }
  if (matchVerb(head, RESUME_VERBS)) {
    unduck(gs);
    gs.player.unpause();
    gs.textChannel?.send(`-# Retomada por ${mention}`).catch(() => {});
    refreshControls(gs);
    return;
  }
  if (matchVerb(head, STOP_VERBS) || /^cala/.test(head)) {
    stopAll(gs);
    gs.textChannel?.send(`-# Parada por ${mention} — fila limpa`).catch(() => {});
    return;
  }
  if (LEAVE_VERBS.includes(head)) {
    gs.textChannel?.send(`Até mais! Dispensado por ${mention}.`).catch(() => {});
    leave(gs);
    return;
  }
  if (wakeIdx !== -1) {
    gs.textChannel?.send(`-# Entendi “${rest}” — comando desconhecido`).catch(() => {});
  }
  console.log(`[wake] não entendi: "${rest}"`);
}

function joinFor(member, channel) {
  const gs = getState(member.guild.id);
  gs.textChannel = channel;
  if (gs.connection) return gs;
  const voice = member.voice.channel;
  if (!voice) return null;
  const zombie = getVoiceConnection(member.guild.id);
  if (zombie) {
    console.log("[voz] destruindo conexão órfã antes de entrar");
    try { zombie.destroy(); } catch {}
  }
  gs.connection = joinVoiceChannel({
    channelId: voice.id,
    guildId: member.guild.id,
    adapterCreator: member.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  gs.connection.on("stateChange", (oldS, newS) => {
    if (oldS.status === newS.status) return;
    console.log(`[voz] conexão: ${oldS.status} -> ${newS.status}`);
    if (newS.status === "destroyed" || newS.status === "disconnected") {
      teardown(gs);
    }
  });
  gs.connection.on("error", (e) => console.log("[voz] erro de conexão:", e.message));
  gs.player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 50 },
  });
  gs.connection.subscribe(gs.player);
  gs.player.on(AudioPlayerStatus.Idle, (oldState) => {
    if (oldState.resource !== gs.currentResource) return;
    const cur = gs.current;
    if (cur && !cur.retried && (oldState.resource.playbackDuration ?? 0) < 1500) {
      cur.retried = true;
      cur.file = null;
      cur.infoFile = null;
      console.log(`[player] áudio não iniciou, refazendo pela via longa: ${cur.title}`);
      startPlayback(gs, cur, "completa");
      return;
    }
    if (cur) playNext(gs);
  });
  gs.player.on("error", (e) => {
    console.log("[player] erro:", e.message);
    playNext(gs);
  });
  gs.connection.receiver.speaking.on("start", (userId) => captureUtterance(gs, userId));
  gs.guild = member.guild;
  gs.lastActivity = Date.now();
  gs.idleTimer = setInterval(() => checkIdle(gs), 30000);
  console.log(`[voz] entrei em "${voice.name}" (${member.guild.name})`);
  return gs;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

client.on(Events.MessageCreate, async (m) => {
  if (m.author.bot || !m.guild || !m.content.startsWith("!")) return;
  const [cmd, ...args] = m.content.slice(1).trim().split(/\s+/);
  const query = args.join(" ");
  const command = cmd.toLowerCase();

  if (["entra", "play", "p", "toca"].includes(command)) {
    const gs = joinFor(m.member, m.channel);
    if (!gs) {
      m.reply("-# Entre num canal de voz primeiro").catch(() => {});
      return;
    }
    if (command === "entra") {
      m.reply({
        embeds: [
          {
            author: { name: "Campeão na área" },
            description: [
              'Fale **"Campeão, toca <música>"** — ou use `!play <música>`.',
              "Por voz também: **pula** · **pausa** · **continua** · **para** · **sai**",
              'Fonte específica: *"…no YouTube"* ou *"…no SoundCloud"*. `!ajuda` para o resto.',
            ].join("\n"),
            color: GOLD,
          },
        ],
      }).catch(() => {});
      return;
    }
    if (!query) {
      m.reply("-# Informe a música: `!play wonderwall oasis`").catch(() => {});
      return;
    }
    await enqueue(gs, query, `${m.author}`);
    return;
  }

  const gs = guilds.get(m.guild.id);
  if (!gs) return;
  gs.textChannel = m.channel;
  gs.lastActivity = Date.now();

  if (command === "radio") setRadio(gs, !gs.radio, `${m.author}`);
  else if (["pula", "skip", "proxima"].includes(command)) playNext(gs);
  else if (["para", "stop"].includes(command)) stopAll(gs);
  else if (command === "pausa") gs.player.pause();
  else if (["continua", "resume"].includes(command)) gs.player.unpause();
  else if (command === "fila") {
    m.reply({ embeds: [{ author: { name: "Fila" }, description: queueText(gs), color: GRAY }] }).catch(() => {});
  } else if (["sai", "sair"].includes(command)) leave(gs);
  else if (command === "ajuda") {
    m.reply({
      embeds: [
        {
          author: { name: "Como usar o Campeão" },
          description: [
            '**Por voz** (comigo no canal): *"Campeão, toca <música>"* — e também: pula, pausa, continua, para, sai.',
            'Com música tocando, diga só *"Campeão"*: o som abaixa e eu escuto por 2s.',
            '**Fonte específica**: *"…no YouTube"* ou *"…no SoundCloud"*. Sem indicar, o Deezer identifica a faixa oficial.',
            '**Rádio**: *"Campeão, liga o rádio"* — quando a fila acaba, sigo tocando parecidas. *"Campeão, essa não"* veta a atual.',
            "Saio sozinho após 5 min sem música e sem comando, ou 1 min com o canal vazio.",
            "**Por texto**: `!entra` `!play` `!pula` `!pausa` `!continua` `!para` `!fila` `!radio` `!sai`",
          ].join("\n"),
          color: GOLD,
          footer: { text: "Campeão" },
        },
      ],
    }).catch(() => {});
  }
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isButton() || !i.customId.startsWith("cmp:")) return;
  const gs = guilds.get(i.guildId);
  if (!gs) {
    i.reply({ content: "-# Não estou mais tocando nada.", flags: 64 }).catch(() => {});
    return;
  }
  const action = i.customId.slice(4);
  gs.lastActivity = Date.now();
  const who = `<@${i.user.id}>`;

  if (action === "queue") {
    i.reply({ content: queueText(gs), flags: 64 }).catch(() => {});
    return;
  }
  await i.deferUpdate().catch(() => {});

  if (action === "pause") {
    const paused = gs.player.state.status === AudioPlayerStatus.Paused;
    if (paused) {
      unduck(gs);
      gs.player.unpause();
      gs.textChannel?.send(`-# Retomada por ${who}`).catch(() => {});
    } else {
      gs.player.pause();
      gs.textChannel?.send(`-# Pausada por ${who}`).catch(() => {});
    }
    refreshControls(gs);
  } else if (action === "skip") {
    gs.textChannel?.send(`-# Pulada por ${who}`).catch(() => {});
    playNext(gs);
  } else if (action === "veto") {
    vetoCurrent(gs, who);
  } else if (action === "stop") {
    stopAll(gs);
    gs.nowPlayingMessage?.edit({ components: [] }).catch(() => {});
    gs.nowPlayingMessage = null;
    gs.textChannel?.send(`-# Parada por ${who} — fila limpa`).catch(() => {});
  } else if (action === "radio") {
    setRadio(gs, !gs.radio, who);
    refreshControls(gs);
  }
});

client.once(Events.ClientReady, () => {
  console.log(`Campeão online como ${client.user.tag}`);
});

async function warmupYoutube() {
  try {
    const t0 = Date.now();
    const raw = await runYtdlp(["--no-playlist", "-f", "bestaudio/best", "-J", "https://www.youtube.com/watch?v=SRXH9AbT280"], { timeout: 90000 });
    const info = JSON.parse(raw.trim().split("\n").filter(Boolean)[0]);
    const file = `${INFO_DIR}/warmup.info.json`;
    writeFileSync(file, JSON.stringify(info));
    const tDl = Date.now();
    const ttfb = await new Promise((resolve) => {
      const p = spawnLow("yt-dlp", [...YTDLP_BASE, "-f", "bestaudio/best", "-q", "-o", "-", "--load-info-json", file]);
      const fin = (v) => { try { p.kill("SIGKILL"); } catch {} resolve(v); };
      p.stdout.once("data", () => fin(Date.now() - tDl));
      p.on("exit", () => resolve(null));
      setTimeout(() => fin(null), 30000);
    });
    console.log(`[aquecimento] youtube ok — extração ${Date.now() - t0 - (Date.now() - tDl)}ms, 1º byte ${ttfb}ms`);
  } catch (e) {
    console.log(`[aquecimento] youtube FALHOU: ${shortErr(e)}`);
  }
}
setTimeout(warmupYoutube, 8000);
setInterval(warmupYoutube, 4 * 60 * 60 * 1000);

try {
  ensureBeep();
} catch (e) {
  console.error("Falha ao gerar bip (seguindo sem):", e.message);
}
client.login(TOKEN).catch((e) => {
  console.error("Falha no login do Discord:", e.message);
  process.exit(1);
});
