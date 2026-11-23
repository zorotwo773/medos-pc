"""
MedOS LAN auto-sync — zero-config peer-to-peer Q-Bank progression sync.

Every running MedOS backend is a *node* with a stable id (data/sync_node.json).
A small UDP beacon announces the node on the local network; a listener collects
beacons from sibling nodes. A background loop then periodically pulls each live
peer's Q-Bank progression (GET /sync/export) and UNION-merges it into the local
qbank_progress via activity_store.merge_progress (idempotent), so every device
on the LAN converges to the union of all answered/marked QIDs — no manual
export/import.

Design choices
--------------
* **No new dependencies.** Pure stdlib: socket / threading / json / urllib.
* **Union-only merge.** A peer can only *add* answered/marked QIDs, never delete
  yours, so trust-on-LAN is safe for a personal home network. Set
  ``MEDOS_SYNC_TOKEN`` to require a shared secret on the peer-facing endpoints.
* **Convergent + idempotent.** ``used_ids`` only grow, so repeated rounds settle
  to the union and then go quiet (digests match → nothing pulled).
* **Runtime toggle.** Threads keep running but no-op while disabled, so the
  Settings switch takes effect without a restart.

This module is intentionally self-contained: routers/sync.py exposes the HTTP
surface, main.py calls :func:`start` once at boot.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import socket
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any, Optional

import activity_store as A
from config import ROOT
from qbank_reader import _json_loads, _normalize_id_list, _upsert_session, _utc_now

# ─── Tunables (env-overridable) ──────────────────────────────────────────────
DISCOVERY_PORT = int((os.getenv("MEDOS_SYNC_PORT") or "48653").strip() or 48653)
BEACON_INTERVAL = 4.0      # seconds between outgoing beacons (≤ phone listen window)
SYNC_INTERVAL = 20.0       # seconds between pull rounds
PEER_TTL = 60.0            # a peer is "live" if seen within this many seconds
HTTP_TIMEOUT = 4.0         # per peer HTTP request
_MAGIC = "medos-sync"
_PROTO = 1
_HISTORY_MAX = 12

_NODE_FILE = ROOT / "data" / "sync_node.json"

# ─── Process state ───────────────────────────────────────────────────────────
_LOCK = threading.RLock()
_PEERS: dict[str, dict] = {}            # node_id -> peer record
_STATS: dict[str, Any] = {"last_sync_at": None, "last_result": None, "history": []}
_WAKE = threading.Event()               # set to trigger an immediate round
_SERVICE_STARTED = False
_HTTP_PORT = 8002
_LAN_IP = ""
_IDENTITY: Optional[dict] = None


# ─── Identity / settings ─────────────────────────────────────────────────────
def load_identity() -> dict:
    """Stable node identity, created on first run. Cached for the process."""
    global _IDENTITY
    if _IDENTITY is not None:
        return _IDENTITY
    data: dict = {}
    try:
        if _NODE_FILE.exists():
            data = json.loads(_NODE_FILE.read_text(encoding="utf-8")) or {}
    except Exception:
        data = {}
    changed = False
    if not data.get("node_id"):
        data["node_id"] = secrets.token_hex(8)
        changed = True
    if not data.get("name"):
        try:
            data["name"] = socket.gethostname() or "MedOS device"
        except Exception:
            data["name"] = "MedOS device"
        changed = True
    if "enabled" not in data:
        data["enabled"] = True
        changed = True
    if "created_at" not in data:
        data["created_at"] = _utc_now()
        changed = True
    if changed:
        _save_identity(data)
    _IDENTITY = data
    return data


def _save_identity(data: dict) -> None:
    try:
        _NODE_FILE.parent.mkdir(parents=True, exist_ok=True)
        _NODE_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception as exc:  # pragma: no cover - disk failures shouldn't crash
        print(f"[sync] could not persist node identity: {exc}")


def set_enabled(on: bool) -> bool:
    ident = load_identity()
    ident["enabled"] = bool(on)
    _save_identity(ident)
    if on:
        _WAKE.set()
    return ident["enabled"]


def set_device_name(name: str) -> str:
    ident = load_identity()
    clean = (name or "").strip()[:60]
    if clean:
        ident["name"] = clean
        _save_identity(ident)
    return ident["name"]


def is_enabled() -> bool:
    # Hard kill-switch via env, otherwise the persisted toggle.
    if (os.getenv("MEDOS_LAN_SYNC") or "").strip().lower() in {"0", "false", "no", "off"}:
        return False
    return bool(load_identity().get("enabled", True))


def _token() -> str:
    return (os.getenv("MEDOS_SYNC_TOKEN") or "").strip()


def _token_fingerprint() -> str:
    tok = _token()
    return hashlib.sha256(tok.encode("utf-8")).hexdigest()[:8] if tok else ""


def token_ok(presented: Optional[str]) -> bool:
    """True when the caller may use the peer-facing endpoints."""
    tok = _token()
    if not tok:
        return True  # trust-on-LAN
    return secrets.compare_digest((presented or "").strip(), tok)


# ─── Owner resolution ────────────────────────────────────────────────────────
def owner_email() -> str:
    """The user whose progression this node syncs.

    Personal deployments are effectively single-user. We prefer an explicit
    override, then the dev-mode legacy identity, then the sole real account.
    """
    override = (os.getenv("MEDOS_SYNC_USER") or "").strip()
    if override:
        return override
    try:
        import auth as _auth
        if not _auth.GATE_ENABLED:
            return _auth.LEGACY_USER_EMAIL
        users = _auth.list_users()
        non_admin = [u for u in users if u.get("username") != "admin"]
        pool = non_admin or users
        if len(pool) == 1:
            return _auth.user_email(pool[0]["username"])
        return _auth.LEGACY_USER_EMAIL
    except Exception:
        return "legacy@medos"


# ─── Local progression snapshot ──────────────────────────────────────────────
def _owner_progress(c, owner: str) -> tuple[dict[str, list[int]], dict[str, list[int]]]:
    rows = c.execute(
        "SELECT db, used_ids, marked_ids FROM qbank_progress WHERE user_email=?",
        (owner,),
    ).fetchall()
    used: dict[str, list[int]] = {}
    marked: dict[str, list[int]] = {}
    for r in rows:
        u = _normalize_id_list(_json_loads(r["used_ids"], []))
        m = _normalize_id_list(_json_loads(r["marked_ids"], []))
        if u:
            used[r["db"]] = sorted(u)
        if m:
            marked[r["db"]] = sorted(m)
    return used, marked


def _owner_sessions(c, owner: str) -> list[dict]:
    """Full session payloads (blocks with per-question answered choices + result)."""
    rows = c.execute(
        "SELECT payload FROM qbank_sessions WHERE user_email=? ORDER BY updated_at DESC LIMIT 2000",
        (owner,),
    ).fetchall()
    out: list[dict] = []
    for r in rows:
        p = _json_loads(r["payload"], None)
        if isinstance(p, dict) and p.get("id"):
            out.append(p)
    return out


def _digest(used: dict, marked: dict, sessions: list[dict]) -> str:
    # A block may be completed without adding a question or changing its id.
    # Hash the same bounded session snapshots that /export actually transfers.
    blob = json.dumps(
        {"u": used, "m": marked, "s": sorted(sessions, key=lambda s: str(s["id"]))},
        sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def local_manifest() -> dict:
    """Lightweight summary a peer can diff against without pulling everything."""
    owner = owner_email()
    ident = load_identity()
    c = A.aconn()
    try:
        used, marked = _owner_progress(c, owner)
        sessions = _owner_sessions(c, owner)
    finally:
        c.close()
    banks = {}
    for db in set(used) | set(marked):
        banks[db] = {"used": len(used.get(db, [])), "marked": len(marked.get(db, []))}
    return {
        "node_id": ident["node_id"],
        "name": ident["name"],
        "user": owner,
        "digest": _digest(used, marked, sessions),
        "banks": banks,
        "sessions": len(sessions),
        "generated_at": _utc_now(),
    }


def local_export() -> dict:
    """Full progression payload: the QID ledger PLUS the session/block records
    (each carrying its per-question answered choices and correct/incorrect)."""
    owner = owner_email()
    ident = load_identity()
    c = A.aconn()
    try:
        used, marked = _owner_progress(c, owner)
        sessions = _owner_sessions(c, owner)
    finally:
        c.close()
    return {
        "version": 2,
        "app": "medos",
        "kind": "sync",
        "node_id": ident["node_id"],
        "name": ident["name"],
        "user": owner,
        "digest": _digest(used, marked, sessions),
        "qbank": {"usedIdsByDb": used, "markedIdsByDb": marked},
        "sessions": sessions,
        "exported_at": _utc_now(),
    }


def _merge_sessions(c, owner: str, sessions) -> dict:
    """Merge incoming block records. Append-only by session id, so a peer can
    only ADD blocks, never overwrite ours — that gives the desktop (the long-
    lived store where most blocks originate) priority on any discrepancy. The
    one update we allow is active→completed for a block we already hold.
    """
    added = 0
    completed = 0
    if not isinstance(sessions, list):
        return {"sessionsAdded": 0, "sessionsCompleted": 0}
    for s in sessions:
        if not isinstance(s, dict):
            continue
        sid = str(s.get("id") or "").strip()
        if not sid:
            continue
        row = c.execute("SELECT status FROM qbank_sessions WHERE id=?", (sid,)).fetchone()
        try:
            if row is None:
                _upsert_session(c, s, owner)
                added += 1
            elif row["status"] != "completed" and s.get("completedAt"):
                _upsert_session(c, s, owner)   # promote our active copy to the completed one
                completed += 1
            # else: keep the local copy (priority to whatever we already have)
        except Exception as exc:  # a malformed/foreign session shouldn't abort the round
            print(f"[sync] skip session {sid}: {exc}")
    return {"sessionsAdded": added, "sessionsCompleted": completed}


class SyncIdentityChanged(ValueError):
    """A paired caller's target no longer matches this node/account."""


