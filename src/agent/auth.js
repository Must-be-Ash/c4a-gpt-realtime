// Minimal password + signed-cookie auth for the private hosted deployment.
// A request is authorized if it carries a valid session cookie OR the internal
// service token (used by the tool registry's own localhost fetches). When no
// password is configured (local dev), auth is disabled and everything passes.

import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "c4a_session";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verify(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(mac, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!payload.iat || Date.now() - payload.iat > MAX_AGE_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
      const index = part.indexOf("=");
      return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
    }),
  );
}

export function loginPageHtml(message = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#080a0f" />
<title>Sign in — Voice Trading Agent</title>
<script>try{document.documentElement.dataset.theme=localStorage.getItem("coinbase-agents-theme")||(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");}catch{document.documentElement.dataset.theme="dark";}</script>
<link rel="stylesheet" href="/styles.css" />
<style>
  .login-wrap{min-height:90vh;display:flex;align-items:center;justify-content:center;}
  .login-card{width:min(360px,92vw);background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:26px;box-shadow:0 16px 60px var(--shadow);}
  .login-card h1{font-size:17px;margin:0 0 4px;}
  .login-card p{color:var(--muted);font-size:13px;margin:0 0 18px;}
  .login-card input{width:100%;padding:11px 13px;border-radius:9px;border:1px solid var(--line-strong);background:var(--surface-2);color:var(--text);font-size:14px;}
  .login-card button{width:100%;margin-top:12px;padding:11px;border-radius:9px;border:none;background:var(--accent);color:#fff;font-size:14px;font-weight:600;cursor:pointer;}
  .login-err{color:var(--red);font-size:12px;margin-top:10px;min-height:14px;}
</style></head>
<body><div class="login-wrap"><form class="login-card" method="POST" action="/login">
<h1>Voice trading agent</h1><p>Private dashboard. Enter your password to continue.</p>
<input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" />
<button type="submit">Sign in</button>
<div class="login-err">${message}</div>
</form></div></body></html>`;
}

export function createAuth({ password, secret }) {
  const enabled = Boolean(password && secret);

  function authed(request) {
    if (safeEqual(request.headers["x-internal-token"], secret)) return true;
    return Boolean(verify(parseCookies(request.headers.cookie)[COOKIE], secret));
  }

  function requireAuth(request, response, next) {
    if (!enabled || authed(request)) { next(); return; }
    if (request.path.startsWith("/api/") || request.path.startsWith("/vapi/")) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    response.redirect(`/login?next=${encodeURIComponent(request.originalUrl)}`);
  }

  function login(request, response) {
    const provided = String(request.body?.password ?? "");
    if (!enabled || !safeEqual(provided, password)) {
      response.status(401).type("html").send(loginPageHtml("Incorrect password."));
      return;
    }
    const token = sign({ iat: Date.now() }, secret);
    const secure = request.secure || request.headers["x-forwarded-proto"] === "https";
    response.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_MS / 1000}${secure ? "; Secure" : ""}`);
    const next = typeof request.query.next === "string" && request.query.next.startsWith("/") ? request.query.next : "/dashboard";
    response.redirect(next);
  }

  return { enabled, authed, requireAuth, login };
}
