'use strict';
/*
 * JETPACK ARENA - 2 player LAN shooter server
 * Zero dependencies. Run:  node server.js   then open http://<your-LAN-ip>:3000 on both devices.
 * The server is authoritative: it runs all physics at 60 Hz and streams snapshots to both clients.
 */
process.on('uncaughtException', (e) => console.error(e));
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = +process.env.PORT || 3000;
const W = 2400, H = 1300, DT = 1 / 60, KILL_LIMIT = 10, GRAV = 1800;
const PW = 22, PH = 44;

/* ------------------------------------------------------------------ map */
const R = (x, y, w, h) => ({ x, y, w, h });
const mir = (r) => ({ x: W - r.x - r.w, y: r.y, w: r.w, h: r.h });
const leftSide = [
  R(150, 1020, 380, 28), R(560, 860, 300, 28), R(60, 690, 260, 28),
  R(430, 520, 360, 28), R(200, 300, 300, 28), R(560, 1120, 110, 80),
];
const centre = [
  R(1000, 1030, 400, 28), R(880, 780, 640, 28), R(1050, 560, 300, 28),
  R(950, 320, 500, 28), R(1130, 1120, 140, 80),
];
const RECTS = [
  R(0, 1200, W, 100),                 // ground
  R(-60, -60, 60, H + 120), R(W, -60, 60, H + 120), R(0, -60, W, 60), // bounds
  ...leftSide, ...leftSide.map(mir), ...centre,
];

const PK_LEFT = [
  [340, 1000, 'rifle'], [710, 840, 'shotgun'], [190, 670, 'hp'],
  [610, 500, 'sniper'], [350, 280, 'rocket'], [420, 1180, 'gren'],
];
const PK_CENTRE = [[1200, 1010, 'gren'], [1200, 760, 'rifle'], [1200, 540, 'hp'], [1200, 300, 'rocket']];
const PICKUP_DEFS = [
  ...PK_LEFT.map(([x, y, type]) => ({ x, y, type })),
  ...PK_LEFT.map(([x, y, type]) => ({ x: W - x, y, type })),
  ...PK_CENTRE.map(([x, y, type]) => ({ x, y, type })),
];

const SPAWNS = [ // [x, platform top]
  [300, 1200], [2100, 1200], [340, 1020], [2060, 1020], [190, 690], [2210, 690],
  [610, 520], [1790, 520], [350, 300], [2050, 300], [1200, 1030], [1200, 780],
];

/* -------------------------------------------------------------- weapons */
const WEAPONS = [
  { n: 'Pistol',         dmg: 20, rof: 0.30,  mag: 12, rel: 1.0, spd: 1600, spr: 0.015, pel: 1, life: 1.2,  rec: 60 },
  { n: 'Assault Rifle',  dmg: 12, rof: 0.085, mag: 30, rel: 1.7, spd: 1700, spr: 0.05,  pel: 1, life: 1.2,  rec: 45 },
  { n: 'Shotgun',        dmg: 11, rof: 0.75,  mag: 6,  rel: 2.0, spd: 1300, spr: 0.2,   pel: 8, life: 0.32, rec: 380 },
  { n: 'Sniper',         dmg: 85, rof: 1.1,   mag: 4,  rel: 2.3, spd: 3200, spr: 0.002, pel: 1, life: 1.0,  rec: 300 },
  { n: 'Rocket Launcher', dmg: 90, rof: 1.0,  mag: 2,  rel: 2.6, spd: 850,  spr: 0,     pel: 1, life: 3.0,  rec: 320, rocket: true },
];
const PK_WEAPON = { rifle: 1, shotgun: 2, sniper: 3, rocket: 4 };
const EXPL_R = 130, GREN_DMG = 75;

