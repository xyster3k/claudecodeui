// Telegram notifier for the LAN stack (QNAP VM cloudcli-lab).
//
// Reads container logs and events from the Docker API (read-only socket) and posts to a
// Telegram forum topic: logins (Google gate + app), app errors, container crashes/OOM/
// restarts, new deploys, and Cloudflare Tunnel outages. No npm dependencies: plain Node 22.
//
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_THREAD_ID (optional),
//      NOTIFY_LABEL (default "LAN"), ERROR_WINDOW_SEC (default 600).

'use strict';

const http = require('node:http');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const THREAD_ID = process.env.TELEGRAM_THREAD_ID || '';
const LABEL = process.env.NOTIFY_LABEL || 'LAN';
const ERROR_WINDOW_MS = Number(process.env.ERROR_WINDOW_SEC || 600) * 1000;
const DOCKER_SOCKET = '/var/run/docker.sock';

const APP = 'claudecodeui';
const WATCHED = [APP, 'oauth2-proxy', 'cloudflared', 'caddy'];

// Tunnel: cloudflared keeps 4 connections and routinely drops/re-registers one within
// seconds. Only report a connection that stays down this long, or all of them going down.
const TUNNEL_GRACE_MS = 60 * 1000;

// App stderr lines that are known to be harmless noise.
const APP_ERROR_IGNORE = [
  /^Failed to delete temp image /,
  /^interrupt\(\) rejected for /,
];

const TELEGRAM_LIMIT = 4000; // API limit is 4096; leave room for the prefix.

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------- Telegram queue

const queue = [];
let sending = false;

function notify(html) {
  const text = `<b>[${escapeHtml(LABEL)}]</b> ${html}`;
  // Never cut a message short: split long ones into consecutive parts.
  if (text.length <= TELEGRAM_LIMIT) {
    queue.push(text);
  } else {
    for (let i = 0; i < text.length; i += TELEGRAM_LIMIT) {
      queue.push(text.slice(i, i + TELEGRAM_LIMIT));
    }
  }
  void drain();
}

function notifyPre(title, body) {
  notify(`${title}\n<pre>${escapeHtml(body)}</pre>`);
}

async function sendOnce(text, parseMode) {
  const payload = { chat_id: CHAT_ID, text, disable_web_page_preview: true };
  if (parseMode) payload.parse_mode = parseMode;
  if (THREAD_ID) payload.message_thread_id = Number(THREAD_ID);
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function drain() {
  if (sending || !TOKEN || !CHAT_ID) return;
  sending = true;
  try {
    while (queue.length) {
      const text = queue[0];
      let delay = 0;
      try {
        let { status, body } = await sendOnce(text, 'HTML');
        if (status === 400 && /parse entities/i.test(body.description || '')) {
          // A split message can cut through an HTML tag; resend that part as plain text.
          ({ status, body } = await sendOnce(text.replace(/<[^>]*>/g, ''), null));
        }
        if (status === 429) {
          delay = ((body.parameters && body.parameters.retry_after) || 5) * 1000;
          log('telegram rate limited, retry in', delay, 'ms');
        } else if (!body.ok) {
          // Permanent rejection (bad chat/thread/token): log and drop, don't loop forever.
          log('telegram rejected message:', status, body.description || '');
          queue.shift();
        } else {
          queue.shift();
        }
      } catch (err) {
        delay = 10000;
        log('telegram send failed, retrying:', err.message);
      }
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }
  } finally {
    sending = false;
  }
}

// ---------------------------------------------------------------- Docker API

function dockerRequest(path, onData, onEnd) {
  const req = http.request({ socketPath: DOCKER_SOCKET, path, method: 'GET' }, (res) => {
    if (res.statusCode !== 200) {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => onEnd(new Error(`docker ${path} -> ${res.statusCode} ${body.trim()}`)));
      return;
    }
    res.on('data', onData);
    res.on('end', () => onEnd(null));
    res.on('error', onEnd);
  });
  req.on('error', onEnd);
  req.end();
  return req;
}

