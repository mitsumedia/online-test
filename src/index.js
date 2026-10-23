// 早押しピンポン — Cloudflare Worker + Durable Object
// /ws/<ルーム番号> へ WebSocket で接続。ルームごとに1つの Durable Object が
// 押した順番・解答権・得点を管理する（サーバーに届いた順で順番を決める）。

import { DurableObject } from "cloudflare:workers";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/ws\/([0-9a-z]{1,8})$/i);
    if (m) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("WebSocket only", { status: 426 });
      }
      const id = env.ROOMS.idFromName(m[1].toLowerCase());
      return env.ROOMS.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

const blank = () => ({
  round: 1,
  phase: "closed", // closed | open | judging
  openAt: 0,
  order: [], // [{id, name, ms}]
  answerer: null,
  locked: [],
  scores: {}, // name -> 点
  result: null, // {id, name, ok, round}
});

export class QuizRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.s = blank();
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get("state");
      if (saved) this.s = saved;
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
        if (s.phase !== "closed") return;
        if (s.result) this.nextRound();
        s.phase = "open"; s.openAt = Date.now(); s.result = null;
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
      case "skip":
        this.nextRound(); s.phase = "closed";
        break;
      case "reset":
        for (const k in s.scores) s.scores[k] = 0;
        Object.assign(s, { ...blank(), scores: s.scores });
        break;
      case "remove": // 得点表から名前を消す
        delete s.scores[String(msg.name || "")];
        break;
      default:
        return;
    }
    return this.save();
  }

  nextRound() {
    const s = this.s;
    s.round++; s.order = []; s.locked = []; s.answerer = null; s.result = null;
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
    const msg = JSON.stringify({ t: "state", s: this.s, players, hosts, now: Date.now() });
    for (const w of sockets) { try { w.send(msg); } catch {} }
  }
}