/* ------------------------------------------------ game (one instance per room) */
function createGame(code) {
const pickups = PICKUP_DEFS.map((p) => ({ ...p, on: true, t: 0 }));
const players = [null, null];
let phase = 'lobby', cdT = 0, overT = 0, winner = -1;
let bullets = [], grenades = [], ev = [];
const NOIN = { l: 0, r: 0, u: 0, f: 0, a: 0 };
const NOED = { g: 0, s: 0, rl: 0, e: 0 };

const r1 = (v) => Math.round(v * 10) / 10;
const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const approach = (v, t, a) => (v < t ? Math.min(t, v + a) : Math.max(t, v - a));

function makePlayer(slot, name) {
  return {
    id: slot, name, x: 0, y: 0, w: PW, h: PH, vx: 0, vy: 0, hp: 100, fuel: 1, fd: 0, face: 1,
    onGround: false, weapons: [], cur: 0, reload: 0, cd: 0, gcd: 0, grenades: 3, alive: true,
    respawn: 0, inv: 0, kills: 0, deaths: 0, jet: false,
    in: { l: 0, r: 0, u: 0, f: 0, a: 0 }, edge: { g: 0, s: 0, rl: 0, e: 0 },
  };
}

function spawnPlayer(p) {
  let pts = SPAWNS.slice();
  const foe = players[1 - p.id];
  if (foe && foe.alive) {
    const d = (s) => (s[0] - foe.x) ** 2 + (s[1] - foe.y) ** 2;
    pts.sort((a, b) => d(b) - d(a));
    pts = pts.slice(0, 4);
  }
  const s = pts[(Math.random() * pts.length) | 0];
  p.x = s[0] - p.w / 2; p.y = s[1] - p.h - 2; p.vx = p.vy = 0;
  p.hp = 100; p.fuel = 1; p.fd = 0; p.alive = true; p.inv = 1.8; p.grenades = 3;
  p.weapons = [{ id: 0, ammo: WEAPONS[0].mag, res: -1 }, null];
  p.cur = 0; p.reload = 0; p.cd = 0.3; p.gcd = 0;
  ev.push({ e: 'sp', x: s[0], y: s[1] - 20 });
}

function resetRound() {
  bullets = []; grenades = [];
  for (const k of pickups) { k.on = true; k.t = 0; }
  for (const p of players) if (p) { p.kills = 0; p.deaths = 0; spawnPlayer(p); }
  winner = -1;
  if (players[0] && players[1]) { phase = 'countdown'; cdT = 3; } else phase = 'lobby';
}

/* -------------------------------------------------------------- physics */
function moveBox(b, dt, bx, by) {
  b.x += b.vx * dt;
  for (const r of RECTS) {
    if (overlap(b, r)) {
      if (b.vx > 0) b.x = r.x - b.w; else if (b.vx < 0) b.x = r.x + r.w;
      b.vx *= -bx;
    }
  }
  b.y += b.vy * dt;
  b.onGround = false;
  for (const r of RECTS) {
    if (overlap(b, r)) {
      if (b.vy > 0) { b.y = r.y - b.h; b.onGround = true; } else b.y = r.y + r.h;
      b.vy *= -by;
      if (Math.abs(b.vy) < 60) b.vy = 0;
    }
  }
}

function damage(p, amt, owner, wid, hs) {
  if (!p.alive || p.inv > 0 || phase !== 'play') return;
  p.hp -= amt;
  ev.push({ e: 'h', x: r1(p.x + p.w / 2), y: r1(p.y + 16), hs: hs ? 1 : 0, id: p.id });
  if (p.hp <= 0) killPlayer(p, owner, wid);
}

function killPlayer(p, owner, wid) {
  p.alive = false; p.hp = 0; p.respawn = 3; p.deaths++; p.jet = false;
  const k = players[owner];
  if (k && k !== p) k.kills++; else p.kills = Math.max(0, p.kills - 1);
  ev.push({ e: 'k', k: owner, v: p.id, w: wid, x: r1(p.x + p.w / 2), y: r1(p.y + 20) });
  if (k && k !== p && k.kills >= KILL_LIMIT) { phase = 'over'; winner = k.id; overT = 7; }
}

function explode(x, y, owner, dmg, wid) {
  ev.push({ e: 'x', x: r1(x), y: r1(y), r: EXPL_R });
  for (const p of players) {
    if (!p || !p.alive) continue;
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    const dx = cx - x, dy = cy - y, d = Math.hypot(dx, dy);
    if (d < EXPL_R + 20) {
      const f = Math.max(0, 1 - d / (EXPL_R + 20));
      const nx = dx / (d || 1), ny = dy / (d || 1);
      p.vx += nx * 1100 * f; p.vy += ny * 1100 * f - 150 * f;
      damage(p, dmg * f * (p.id === owner ? 0.6 : 1), owner, wid, false);
    }
  }
}

/* -------------------------------------------------------------- gameplay */
function fireWeapon(p) {
  const w = p.weapons[p.cur], d = WEAPONS[w.id];
  const ang = p.in.a, ox = p.x + p.w / 2, oy = p.y + 16;
  for (let i = 0; i < d.pel; i++) {
    const a = ang + (Math.random() * 2 - 1) * d.spr;
    const sp = d.spd * (d.pel > 1 ? 0.9 + Math.random() * 0.2 : 1);
    bullets.push({
      x: ox + Math.cos(ang) * 26, y: oy + Math.sin(ang) * 26,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      dmg: d.dmg, o: p.id, life: d.life, rk: !!d.rocket, w: w.id,
    });
  }
  p.vx -= Math.cos(ang) * d.rec; p.vy -= Math.sin(ang) * d.rec * 0.6;
  ev.push({ e: 'f', w: w.id, x: r1(ox + Math.cos(ang) * 28), y: r1(oy + Math.sin(ang) * 28), a: Math.round(ang * 100) / 100 });
  w.ammo--; p.cd = d.rof;
  if (w.ammo <= 0) {
    if (w.res !== 0) p.reload = d.rel;
    else if (w.id !== 0) p.weapons[p.cur] = { id: 0, ammo: WEAPONS[0].mag, res: -1 };
  }
}

function finishReload(p) {
  const w = p.weapons[p.cur]; if (!w) return;
  const d = WEAPONS[w.id], need = d.mag - w.ammo;
  const take = w.res < 0 ? need : Math.min(need, w.res);
  w.ammo += take; if (w.res >= 0) w.res -= take;
}

function throwGrenade(p) {
  const a = p.in.a, ox = p.x + p.w / 2, oy = p.y + 12;
  grenades.push({
    x: ox - 5 + Math.cos(a) * 18, y: oy - 5 + Math.sin(a) * 18, w: 10, h: 10,
    vx: Math.cos(a) * 780 + p.vx * 0.5, vy: Math.sin(a) * 780 + p.vy * 0.5 - 60,
    t: 2.2, o: p.id, onGround: false,
  });
  p.grenades--; p.gcd = 0.5;
  ev.push({ e: 'gt', x: r1(ox), y: r1(oy) });
}

function tryPickups(p, pressE) {
  const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
  for (const k of pickups) {
    if (!k.on || Math.abs(k.x - cx) > 30 || Math.abs(k.y - cy) > 36) continue;
    let took = false;
    if (k.type === 'hp') { if (p.hp < 100) { p.hp = Math.min(100, p.hp + 50); took = true; } }
    else if (k.type === 'gren') { if (p.grenades < 5) { p.grenades = Math.min(5, p.grenades + 2); took = true; } }
    else {
      const wid = PK_WEAPON[k.type], d = WEAPONS[wid];
      const have = p.weapons.findIndex((w) => w && w.id === wid);
      if (have >= 0) { if (p.weapons[have].res < d.mag * 3) { p.weapons[have].res += d.mag * 2; took = true; } }
      else if (!p.weapons[1]) { p.weapons[1] = { id: wid, ammo: d.mag, res: d.mag * 2 }; took = true; }
      else if (pressE) { p.weapons[p.cur] = { id: wid, ammo: d.mag, res: d.mag * 2 }; p.reload = 0; took = true; }
    }
    if (took) { k.on = false; k.t = k.type === 'hp' ? 22 : 15; ev.push({ e: 'pk', x: k.x, y: k.y, id: p.id }); }
  }
}

function stepPlayer(p, dt, live) {
  const inp = live ? p.in : NOIN, ed = live ? p.edge : NOED;
  p.inv = Math.max(0, p.inv - dt); p.cd -= dt; p.gcd -= dt;

  const dir = (inp.r ? 1 : 0) - (inp.l ? 1 : 0);
  const target = dir * 300;
  if (dir && p.vx * dir > 300) p.vx *= 1 - 1.5 * dt;
  else p.vx = approach(p.vx, target, (p.onGround ? (dir ? 3200 : 3600) : (dir ? 1500 : 250)) * dt);

  p.vy += GRAV * dt;
  p.jet = false;
  if (inp.u && p.fuel > 0) {
    p.vy -= 3500 * dt; if (p.vy < -470) p.vy = -470;
    p.fuel = Math.max(0, p.fuel - 0.34 * dt); p.fd = 0.6; p.jet = true;
  } else if (p.fd > 0) p.fd -= dt;
  else p.fuel = Math.min(1, p.fuel + (p.onGround ? 0.6 : 0.08) * dt);
  if (p.vy > 1000) p.vy = 1000;
  moveBox(p, dt, 0, 0);

  p.face = Math.cos(inp.a) >= 0 ? 1 : -1;

  if (ed.s && p.weapons[1]) { p.cur ^= 1; p.reload = 0; p.cd = 0.2; }
  if (ed.g && p.grenades > 0 && p.gcd <= 0) throwGrenade(p);
  const w = p.weapons[p.cur];
  if (w) {
    const d = WEAPONS[w.id];
    if (ed.rl && p.reload <= 0 && w.ammo < d.mag && w.res !== 0) p.reload = d.rel;
    if (p.reload > 0) { p.reload -= dt; if (p.reload <= 0) { p.reload = 0; finishReload(p); } }
    else if (inp.f && p.cd <= 0) {
      if (w.ammo > 0) fireWeapon(p);
      else if (w.res !== 0) p.reload = d.rel;
    }
  }
  tryPickups(p, ed.e);
}

function updateBullets(dt) {
  const out = [];
  for (const b of bullets) {
    b.life -= dt;
    const dist = Math.hypot(b.vx, b.vy) * dt, n = Math.max(1, Math.ceil(dist / 6));
    const sx = b.vx * dt / n, sy = b.vy * dt / n;
    let dead = b.life <= 0;
    for (let i = 0; i < n && !dead; i++) {
      b.x += sx; b.y += sy;
      for (const r of RECTS) {
        if (b.x > r.x && b.x < r.x + r.w && b.y > r.y && b.y < r.y + r.h) {
          dead = true;
          if (!b.rk) ev.push({ e: 'i', x: r1(b.x - sx), y: r1(b.y - sy) });
          break;
        }
      }
      if (dead) break;
      for (const p of players) {
        if (!p || !p.alive || p.id === b.o || p.inv > 0) continue;
        if (b.x > p.x - 2 && b.x < p.x + p.w + 2 && b.y > p.y - 2 && b.y < p.y + p.h + 2) {
          dead = true;
          if (!b.rk) { const hs = b.y < p.y + 12; damage(p, b.dmg * (hs ? 1.5 : 1), b.o, b.w, hs); }
          break;
        }
      }
    }
    if (b.x < -100 || b.x > W + 100 || b.y < -100 || b.y > H + 100) dead = true;
    if (dead) { if (b.rk) explode(b.x, b.y, b.o, b.dmg, b.w); } else out.push(b);
  }
  bullets = out;
}

function updateGrenades(dt) {
  const out = [];
  for (const g of grenades) {
    g.t -= dt;
    g.vy += GRAV * 0.8 * dt;
    moveBox(g, dt, 0.5, 0.45);
    if (g.onGround) g.vx *= Math.pow(0.05, dt);
    if (g.t <= 0) explode(g.x + 5, g.y + 5, g.o, GREN_DMG, -1); else out.push(g);
  }
  grenades = out;
}

function tick(dt) {
  if (phase === 'countdown') { cdT -= dt; if (cdT <= 0) { phase = 'play'; ev.push({ e: 'go' }); } }
  else if (phase === 'over') { overT -= dt; if (overT <= 0) resetRound(); }
  const live = phase === 'play' || phase === 'lobby';
  for (const p of players) {
    if (!p) continue;
    if (!p.alive) {
      if (phase === 'play' || phase === 'lobby') { p.respawn -= dt; if (p.respawn <= 0) spawnPlayer(p); }
    } else stepPlayer(p, dt, live);
    p.edge.g = p.edge.s = p.edge.rl = p.edge.e = 0;
  }
  updateBullets(dt); updateGrenades(dt);
  for (const k of pickups) if (!k.on) { k.t -= dt; if (k.t <= 0) k.on = true; }
}

/* ------------------------------------------------------------- snapshots */
function snapPlayer(p) {
  const cw = p.weapons[p.cur];
  return {
    x: r1(p.x), y: r1(p.y), vx: r1(p.vx), vy: r1(p.vy), sq: p.sq | 0, hp: Math.ceil(p.hp),
    fu: Math.round(p.fuel * 100) / 100, an: Math.round(p.in.a * 100) / 100, fc: p.face,
    w: p.weapons.map((w) => (w ? [w.id, w.ammo, w.res] : 0)), cu: p.cur,
    rl: p.reload > 0 && cw ? Math.round(p.reload / WEAPONS[cw.id].rel * 100) / 100 : 0,
    gr: p.grenades, al: p.alive ? 1 : 0, rs: Math.ceil(p.respawn * 10) / 10, inv: p.inv > 0 ? 1 : 0,
    k: p.kills, d: p.deaths, nm: p.name, jt: p.jet ? 1 : 0, og: p.onGround ? 1 : 0,
  };
}

function snapshot() {
  const s = {
    t: 's', ph: phase, cd: Math.ceil(cdT), ot: Math.ceil(overT), win: winner,
    p: players.map((p) => (p ? snapPlayer(p) : null)),
    b: bullets.map((b) => [r1(b.x), r1(b.y), r1(b.vx), r1(b.vy), b.rk ? 1 : 0]),
    g: grenades.map((g) => [r1(g.x + 5), r1(g.y + 5), Math.round(g.t * 10) / 10]),
    pk: pickups.map((k) => (k.on ? '1' : '0')).join(''),
    ev,
  };
  ev = [];
  return JSON.stringify(s);
}

function join(name) {
  const slot = players[0] ? (players[1] ? -1 : 1) : 0;
  if (slot < 0) return -1;
  players[slot] = makePlayer(slot, name);
  spawnPlayer(players[slot]);
  if (players[0] && players[1]) resetRound(); else phase = 'lobby';
  return slot;
}
function leave(slot) {
  if (!players[slot]) return;
  console.log(`[-] ${players[slot].name} left room ${code}`);
  players[slot] = null; bullets = []; grenades = []; phase = 'lobby';
  const o = players[1 - slot];
  if (o) { o.kills = 0; o.deaths = 0; spawnPlayer(o); }
}
function input(slot, m) {
  const p = players[slot]; if (!p) return;
  p.in.l = m.l ? 1 : 0; p.in.r = m.r ? 1 : 0; p.in.u = m.u ? 1 : 0; p.in.f = m.f ? 1 : 0;
  p.in.a = num(m.a, p.in.a); p.sq = m.n | 0;
  if (m.g) p.edge.g = 1; if (m.s) p.edge.s = 1; if (m.rl) p.edge.rl = 1; if (m.e) p.edge.e = 1;
}
function initInfo(slot) {
  return {
    t: 'init', id: slot, code, W, H, rects: RECTS, kl: KILL_LIMIT,
    pickups: PICKUP_DEFS.map(({ x, y, type }) => ({ x, y, type })),
    weapons: WEAPONS.map((w) => ({ n: w.n, mag: w.mag })),
  };
}
const summary = () => ({
  code, host: (players[0] || players[1] || { name: '?' }).name,
  count: (players[0] ? 1 : 0) + (players[1] ? 1 : 0), phase,
});
return { code, tick, snapshot, join, leave, input, initInfo, summary, empty: () => !players[0] && !players[1] };
} // end createGame

