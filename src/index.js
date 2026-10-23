// 早押しピンポン — Cloudflare Worker + Durable Object
// /ws/<ルーム番号> へ WebSocket で接続。ルームごとに1つの Durable Object が
// 押した順番・解答権・得点・出題リストを管理する（サーバーに届いた順で順番を決める）。
// /api/search?q=... は iTunes Search API で曲を探し、30秒の試聴URLを返す。

import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/ws\/([0-9a-z]{1,8})$/i);
    if (m) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("WebSocket only", { status: 426 });
      }
      const id = env.ROOMS.idFromName(m[1].toLowerCase());
      return env.ROOMS.get(id).fetch(request);
    }
    if (url.pathname === "/api/search") return search(url, ctx);
    return env.ASSETS.fetch(request);
  },
};

async function search(url, ctx) {
  const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
  if (!q) return json({ results: [] });
  const api = new URL("https://itunes.apple.com/search");
  api.search = new URLSearchParams({ term: q, country: "JP", media: "music", entity: "song", limit: "15", lang: "ja_jp" });
  const cache = caches.default;
  const key = new Request(api.toString());
  let res = await cache.match(key);
  if (!res) {
    const r = await fetch(api, { headers: { "User-Agent": "hayaoshi-pinpon" } });
    if (!r.ok) return json({ error: "検索できませんでした（" + r.status + "）" }, 502);
    const data = await r.json();
    const results = (data.results || [])
      .filter((t) => t.previewUrl)
      .map((t) => ({
        id: String(t.trackId),
        title: t.trackName || "",
        artist: t.artistName || "",
        art: (t.artworkUrl100 || "").replace("100x100bb", "300x300bb"),
        preview: t.previewUrl,
      }));
    res = json({ results });
    res.headers.set("Cache-Control", "public, max-age=3600");
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  return res;
}

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const blank = () => ({
  round: 1,
  phase: "closed", // closed | open | judging
  openAt: 0,
  order: [], // [{id, name, ms}]
  answerer: null,
  locked: [],
  scores: {}, // name -> 点
  result: null, // {id, name, ok, round}
  playlist: [], // [{id,title,artist,art,preview}] 出題者だけに送る
  qi: 0, // いまの問題の曲（playlist の番号）
  reveal: null, // 答えとして全員に見せる曲 {title,artist,art,round}
});

// 曲データの検証（Apple の URL だけ受け付ける）
const appleUrl = (u) => {
  try { const x = new URL(String(u)); return x.protocol === "https:" && /(^|\.)(apple|mzstatic)\.com$/.test(x.hostname); }
  catch { return false; }
};
function cleanTrack(t) {
  if (!t || !appleUrl(t.preview)) return null;
  return {
    id: String(t.id || "").slice(0, 20),
    title: String(t.title || "").slice(0, 120),
    artist: String(t.artist || "").slice(0, 120),
    art: appleUrl(t.art) ? String(t.art) : "",
    preview: String(t.preview),
  };
}

export class QuizRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.s = blank();
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get("state");
      if (saved) this.s = { ...blank(), ...saved };
    });
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: null, id: null, name: "" });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const me = ws.deserializeAttachment() || {};
    const s = this.s;
    const name = String(msg.name || "").trim().slice(0, 10);

    if (msg.t === "join") {
      const role = msg.role === "host" ? "host" : "player";
      const id = String(msg.id || "").slice(0, 40) || crypto.randomUUID();
      ws.serializeAttachment({ role, id, name: role === "player" ? name : "" });
      if (role === "player" && name && !(name in s.scores)) s.scores[name] = 0;
      return this.save();
    }
    if (!me.role) return;

    if (me.role === "player" && msg.t === "buzz") {
      if (s.phase === "closed") return;
      if (msg.round !== s.round) return;
      if (s.order.some((o) => o.id === me.id) || s.locked.includes(me.id)) return;
      s.order.push({ id: me.id, name: me.name || "？", ms: Math.max(0, Date.now() - s.openAt) });
      return this.save();
    }

    if (me.role !== "host") return;
    switch (msg.t) {
      case "open":
        if (s.phase !== "closed" || s.result) return;
        s.phase = "open"; s.openAt = Date.now();
        break;
      case "give": {
        const o = s.order.find((x) => x.id === msg.id);
        if (!o || s.phase !== "open") return;
        s.answerer = o.id; s.phase = "judging"; s.result = null;
        break;
      }
      case "correct": {
        if (!s.answerer) return;
        const o = s.order.find((x) => x.id === s.answerer);
        const nm = o ? o.name : "？";
        s.scores[nm] = (s.scores[nm] || 0) + 1;
        s.result = { id: s.answerer, name: nm, ok: true, round: s.round };
        s.phase = "closed"; s.answerer = null;
        this.revealNow();
        break;
      }
      case "wrong": {
        if (!s.answerer) return;
        const o = s.order.find((x) => x.id === s.answerer);
        s.result = { id: s.answerer, name: o ? o.name : "？", ok: false, round: s.round };
        s.locked.push(s.answerer);
        s.order = s.order.filter((x) => x.id !== s.answerer);
        s.answerer = null; s.phase = "open";
        break;
      }
      case "reveal": // 誰も正解しなかったときに答えを見せる
        s.phase = "closed"; s.answerer = null;
        if (!s.result || !s.result.ok) s.result = { id: null, name: "", ok: false, round: s.round, shown: true };
        this.revealNow();
        break;
      case "next": // 次の問題へ（曲も次へ）
        this.nextRound(true);
        break;
      case "skip":
        this.nextRound(true);
        break;
      case "reset":
        for (const k in s.scores) s.scores[k] = 0;
        Object.assign(s, { ...blank(), scores: s.scores, playlist: s.playlist });
        break;
      case "remove": // 得点表から名前を消す
        delete s.scores[String(msg.name || "")];
        break;
      case "addTrack": {
        const t = cleanTrack(msg.track);
        if (!t || s.playlist.length >= 100) return;
        s.playlist.push(t);
        break;
      }
      case "delTrack": {
        const i = msg.i | 0;
        if (i < 0 || i >= s.playlist.length) return;
        s.playlist.splice(i, 1);
        if (i < s.qi) s.qi--;
        break;
      }
      case "setQ": {
        const i = msg.i | 0;
        if (i < 0 || i >= s.playlist.length || s.phase !== "closed") return;
        s.qi = i; s.reveal = null;
        if (s.result) { this.nextRound(false); }
        break;
      }
      case "clearList":
        s.playlist = []; s.qi = 0; s.reveal = null;
        break;
      default:
        return;
    }
    return this.save();
  }

  revealNow() {
    const s = this.s, t = s.playlist[s.qi];
    if (t) s.reveal = { title: t.title, artist: t.artist, art: t.art, round: s.round };
  }

  nextRound(advanceSong) {
    const s = this.s;
    s.round++; s.order = []; s.locked = []; s.answerer = null; s.result = null; s.reveal = null; s.phase = "closed";
    if (advanceSong && s.playlist.length) s.qi = Math.min(s.qi + 1, s.playlist.length);
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch {}
    this.broadcast();
  }
  async webSocketError() { this.broadcast(); }

  async save() {
    await this.ctx.storage.put("state", this.s);
    this.broadcast();
  }

  broadcast() {
    const sockets = this.ctx.getWebSockets();
    const players = [];
    let hosts = 0;
    for (const w of sockets) {
      if (w.readyState !== 1) continue;
      const a = w.deserializeAttachment() || {};
      if (a.role === "player") players.push({ id: a.id, name: a.name });
      if (a.role === "host") hosts++;
    }
    const now = Date.now();
    const { playlist, ...pub } = this.s; // 回答者には出題リスト（答え）を送らない
    pub.songCount = playlist.length;
    const forHost = JSON.stringify({ t: "state", s: this.s, players, hosts, now });
    const forPlayer = JSON.stringify({ t: "state", s: pub, players, hosts, now });
    for (const w of sockets) {
      const a = w.deserializeAttachment() || {};
      try { w.send(a.role === "host" ? forHost : forPlayer); } catch {}
    }
  }
}