def apply_payload(payload: dict) -> dict:
    """UNION-merge an incoming payload into the local owner state: the QID ledger
    (used grows, marked union) plus the session/block records (append-only)."""
    owner = owner_email()
    expected_node = payload.get("expected_node_id")
    expected_user = payload.get("expected_user")
    if expected_node is not None or expected_user is not None:
        if expected_node != load_identity()["node_id"] or expected_user != owner:
            raise SyncIdentityChanged("sync desktop/account changed")
    qbank = payload.get("qbank") if isinstance(payload.get("qbank"), dict) else {}
    used = qbank.get("usedIdsByDb") or payload.get("usedIdsByDb")
    marked = qbank.get("markedIdsByDb") or payload.get("markedIdsByDb")
    sessions = payload.get("sessions")
    c = A.aconn()
    try:
        summary = A.merge_progress(c, owner, used, marked)
        summary.update(_merge_sessions(c, owner, sessions))
        c.commit()
        return summary
    finally:
        c.close()


# ─── Peer registry ───────────────────────────────────────────────────────────
def _is_live(peer: dict, now: Optional[float] = None) -> bool:
    now = now if now is not None else time.time()
    return (now - peer.get("last_seen", 0)) <= PEER_TTL


def _public_peer(peer: dict) -> dict:
    return {
        "node_id": peer.get("node_id"),
        "name": peer.get("name"),
        "ip": peer.get("ip"),
        "port": peer.get("port"),
        "user": peer.get("user"),
        "paired": peer.get("token_fp", "") == _token_fingerprint(),
        "last_seen_ago": round(time.time() - peer.get("last_seen", 0), 1),
        "last_sync_at": peer.get("last_sync_at"),
        "last_synced": peer.get("last_synced"),
    }