/* ------------------------------------------------------- WebSocket (RFC6455) */
const clients = new Set();
const rooms = new Map();

function wsFrame(str) {
  const p = Buffer.from(str), n = p.length;
  let h;
  if (n < 126) h = Buffer.from([0x81, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
}
function send(c, str, droppable) {
  if (!c.socket.writable) return;
  if (droppable && c.socket.writableLength > 200000) return;
  c.socket.write(wsFrame(str));
}
const sendFrame = (c, buf) => { if (c.socket.writable) c.socket.write(buf); };

function onClientData(c, chunk) {
  c.buf = Buffer.concat([c.buf, chunk]);
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (len > 100000) { c.socket.destroy(); return; }
    const ml = masked ? 4 : 0;
    if (b.length < off + ml + len) return;
    let payload = Buffer.from(b.subarray(off + ml, off + ml + len));
    if (masked) { const m = b.subarray(off, off + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
    c.buf = b.subarray(off + ml + len);
    if (op === 1) onMessage(c, payload.toString('utf8'));
    else if (op === 8) { c.socket.end(Buffer.from([0x88, 0])); return; }
    else if (op === 9) sendFrame(c, Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
  }
}

const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const cleanName = (n) => String(n || 'Player').replace(/[<>&"]/g, '').slice(0, 14) || 'Player';
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function genCode() {
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += LETTERS[(Math.random() * LETTERS.length) | 0]; } while (rooms.has(c));
  return c;
}
function sendRooms(c) {
  const list = [...rooms.values()].map((g) => g.summary()).filter((r) => r.count < 2);
  send(c, JSON.stringify({ t: 'rooms', list }));
}
function broadcastRooms() { for (const c of clients) if (!c.game) sendRooms(c); }
function enter(c, game, name) {
  const slot = game.join(name);
  if (slot < 0) { send(c, JSON.stringify({ t: 'err', msg: 'That room is full.' })); return; }
  c.game = game; c.slot = slot;
  send(c, JSON.stringify(game.initInfo(slot)));
  console.log(`[+] ${name} joined room ${game.code}`);
  broadcastRooms();
}
function leaveRoom(c) {
  if (!c.game) return;
  const g = c.game; g.leave(c.slot); c.game = null; c.slot = -1;
  if (g.empty()) { rooms.delete(g.code); console.log(`[x] room ${g.code} closed`); }
  broadcastRooms();
}
function onMessage(c, txt) {
  if (txt.length > 2000) return;
  let m; try { m = JSON.parse(txt); } catch { return; }
  if (m.t === 'in') { if (c.game) c.game.input(c.slot, m); }
  else if (m.t === 'list') { if (!c.game) sendRooms(c); }
  else if (m.t === 'create') {
    if (c.game) return;
    const g = createGame(genCode()); rooms.set(g.code, g);
    console.log(`[*] room ${g.code} created`);
    enter(c, g, cleanName(m.name));
  } else if (m.t === 'join') {
    if (c.game) return;
    const code = String(m.code || '').toUpperCase().trim();
    const g = rooms.get(code);
    if (!g) { send(c, JSON.stringify({ t: 'err', msg: 'No room with code ' + code.slice(0, 6) + '.' })); return; }
    enter(c, g, cleanName(m.name));
  } else if (m.t === 'leave') { leaveRoom(c); sendRooms(c); }
}
function onClose(c) { if (!clients.delete(c)) return; leaveRoom(c); }

/* ----------------------------------------------------------------- HTTP */
const INDEX = path.join(__dirname, 'index.html');
const server = http.createServer((req, res) => {
  const pth = req.url.split('?')[0];
  if (pth === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (pth === '/info') {
    const ips = [];
    try { for (const l of Object.values(os.networkInterfaces())) for (const n of l || []) if (n.family === 'IPv4' && !n.internal) ips.push(n.address); } catch (e) {}
    const la = String(req.socket.localAddress || '').replace('::ffff:', '');
    if (/^\d+\.\d+\.\d+\.\d+$/.test(la) && !la.startsWith('127.') && !ips.includes(la)) ips.unshift(la);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ ips })); return;
  }
  if (pth === '/' || pth === '/index.html') {
    fs.readFile(INDEX, (err, data) => {
      if (err) { res.writeHead(500); res.end('index.html missing next to server.js'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  } else { res.writeHead(404); res.end('Not found'); }
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  socket.setNoDelay(true);
  const c = { socket, buf: Buffer.alloc(0), slot: -1, game: null };
  clients.add(c);
  sendRooms(c);
  socket.on('data', (d) => onClientData(c, d));
  socket.on('close', () => onClose(c));
  socket.on('error', () => onClose(c));
});

/* ------------------------------------------------------------ main loop */
// keep idle websockets alive through Render's proxy
setInterval(() => { for (const c of clients) if (c.socket.writable) c.socket.write(Buffer.from([0x89, 0])); }, 25000);
let last = process.hrtime.bigint(), acc = 0, tickN = 0;
setInterval(() => {
  const now = process.hrtime.bigint();
  acc += Number(now - last) / 1e9; last = now;
  if (acc > 0.25) acc = 0.25;
  let n = 0;
  while (acc >= DT) { for (const g of rooms.values()) g.tick(DT); acc -= DT; n++; }
  tickN += n;
  if (tickN >= 2) { // physics 60 Hz, network snapshots 30 Hz (saves bandwidth online)
    tickN = 0;
    for (const g of rooms.values()) {
      const snap = g.snapshot();
      for (const c of clients) if (c.game === g) send(c, snap, true);
    }
  }
}, 8);

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  JETPACK ARENA is running.  Open this on both devices (same Wi-Fi / LAN):\n');
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) for (const n of nets[name]) {
      if (n.family === 'IPv4' && !n.internal) console.log(`     http://${n.address}:${PORT}   (${name})`);
    }
  } catch (e) {}
  console.log(`     http://localhost:${PORT}   (this computer)\n`);
});