function dockerJson(path) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    dockerRequest(path, (c) => chunks.push(c), (err) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Non-TTY container logs are multiplexed: 8-byte header (stream type, 0,0,0, uint32 size).
function demuxer(onLine) {
  let buf = Buffer.alloc(0);
  const partial = { 1: '', 2: '' };
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8) {
      const size = buf.readUInt32BE(4);
      if (buf.length < 8 + size) break;
      const stream = buf[0] === 2 ? 2 : 1;
      const text = partial[stream] + buf.subarray(8, 8 + size).toString('utf8');
      buf = buf.subarray(8 + size);
      const lines = text.split('\n');
      partial[stream] = lines.pop();
      for (const line of lines) {
        if (line.trim()) onLine(line.replace(/\r$/, ''), stream === 2 ? 'stderr' : 'stdout');
      }
    }
  };
}

function followLogs(name, onLine) {
  let since = Math.floor(Date.now() / 1000);
  const connect = () => {
    const path = `/containers/${name}/logs?follow=1&stdout=1&stderr=1&since=${since}`;
    dockerRequest(path, demuxer(onLine), (err) => {
      // Stream ends when the container stops or is recreated; resume from that moment.
      since = Math.floor(Date.now() / 1000);
      if (err) log(`logs ${name}:`, err.message);
      setTimeout(connect, 5000);
    });
  };
  connect();
}

// ---------------------------------------------------------------- error dedup

const errorWindows = new Map(); // key -> { first, count, timer, sample }

function errorKey(text) {
  return text
    .split('\n')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .slice(0, 300);
}

function reportError(source, text, title = 'error', icon = '❗') {
  const key = `${source}|${errorKey(text)}`;
  const win = errorWindows.get(key);
  if (win) {
    win.count += 1;
    return;
  }
  notifyPre(`${icon} <b>${escapeHtml(source)} ${title}</b>`, text);
  const entry = { count: 0, sample: text };
  entry.timer = setTimeout(() => {
    errorWindows.delete(key);
    if (entry.count > 0) {
      const mins = Math.round(ERROR_WINDOW_MS / 60000);
      notifyPre(`🔁 <b>${escapeHtml(source)} ${title}</b> repeated ×${entry.count} in the last ${mins} min`, entry.sample);
    }
  }, ERROR_WINDOW_MS);
  errorWindows.set(key, entry);
}

// App stderr: group lines arriving close together (stack traces) into one report.
let appErrBuf = [];
let appErrTimer = null;

function onAppStderr(line) {
  if (APP_ERROR_IGNORE.some((re) => re.test(line))) return;
  appErrBuf.push(line);
  clearTimeout(appErrTimer);
  appErrTimer = setTimeout(() => {
    const text = appErrBuf.join('\n');
    appErrBuf = [];
    reportError('App', text);
  }, 1000);
}

// ---------------------------------------------------------------- log rules

function onAppLine(line, stream) {
  const auth = line.match(/^\[AUTH\] login (ok|failed)(?: reason=(\S+))? user=("(?:[^"\\]|\\.)*") ip=(\S+) via=(\S+)/);
  if (auth) {
    const [, outcome, reason, userJson, ip, via] = auth;
    let user = userJson;
    try { user = JSON.parse(userJson); } catch { /* keep raw */ }
    const where = via === 'direct' ? 'LAN :3001' : 'public URL';
    if (outcome === 'ok') {
      notify(`🔑 <b>App login</b>: ${escapeHtml(user)} from ${escapeHtml(ip)} (${where})`);
    } else {
      reportError('App login', `${reason} user=${user} ip=${ip} via ${where}`, 'FAILED', '⚠️');
    }
    return;
  }
  if (stream === 'stderr') onAppStderr(line);
}

function onOauthLine(line) {
  // "<ip> - <reqid> - <email> [<time>] [AuthSuccess] Authenticated via OAuth2: ..."
  const m = line.match(/^(\S+) - \S+ - (\S+) \[[^\]]+\] \[(AuthSuccess|AuthFailure)\] (.*)$/);
  if (!m) return;
  const [, ip, email, kind, detail] = m;
  if (kind === 'AuthSuccess') {
    notify(`🔑 <b>Google login</b>: ${escapeHtml(email)} from ${escapeHtml(ip)}`);
  } else {
    reportError('Google login', `${email} from ${ip}\n${detail}`, 'FAILED', '⚠️');
  }
}

const tunnel = { down: new Map(), reported: false };