def _remember_peer(addr_ip: str, msg: dict) -> None:
    node_id = msg.get("node")
    ident = load_identity()
    if not node_id or node_id == ident["node_id"]:
        return  # ignore our own beacon
    with _LOCK:
        peer = _PEERS.get(node_id, {"node_id": node_id})
        peer.update({
            "name": msg.get("name") or peer.get("name") or "MedOS device",
            "ip": addr_ip,
            "port": int(msg.get("http") or _HTTP_PORT),
            "user": msg.get("user"),
            "token_fp": msg.get("tok", ""),
            "last_seen": time.time(),
        })
        _PEERS[node_id] = peer


# ─── Networking threads ──────────────────────────────────────────────────────
def _beacon_bytes() -> bytes:
    ident = load_identity()
    return json.dumps({
        "magic": _MAGIC,
        "v": _PROTO,
        "node": ident["node_id"],
        "name": ident["name"],
        "http": _HTTP_PORT,
        "user": owner_email(),
        "tok": _token_fingerprint(),
        "ts": int(time.time()),
    }).encode("utf-8")


def _broadcast_targets() -> list[str]:
    targets = ["255.255.255.255"]
    if _LAN_IP and _LAN_IP.count(".") == 3:
        parts = _LAN_IP.split(".")
        parts[-1] = "255"
        directed = ".".join(parts)
        if directed not in targets:
            targets.append(directed)
    return targets


