import { spawn, execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

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

const STT_URL = process.env.STT_URL ?? "http://127.0.0.1:5005/";

const WAKE_WORDS = ["campeao", "campiao", "capiao", "campeaum", "campeon"];

const ATTENTION_MS = 2500;

const DUCK_VOLUME = 0.15;

const DUCK_TIMEOUT_MS = 8000;

const BEEP_FILE = "/tmp/beep.pcm";

const CACHE_DIR = process.env.CACHE_DIR ?? "/data/tracks";

const INFO_DIR = "/tmp/info";

const CACHE_MAX_FILES = 40;

const INFO_TTL_MS = 3 * 60 * 60 * 1000;

mkdirSync(CACHE_DIR, { recursive: true });

mkdirSync(INFO_DIR, { recursive: true });

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

const videoIdOf = (url) => url?.match(/[?&]v=([\w-]{11})/)?.[1] ?? null;

const SOURCE_NAMES = { youtube: "YouTube", soundcloud: "SoundCloud", url: "Link direto" };

const fmtDur = (s) =>
  s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : null;

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

export {
  ATTENTION_MS,
  BEEP_FILE,
  CACHE_DIR,
  CACHE_MAX_FILES,
  COMMAND_MAX_SECONDS,
  COOKIES_FILE,
  DUCK_TIMEOUT_MS,
  DUCK_VOLUME,
  FF_FAST,
  FF_OUT,
  GATE_CONCURRENCY,
  GATE_MIN_INTERVAL_BUSY_MS,
  GATE_MIN_INTERVAL_MS,
  GATE_QUEUE_TIMEOUT_MS,
  GATE_SECONDS,
  GATE_STOP,
  GROQ_KEY,
  HOT_USER_MS,
  INFO_DIR,
  INFO_TTL_MS,
  JITTER_BYTES,
  LEAVE_VERBS,
  LOW_PRIO,
  MAX_UTTERANCE_SECONDS,
  PAUSE_VERBS,
  PLAY_VERBS,
  POT_URL,
  PRINT_FLAT,
  PRINT_FULL,
  REMIX_WORDS,
  RESUBSCRIBE_COOLDOWN_MS,
  RESUME_VERBS,
  SKIP_VERBS,
  SOURCE_NAMES,
  STOP_VERBS,
  STT_URL,
  Semaphore,
  WAKE_WORDS,
  YTDLP_BASE,
  avg,
  cacheCleanPartials,
  cacheEvict,
  cacheKey,
  cacheLookup,
  deezerLookup,
  dropTrackFile,
  editDistance,
  ensureBeep,
  execFileP,
  fmtDur,
  gateAllowed,
  gateHasWake,
  gateSem,
  gateStats,
  gateWake,
  groqHits,
  groqSlotFree,
  groqTranscribe,
  hasCookies,
  infoFresh,
  isWakeWord,
  localTranscribe,
  matchVerb,
  norm,
  parseCandidates,
  parseSource,
  prefetch,
  pruneInfo,
  resolveTrack,
  runYtdlp,
  scoreCandidate,
  shortErr,
  sliceSeconds,
  sourceArgs,
  spawnLow,
  sttPending,
  to16kMono,
  transcribe,
  videoIdOf,
  wavFrom,
};