function onTunnelLine(line) {
  const idx = (line.match(/connIndex=(\d+)/) || [])[1];
  if (idx === undefined) return;
  if (/Registered tunnel connection/.test(line)) {
    tunnel.down.delete(idx);
    if (tunnel.reported && tunnel.down.size === 0) {
      tunnel.reported = false;
      notify('🟢 <b>Tunnel restored</b>: all connections registered again');
    }
  } else if (/Connection terminated|Unregistered tunnel connection|Serve tunnel error/.test(line)) {
    if (!tunnel.down.has(idx)) tunnel.down.set(idx, { since: Date.now(), line });
  }
}

setInterval(() => {
  if (tunnel.reported || tunnel.down.size === 0) return;
  const now = Date.now();
  const stale = [...tunnel.down.values()].filter((d) => now - d.since >= TUNNEL_GRACE_MS);
  if (stale.length) {
    tunnel.reported = true;
    notifyPre(
      `🔴 <b>Tunnel degraded</b>: ${tunnel.down.size} connection(s) down for over ${TUNNEL_GRACE_MS / 1000}s — the public URL may be unreachable`,
      stale[0].line,
    );
  }
}, 15000);

// ---------------------------------------------------------------- container events

const imageIds = new Map(); // container name -> image id at last start

async function rememberImage(name) {
  try {
    const info = await dockerJson(`/containers/${name}/json`);
    const previous = imageIds.get(name);
    imageIds.set(name, info.Image);
    return { previous, current: info.Image, created: info.Created };
  } catch {
    return null;
  }
}

function shortId(id) {
  return String(id || '').replace(/^sha256:/, '').slice(0, 12);
}

async function onEvent(ev) {
  const name = ev.Actor && ev.Actor.Attributes && ev.Actor.Attributes.name;
  if (!WATCHED.includes(name)) return;
  const action = ev.Action || ev.status;
  if (action === 'die') {
    const code = ev.Actor.Attributes.exitCode;
    // 0/143 = clean stop or SIGTERM (docker stop / recreate); 137 = SIGKILL (stop timeout,
    // or OOM, which also emits its own "oom" event); anything else is a crash.
    let what = 'crashed';
    let icon = '💥';
    if (code === '0' || code === '143') {
      what = 'stopped';
      icon = '⏹';
    } else if (code === '137') {
      what = 'killed (SIGKILL)';
      icon = '⚠️';
    }
    notify(`${icon} <b>${escapeHtml(name)}</b> ${what} (exit ${escapeHtml(code)})`);
  } else if (action === 'oom') {
    notify(`💥 <b>${escapeHtml(name)}</b> was killed: out of memory`);
  } else if (action === 'start') {
    const img = await rememberImage(name);
    if (img && img.previous && img.previous !== img.current) {
      notify(`🚀 <b>${escapeHtml(name)}</b> new version deployed (image ${shortId(img.previous)} → ${shortId(img.current)})`);
    } else {
      notify(`▶️ <b>${escapeHtml(name)}</b> started`);
    }
  }
}

function followEvents() {
  const filters = encodeURIComponent(JSON.stringify({ type: ['container'], event: ['die', 'oom', 'start'] }));
  let buf = '';
  dockerRequest(`/events?filters=${filters}`, (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        void onEvent(JSON.parse(line));
      } catch (err) {
        log('bad event line:', err.message);
      }
    }
  }, (err) => {
    if (err) log('events:', err.message);
    setTimeout(followEvents, 5000);
  });
}

// ---------------------------------------------------------------- main

async function main() {
  if (!TOKEN || !CHAT_ID) {
    log('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set; notifier idle. Set them in /srv/stack/.env.');
    setInterval(() => {}, 1 << 30);
    return;
  }
  for (const name of WATCHED) await rememberImage(name);

  followEvents();
  followLogs(APP, onAppLine);
  followLogs('oauth2-proxy', onOauthLine);
  followLogs('cloudflared', onTunnelLine);

  const app = imageIds.get(APP);
  notify(`📡 Notifier started; watching ${WATCHED.join(', ')}${app ? ` (app image ${shortId(app)})` : ''}`);
  log('notifier running; label', LABEL, 'chat', CHAT_ID, 'thread', THREAD_ID || '-');
}

if (require.main === module) {
  process.on('unhandledRejection', (err) => log('unhandled rejection:', err && err.stack ? err.stack : err));
  process.on('uncaughtException', (err) => log('uncaught exception:', err && err.stack ? err.stack : err));
  main();
} else {
  // Exposed for local testing of the parsers only.
  module.exports = { demuxer, onAppLine, onOauthLine, onTunnelLine, onEvent, queue, tunnel, imageIds };
}