def _broadcaster() -> None:
    while True:
        try:
            if is_enabled():
                sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                try:
                    data = _beacon_bytes()
                    for tgt in _broadcast_targets():
                        try:
                            sock.sendto(data, (tgt, DISCOVERY_PORT))
                        except OSError:
                            pass
                finally:
                    sock.close()
        except Exception as exc:  # pragma: no cover
            print(f"[sync] beacon error: {exc}")
        time.sleep(BEACON_INTERVAL)


def _listener() -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if hasattr(socket, "SO_REUSEPORT"):
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        except OSError:
            pass
    try:
        sock.bind(("", DISCOVERY_PORT))
    except OSError as exc:
        print(f"[sync] cannot bind discovery port {DISCOVERY_PORT}: {exc} — discovery disabled")
        return
    sock.settimeout(1.0)
    while True:
        try:
            raw, addr = sock.recvfrom(4096)
        except socket.timeout:
            continue
        except OSError:
            time.sleep(0.5)
            continue
        if not is_enabled():
            continue
        try:
            msg = json.loads(raw.decode("utf-8", "ignore"))
        except Exception:
            continue
        if not isinstance(msg, dict) or msg.get("magic") != _MAGIC:
            continue
        _remember_peer(addr[0], msg)


# ─── HTTP peer fetch ─────────────────────────────────────────────────────────
def _http_get(url: str) -> Optional[dict]:
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    tok = _token()
    if tok:
        req.add_header("X-MedOS-Sync-Token", tok)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            if resp.status != 200:
                return None
            return json.loads(resp.read().decode("utf-8", "ignore"))
    except Exception:
        return None


def _pull_from_peer(peer: dict, local_dig: str) -> Optional[dict]:
    owner = owner_email()
    if peer.get("user") != owner or peer.get("token_fp", "") != _token_fingerprint():
        return None

    def matches(payload: dict) -> bool:
        return isinstance(payload, dict) and payload.get("node_id") == peer.get("node_id") and payload.get("user") == owner

    base = f"http://{peer['ip']}:{peer['port']}"
    manifest = _http_get(f"{base}/sync/manifest")
    if not matches(manifest):
        return None
    if manifest.get("digest") == local_dig:
        return {"node_id": peer["node_id"], "name": peer.get("name"), "upToDate": True}
    export = _http_get(f"{base}/sync/export")
    if not matches(export):
        return None
    summary = apply_payload({**export, "expected_node_id": load_identity()["node_id"], "expected_user": owner})
    result = {
        "node_id": peer["node_id"],
        "name": peer.get("name"),
        "upToDate": False,
        "usedAdded": summary.get("usedAdded", 0),
        "markedAdded": summary.get("markedAdded", 0),
        "sessionsAdded": summary.get("sessionsAdded", 0),
        "banksTouched": summary.get("banksTouched", 0),
    }
    with _LOCK:
        p = _PEERS.get(peer["node_id"])
        if p is not None:
            p["last_sync_at"] = _utc_now()
            p["last_synced"] = (
                result["usedAdded"] + result["markedAdded"] + result["sessionsAdded"]
            )
    return result


