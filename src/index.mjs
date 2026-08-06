import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { Client, Events, GatewayIntentBits } from "discord.js";
import {
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
} from "@discordjs/voice";
import prism from "prism-media";

const TOKEN = process.env.DISCORD_TOKEN;
const STT_URL = "http://127.0.0.1:5005/";
const JOCKIE_PREFIX = process.env.JOCKIE_PREFIX ?? "m!";
const WAKE_WORDS = ["campeao", "campiao", "capiao", "campeaum", "campeon", "campeao"];
const ATTENTION_MS = 2500;
const BEEP_FILE = "/tmp/beep.pcm";

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
      textChannel: null,
      listening: new Set(),
      attention: new Map(),
    });
  }
  return guilds.get(guildId);
}

const norm = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function playBeep(gs) {
  try {
    const resource = createAudioResource(Readable.from([readFileSync(BEEP_FILE)]), {
      inputType: StreamType.Raw,
    });
    gs.player.play(resource);
  } catch (e) {
    console.log("[beep] falhou:", e.message);
  }
}

function sendJockie(gs, command) {
  console.log(`[jockie] enviando: ${JOCKIE_PREFIX}${command}`);
  gs.textChannel?.send(`${JOCKIE_PREFIX}${command}`).catch((e) => console.log("[jockie] erro:", e.message));
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

async function transcribe(pcm) {
  try {
    const res = await fetch(STT_URL, {
      method: "POST",
      body: pcm,
      headers: { "content-type": "application/octet-stream" },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.log("[stt] resposta", res.status);
      return null;
    }
    return (await res.json()).text;
  } catch (e) {
    console.log("[stt] erro:", e.message);
    return null;
  }
}

function captureUtterance(gs, userId) {
  if (gs.listening.has(userId)) return;
  const user = client.users.cache.get(userId);
  if (user?.bot) return;
  gs.listening.add(userId);
  const startedAt = Date.now();
  console.log(`[voz] capturando ${user?.username ?? userId}`);
  const opus = gs.connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 600 },
  });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const chunks = [];
  let bytes = 0;
  opus.pipe(decoder);
  decoder.on("data", (c) => {
    bytes += c.length;
    if (bytes < 48000 * 2 * 2 * 15) chunks.push(c);
  });
  const cleanup = (e) => {
    if (e) console.log("[voz] erro no stream:", e.message);
    gs.listening.delete(userId);
  };
  decoder.on("end", async () => {
    gs.listening.delete(userId);
    const pcm = Buffer.concat(chunks);
    const secs = (pcm.length / (48000 * 2 * 2)).toFixed(1);
    console.log(`[voz] utterance de ${user?.username ?? userId}: ${secs}s`);
    if (pcm.length < 48000 * 2 * 2 * 0.6) return;
    const text = await transcribe(to16kMono(pcm));
    console.log(`[stt] ${user?.username ?? userId}: "${text}"`);
    if (text) handleVoice(gs, userId, text, startedAt);
  });
  decoder.on("error", cleanup);
  opus.on("error", cleanup);
}

function handleVoice(gs, userId, raw, startedAt) {
  const text = norm(raw);
  if (!text) return;
  const words = text.split(" ");
  const wakeIdx = words.findIndex((w) => WAKE_WORDS.includes(w));
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
  console.log(`[wake] comando: "${rest}"`);
  const mention = `<@${userId}>`;

  if (rest === "" || /^(oi|ola|fala|ei)$/.test(rest)) {
    gs.attention.set(userId, Date.now() + ATTENTION_MS);
    playBeep(gs);
    return;
  }

  const playMatch = rest.match(/^(?:ai |ei |vai |ow )?(?:toca|toque|coloca|bota|poe|play|manda)\s+(.+)/);
  if (playMatch) {
    const query = playMatch[1]
      .replace(/^(a musica |o som |a |o |um |uma )/, "")
      .replace(/\s+(ai|por favor|pra mim|pra gente|rapidao|agora)$/, "")
      .trim();
    if (!query) return;
    playBeep(gs);
    gs.textChannel?.send(`🎤 ${mention} pediu: **${query}**`).catch(() => {});
    sendJockie(gs, `play ${query}`);
    return;
  }
  if (/^(pula|proxima|passa|skip|next)/.test(rest)) {
    playBeep(gs);
    sendJockie(gs, "skip");
    return;
  }
  if (/^pausa/.test(rest)) {
    playBeep(gs);
    sendJockie(gs, "pause");
    return;
  }
  if (/^(continua|volta|despausa|resume)/.test(rest)) {
    playBeep(gs);
    sendJockie(gs, "resume");
    return;
  }
  if (/^(para|pare|stop|chega|cala)/.test(rest)) {
    playBeep(gs);
    sendJockie(gs, "stop");
    return;
  }
  if (/^(sai|vaza|tchau|xau|embora)/.test(rest)) {
    gs.textChannel?.send(`👋 Falou, ${mention}!`).catch(() => {});
    sendJockie(gs, "leave");
    leave(gs);
    return;
  }
  console.log(`[wake] não entendi: "${rest}"`);
}

function leave(gs) {
  try {
    gs.connection?.destroy();
  } catch {}
  guilds.delete(gs.guildId);
}

function joinFor(member, channel) {
  const gs = getState(member.guild.id);
  gs.textChannel = channel;
  if (gs.connection) return gs;
  const voice = member.voice.channel;
  if (!voice) return null;
  gs.connection = joinVoiceChannel({
    channelId: voice.id,
    guildId: member.guild.id,
    adapterCreator: member.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  gs.connection.on("stateChange", (oldS, newS) => {
    console.log(`[voz] conexão: ${oldS.status} -> ${newS.status}`);
    if (newS.status === "destroyed" || newS.status === "disconnected") {
      guilds.delete(gs.guildId);
    }
  });
  gs.connection.on("error", (e) => console.log("[voz] erro de conexão:", e.message));
  gs.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  gs.connection.subscribe(gs.player);
  gs.connection.receiver.speaking.on("start", (userId) => captureUtterance(gs, userId));
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

client.on(Events.MessageCreate, (m) => {
  if (m.author.bot || !m.guild || !m.content.startsWith("!")) return;
  const [cmd] = m.content.slice(1).trim().split(/\s+/);
  const command = cmd.toLowerCase();

  if (command === "entra") {
    const gs = joinFor(m.member, m.channel);
    if (!gs) {
      m.reply("Entra num canal de voz primeiro! 🎧").catch(() => {});
      return;
    }
    m.reply('Cheguei! 🏆 Fala "CAMPEÃO, TOCA <música>" que eu passo pro Jockie').catch(() => {});
  } else if (command === "sai") {
    const gs = guilds.get(m.guild.id);
    if (gs) leave(gs);
  } else if (command === "ajuda") {
    m.reply(
      [
        '**Por voz** (comigo no canal): "CAMPEÃO, TOCA <música>" — também: pula, pausa, continua, para, sai',
        `Eu não toco nada: eu escuto e mando \`${JOCKIE_PREFIX}play\` pro Jockie Music tocar`,
        "**Por texto**: `!entra` `!sai` `!ajuda`",
      ].join("\n"),
    ).catch(() => {});
  }
});

client.once(Events.ClientReady, () => {
  console.log(`Campeão online como ${client.user.tag}`);
});

try {
  ensureBeep();
} catch (e) {
  console.error("Falha ao gerar bip (seguindo sem):", e.message);
}
client.login(TOKEN).catch((e) => {
  console.error("Falha no login do Discord:", e.message);
  process.exit(1);
});
