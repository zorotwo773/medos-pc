#!/usr/bin/env python3
"""
MedOS startup status server.
Serves a live browser status page on port 4321 while backend + frontend start up.
Shuts itself down ~35 s after both services are healthy (after auto-redirect fires).
"""
import http.server
import ctypes
import json
import os
import socket
import threading
import time
import urllib.request
from pathlib import Path

PORT = 4321
APP_DIR = Path(__file__).parent
LAN_IP = os.environ.get("MEDOS_LAN_IP", "localhost")

# ── HTML status page ──────────────────────────────────────────────────────────
HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MedOS — Starting</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#07090f;color:#cbd5e1;font-family:'SF Mono',Consolas,'Courier New',monospace;
  min-height:100vh;display:flex;flex-direction:column;align-items:center;
  justify-content:center;padding:2rem;gap:0}
.brand{display:flex;align-items:baseline;gap:0.5rem;margin-bottom:0.35rem}
.logo{font-size:1.9rem;font-weight:700;letter-spacing:0.08em;
  background:linear-gradient(135deg,#60a5fa,#818cf8);-webkit-background-clip:text;
  -webkit-text-fill-color:transparent;background-clip:text}
.version{font-size:0.75rem;color:#334155;letter-spacing:0.05em}
.tagline{font-size:0.78rem;color:#334155;margin-bottom:2.5rem;letter-spacing:0.03em}
.cards{display:flex;flex-direction:column;gap:1rem;width:100%;max-width:600px}
.card{background:#0d1117;border:1px solid #1e293b;border-radius:10px;
  padding:1rem 1.25rem;transition:border-color .3s}
.card.card-ready{border-color:#166534}
.card.card-error{border-color:#7f1d1d}
.card-head{display:flex;align-items:center;gap:0.65rem;margin-bottom:0.55rem}
.dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;transition:background .4s}
.dot-wait{background:#1e293b;animation:blink 2s ease-in-out infinite}
.dot-boot{background:#d97706;animation:blink 0.7s ease-in-out infinite}
.dot-up  {background:#22c55e}
.dot-err {background:#ef4444}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.25}}
.svc-name{font-size:0.85rem;font-weight:600;color:#94a3b8;letter-spacing:0.04em}
.svc-badge{margin-left:auto;font-size:0.7rem;color:#334155;letter-spacing:0.03em}
.svc-badge.badge-up{color:#4ade80}
.svc-badge.badge-err{color:#f87171}
.log-box{font-size:0.68rem;line-height:1.65;color:#334155;
  display:flex;flex-direction:column;gap:1px;min-height:1.65em}
.line{white-space:pre;overflow:hidden;text-overflow:ellipsis}
.line-ok{color:#4ade80}.line-warn{color:#fbbf24}.line-err{color:#f87171}
.line-info{color:#475569}

.ready-box{display:none;flex-direction:column;align-items:center;gap:0.85rem;
  margin-top:2rem;width:100%;max-width:600px;animation:fadein .5s ease}
.ready-box.show{display:flex}
@keyframes fadein{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.open-btn{display:inline-flex;align-items:center;gap:0.5rem;background:#1d4ed8;
  color:#fff;font-family:inherit;font-size:0.95rem;font-weight:600;
  padding:0.75rem 2rem;border-radius:8px;border:none;cursor:pointer;
  text-decoration:none;transition:background .2s,transform .1s}
.open-btn:hover{background:#2563eb;transform:translateY(-1px)}
.app-url{font-size:0.78rem;color:#3b82f6;letter-spacing:0.02em}
.countdown{font-size:0.72rem;color:#334155}
.lan-hint{font-size:0.7rem;color:#475569;margin-top:0.15rem;letter-spacing:0.02em}
.divider{width:100%;max-width:600px;height:1px;background:#0f172a;margin:2.5rem 0 0}
.hint{font-size:0.68rem;color:#1e293b;margin-top:0.75rem}
</style>
</head>
<body>
<div class="brand"><span class="logo">MedOS</span><span class="version">v1</span></div>
<div class="tagline">Clinical Intelligence Platform &nbsp;·&nbsp; Starting up…</div>

<div class="cards">
  <div class="card" id="card-be">
    <div class="card-head">
      <div class="dot dot-wait" id="dot-be"></div>
      <span class="svc-name">Backend &nbsp;<span style="color:#334155;font-weight:400">FastAPI · :8002</span></span>
      <span class="svc-badge" id="badge-be">waiting</span>
    </div>
    <div class="log-box" id="log-be"><span class="line line-info">—</span></div>
  </div>
  <div class="card" id="card-fe">
    <div class="card-head">
      <div class="dot dot-wait" id="dot-fe"></div>
      <span class="svc-name">Frontend &nbsp;<span style="color:#334155;font-weight:400">Next.js · :3000</span></span>
      <span class="svc-badge" id="badge-fe">waiting</span>
    </div>
    <div class="log-box" id="log-fe"><span class="line line-info">—</span></div>
  </div>
</div>

<div class="ready-box" id="ready-box">
  <a class="open-btn" id="open-btn" href="#">Open MedOS &rarr;</a>
  <span class="app-url" id="app-url"></span>
  <span class="countdown" id="countdown"></span>
  <span class="lan-hint" id="lan-hint"></span>
  <span class="first-run-hint" style="font-size:0.8rem;color:#64748b;max-width:30rem;text-align:center;line-height:1.5">
    First launch warms up search &amp; reference indexes in the background — the app may feel
    a little slow for the first ~30&ndash;60&nbsp;seconds, then it settles. Later launches are quick.
  </span>
</div>

<div class="divider"></div>
<div class="hint">Logs: app\backend.log &nbsp;·&nbsp; app\frontend.log &nbsp;·&nbsp; This window closes automatically.</div>

<script>
let launched = false, timer = null;

function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

function lineClass(s){
  const l=s.toLowerCase();
  if(/error|fatal|failed|exception|heap out/.test(l)) return 'line-err';
  if(/warn/.test(l)) return 'line-warn';
  if(/ready|started|complete|running|✓|▲/.test(l)) return 'line-ok';
  return 'line-info';
}

function applyService(id, d){
  const dot=document.getElementById('dot-'+id);
  const badge=document.getElementById('badge-'+id);
  const card=document.getElementById('card-'+id);
  const log=document.getElementById('log-'+id);

  dot.className='dot '+(d.state==='ready'?'dot-up':d.state==='error'?'dot-err':d.state==='loading'?'dot-boot':'dot-wait');
  badge.textContent=d.label;
  badge.className='svc-badge'+(d.state==='ready'?' badge-up':d.state==='error'?' badge-err':'');
  card.className='card'+(d.state==='ready'?' card-ready':d.state==='error'?' card-error':'');

  if(d.lines && d.lines.length){
    log.innerHTML=d.lines.map(l=>`<span class="line ${lineClass(l)}">${esc(l)}</span>`).join('');
  }
}

function startCountdown(url){
  let n=6;
  const el=document.getElementById('countdown');
  timer=setInterval(()=>{
    n--;
    el.textContent='Opening in '+n+'s…';
    if(n<=0){clearInterval(timer);window.location.href=url;}
  },1000);
  el.textContent='Opening in '+n+'s…';
}

async function poll(){
  try{
    const r=await fetch('/api/status');
    if(!r.ok) throw new Error();
    const d=await r.json();
    applyService('be',d.backend);
    applyService('fe',d.frontend);

    if(d.ready && !launched){
      launched=true;
      const box=document.getElementById('ready-box');
      const btn=document.getElementById('open-btn');
      const url=document.getElementById('app-url');
      btn.href=d.app_url;
      url.textContent=d.app_url;
      if(d.lan_url && d.lan_url!==d.app_url){
        document.getElementById('lan-hint').textContent='On a phone or tablet (same Wi-Fi): '+d.lan_url;
      }
      box.classList.add('show');
      startCountdown(d.app_url);
      return; // stop polling
    }
  }catch(e){}
  if(!launched) setTimeout(poll,600);
}

poll();
</script>
</body>
</html>
"""


# ── Helpers ──────────────────────────────────────────────────────────────────

def is_up(port: int) -> bool:
    try:
        s = socket.create_connection(("127.0.0.1", port), timeout=0.2)
        s.close()
        return True
    except OSError:
        return False


def http_ready(port: int, path: str = "/health", timeout: float = 1.5) -> bool:
    """True only when the service actually answers HTTP — not just when its port
    is bound. uvicorn binds 8002 before its startup warm-up finishes and accepts
    TCP connections meanwhile, so a raw socket check reports the backend 'up'
    while requests still hang. Redirecting on that races the app's first calls
    (/me, /activity) into ECONNRESET. Checking /health waits for real readiness."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=timeout) as r:
            return 200 <= getattr(r, "status", r.getcode()) < 500
    except Exception:
        return False


def tail(path: Path, n: int = 6) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace").strip()
        lines = [l for l in text.splitlines() if l.strip()]
        return lines[-n:]
    except Exception:
        return []


# Lines that contain scary words ("error"/"exception") but are HARMLESS — chiefly the
# Windows asyncio Proactor ConnectionResetError [WinError 10054] that uvicorn logs every
# time a client drops a connection mid-response. Treating these as real errors made a
# fully-healthy backend (still answering /health 200) show a red "error" card on boot.
_BENIGN_NOISE = (
    "connectionreseterror",
    "connectionabortederror",
    "brokenpipeerror",
    "winerror 10054",
    "winerror 10053",
    "_call_connection_lost",
    "_proactorbasepipetransport",
    "an existing connection was forcibly closed",
)


def _is_benign(line: str) -> bool:
    low = line.lower()
    return any(token in low for token in _BENIGN_NOISE)


def has_error(lines: list[str]) -> bool:
    return any(
        not _is_benign(line)
        and (
            "error" in line.lower()
            or "fatal" in line.lower()
            or "failed" in line.lower()
            or "exception" in line.lower()
            or "heap out" in line.lower()
            or "could not find" in line.lower()
        )
        for line in lines
    )


def service_lines(log_path: Path, err_path: Path) -> list[str]:
    out_lines = tail(log_path)
    # Drop benign connection-reset noise before looking at / showing the error stream, so
    # it neither flips the card to "error" nor fills the boot screen with scary tracebacks.
    err_lines = [l for l in tail(err_path, 40) if not _is_benign(l)][-6:]
    if has_error(err_lines):
        return (out_lines[-3:] + err_lines)[-8:]
    if out_lines and err_lines:
        return (out_lines + err_lines)[-8:]
    return out_lines or err_lines


def pid_running(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            if not ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return False
            return exit_code.value == 259
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def pid_file_stopped(path: Path) -> bool:
    try:
        text = path.read_text(encoding="utf-8", errors="replace").strip()
        if not text:
            return False
        return not pid_running(int(text))
    except Exception:
        return False


def get_status() -> dict:
    # Backend: require a real HTTP response (not just an open port) so the app is
    # only redirected to once the backend can actually serve requests.
    be_up = http_ready(8002, "/health")
    fe_up = is_up(3000)

    be_lines = service_lines(APP_DIR / "backend.log", APP_DIR / "backend.err")
    fe_lines = service_lines(APP_DIR / "frontend.log", APP_DIR / "frontend.err")

    def svc(up: bool, lines: list[str], pid_path: Path) -> dict:
        if up:
            return {"state": "ready", "label": "running", "ready": True, "lines": lines}
        if pid_file_stopped(pid_path):
            stopped_lines = lines + ["Process stopped before its port became reachable."]
            return {"state": "error", "label": "stopped", "ready": False, "lines": stopped_lines[-8:]}
        if has_error(lines):
            return {"state": "error", "label": "error", "ready": False, "lines": lines}
        if lines:
            return {"state": "loading", "label": "starting…", "ready": False, "lines": lines}
        return {"state": "waiting", "label": "waiting", "ready": False, "lines": []}

    return {
        "backend": svc(be_up, be_lines, APP_DIR / "backend.pid"),
        "frontend": svc(fe_up, fe_lines, APP_DIR / "frontend.pid"),
        "ready": be_up and fe_up,
        # Redirect the LOCAL browser to loopback — always bound (Next listens on
        # 0.0.0.0) and reachable regardless of which network adapter was detected. The
        # old LAN-IP target could land on a VPN/virtual NIC or an unreachable address.
        # Use the IPv4 literal, never "localhost": on Windows+Node "localhost" resolves
        # to IPv6 ::1 first while Next binds IPv4 only. LAN IP is shown as a phone hint.
        "app_url": "http://127.0.0.1:3000",
        "lan_url": f"http://{LAN_IP}:3000",
    }


# ── HTTP handler ──────────────────────────────────────────────────────────────

_stop = threading.Event()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # silence access log

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            body = HTML.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        elif self.path == "/api/status":
            data = get_status()
            body = json.dumps(data).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        else:
            self.send_response(404)
            self.end_headers()


def _watcher():
    """Shut down ~35 s after both services are healthy (time for browser redirect)."""
    while not _stop.is_set():
        if get_status()["ready"]:
            time.sleep(35)
            _stop.set()
            return
        time.sleep(1)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    srv = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
    srv.timeout = 0.5
    threading.Thread(target=_watcher, daemon=True).start()
    while not _stop.is_set():
        srv.handle_request()
    srv.server_close()