def run_round() -> dict:
    """One synchronous pull round across all live peers. Returns a summary."""
    if not is_enabled():
        return {"enabled": False, "peers": 0, "results": []}
    now = time.time()
    with _LOCK:
        peers = [dict(p) for p in _PEERS.values() if _is_live(p, now)]
    manifest = local_manifest()
    local_dig = manifest["digest"]
    results = []
    for peer in peers:
        try:
            r = _pull_from_peer(peer, local_dig)
            if r:
                results.append(r)
        except Exception as exc:  # pragma: no cover
            print(f"[sync] pull from {peer.get('name')} failed: {exc}")
    added = sum(
        r.get("usedAdded", 0) + r.get("markedAdded", 0) + r.get("sessionsAdded", 0)
        for r in results
    )
    summary = {
        "enabled": True,
        "at": _utc_now(),
        "peers": len(peers),
        "added": added,
        "results": results,
    }
    with _LOCK:
        _STATS["last_sync_at"] = summary["at"]
        _STATS["last_result"] = summary
        hist = _STATS.get("history", [])
        if added or results:
            hist.insert(0, {"at": summary["at"], "peers": len(peers), "added": added})
            _STATS["history"] = hist[:_HISTORY_MAX]
    return summary


def _sync_loop() -> None:
    while True:
        triggered = _WAKE.wait(timeout=SYNC_INTERVAL)
        _WAKE.clear()
        try:
            if is_enabled():
                run_round()
        except Exception as exc:  # pragma: no cover
            print(f"[sync] round error: {exc}")
        # If we were merely triggered, avoid hammering on tight loops.
        if triggered:
            time.sleep(0.5)


def sync_now() -> dict:
    """Trigger an immediate round and return its result (blocks briefly)."""
    return run_round()


# ─── Public status / lifecycle ───────────────────────────────────────────────
def service_status() -> dict:
    ident = load_identity()
    now = time.time()
    with _LOCK:
        peers = [_public_peer(p) for p in _PEERS.values() if _is_live(p, now)]
        last_sync_at = _STATS.get("last_sync_at")
        last_result = _STATS.get("last_result")
        history = list(_STATS.get("history", []))
    return {
        "enabled": is_enabled(),
        "available": _SERVICE_STARTED,
        "node_id": ident["node_id"],
        "device_name": ident["name"],
        "owner": owner_email(),
        "http_port": _HTTP_PORT,
        "discovery_port": DISCOVERY_PORT,
        "token_required": bool(_token()),
        "lan_ip": _LAN_IP,
        "peers": sorted(peers, key=lambda p: (p["name"] or "").lower()),
        "last_sync_at": last_sync_at,
        "last_result": last_result,
        "history": history,
    }


def start(http_port: int = 8002, lan_ip: str = "") -> None:
    """Start discovery + sync threads once. Safe to call repeatedly."""
    global _SERVICE_STARTED, _HTTP_PORT, _LAN_IP
    if _SERVICE_STARTED:
        return
    _HTTP_PORT = int(http_port or 8002)
    _LAN_IP = (lan_ip or "").strip()
    load_identity()
    _SERVICE_STARTED = True
    for fn, name in ((_listener, "sync-listener"), (_broadcaster, "sync-beacon"), (_sync_loop, "sync-loop")):
        threading.Thread(target=fn, name=name, daemon=True).start()
    print(f"[sync] LAN auto-sync started (node={load_identity()['node_id']}, "
          f"port={DISCOVERY_PORT}, enabled={is_enabled()})")
