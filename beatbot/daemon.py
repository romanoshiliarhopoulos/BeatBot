"""
beatbot daemon — local HTTP/WebSocket sidecar for the BeatBot web app.

Runs on http://127.0.0.1:7337 and exposes:
  GET  /health
  GET  /search?q=...      YouTube search via yt-dlp
  POST /import            Download → extract → upload PKL to cloud API
  WS   /ws                Real-time import progress events
  GET  /config            Music directory config
  POST /config            Update music directory

Start it with:
    beatbot daemon

Install as a macOS login item (starts automatically at login):
    beatbot daemon --autostart
"""

import asyncio
import json
import logging
import os
import pickle
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger("beatbot.daemon")

DAEMON_PORT = 7337

# ── Pydantic models (module-level so FastAPI can introspect them) ───────────
# These must NOT be defined inside create_app() — FastAPI's schema generator
# cannot reflect models defined in a local function scope.
try:
    from pydantic import BaseModel as _BaseModel

    class ImportRequest(_BaseModel):
        video_id: str
        title: str

    class ConfigUpdate(_BaseModel):
        music_dir: str

except ImportError:
    # pydantic not yet installed — create_app() will handle the error message
    ImportRequest = None  # type: ignore
    ConfigUpdate = None   # type: ignore

# ── config ─────────────────────────────────────────────────────────────────

CONFIG_FILE   = Path.home() / ".beatbot" / "config.json"
DEFAULT_MUSIC_DIR = Path.home() / "Music" / "BeatBot"


def _load_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text())
        except Exception:
            pass
    return {}


def _save_config(cfg: dict) -> None:
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2))


def _get_music_dir() -> Path:
    return Path(_load_config().get("music_dir", str(DEFAULT_MUSIC_DIR))).expanduser()


# ── FastAPI app factory ─────────────────────────────────────────────────────

def create_app(api_url: str, get_id_token_fn: Callable[[], str]) -> Any:
    try:
        from fastapi import (
            FastAPI,
            HTTPException,
            Query,
            WebSocket,
            WebSocketDisconnect,
        )
    except ImportError:
        print("  ✗  fastapi not installed. Run: pip install fastapi uvicorn")
        sys.exit(1)

    if ImportRequest is None:
        print("  ✗  pydantic not installed. Run: pip install pydantic")
        sys.exit(1)

    app = FastAPI(title="BeatBot Daemon", version="0.1.0")

    # Raw ASGI middleware — only adds CORS headers on HTTP responses.
    # Starlette's CORSMiddleware and BaseHTTPMiddleware both intercept
    # WebSocket upgrades in 0.36+ and return 403. This bypasses that entirely.
    from starlette.types import ASGIApp, Receive, Scope, Send
    from starlette.datastructures import MutableHeaders

    class CORSHeaderMiddleware:
        def __init__(self, app: ASGIApp) -> None:
            self.inner = app

        async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
            if scope["type"] != "http":
                # WebSocket and lifespan pass straight through — untouched.
                await self.inner(scope, receive, send)
                return

            async def send_with_cors(message):
                if message["type"] == "http.response.start":
                    headers = MutableHeaders(scope=message)
                    headers.append("Access-Control-Allow-Origin", "*")
                    headers.append("Access-Control-Allow-Methods", "*")
                    headers.append("Access-Control-Allow-Headers", "*")
                await send(message)

            # Handle OPTIONS preflight directly
            if scope.get("method") == "OPTIONS":
                await send({
                    "type": "http.response.start",
                    "status": 204,
                    "headers": [
                        (b"access-control-allow-origin", b"*"),
                        (b"access-control-allow-methods", b"*"),
                        (b"access-control-allow-headers", b"*"),
                        (b"content-length", b"0"),
                    ],
                })
                await send({"type": "http.response.body", "body": b""})
                return

            await self.inner(scope, receive, send_with_cors)

    app.add_middleware(CORSHeaderMiddleware)

    # ── WebSocket broadcast ─────────────────────────────────────────────────
    _ws_clients: list[WebSocket] = []

    async def _broadcast(msg: dict) -> None:
        dead = []
        for ws in list(_ws_clients):
            try:
                await ws.send_text(json.dumps(msg))
            except Exception:
                dead.append(ws)
        for ws in dead:
            if ws in _ws_clients:
                _ws_clients.remove(ws)

    # Thread pool — extraction is CPU-bound, keep it out of the event loop.
    executor = ThreadPoolExecutor(max_workers=2)

    # ── /health ──────────────────────────────────────────────────────────────

    @app.get("/health")
    async def health():
        return {"ok": True, "version": "0.1.0"}

    # ── /config ──────────────────────────────────────────────────────────────

    @app.get("/config")
    async def get_config():
        cfg = _load_config()
        return {"music_dir": cfg.get("music_dir", str(DEFAULT_MUSIC_DIR))}

    @app.post("/config")
    async def update_config(body: ConfigUpdate):
        cfg = _load_config()
        cfg["music_dir"] = body.music_dir
        _save_config(cfg)
        d = Path(body.music_dir).expanduser()
        d.mkdir(parents=True, exist_ok=True)
        return {"ok": True, "music_dir": str(d)}

    # ── /search ──────────────────────────────────────────────────────────────

    @app.get("/search")
    async def search(q: str = Query(..., min_length=1)):
        try:
            import yt_dlp  # noqa: F401
        except ImportError:
            raise HTTPException(503, "yt-dlp not installed. Run: pip install yt-dlp")

        def _do_search():
            opts = {
                "quiet": True,
                "no_warnings": True,
                "extract_flat": True,
                "skip_download": True,
            }
            with __import__("yt_dlp").YoutubeDL(opts) as ydl:
                info = ydl.extract_info(f"ytsearch10:{q}", download=False)
            entries = (info or {}).get("entries", [])
            return [
                {
                    "video_id":  e.get("id", ""),
                    "title":     e.get("title", "Unknown"),
                    "channel":   e.get("uploader") or e.get("channel") or "",
                    "duration":  e.get("duration") or 0,
                    "thumbnail": e.get("thumbnail")
                                 or f"https://i.ytimg.com/vi/{e.get('id','')}/mqdefault.jpg",
                    "url":       f"https://www.youtube.com/watch?v={e.get('id','')}",
                }
                for e in entries
                if e.get("id")
            ]

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(executor, _do_search)

    # ── /import ──────────────────────────────────────────────────────────────

    @app.post("/import")
    async def import_track(body: ImportRequest):
        track_id = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", body.title).strip()[:100]
        if not track_id:
            track_id = body.video_id
        asyncio.create_task(_run_import(body.video_id, track_id))
        return {"ok": True, "track_id": track_id}

    # ── /ws ──────────────────────────────────────────────────────────────────

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket):
        await ws.accept()
        _ws_clients.append(ws)
        try:
            while True:
                await ws.receive_text()   # keep-alive ping/pong
        except WebSocketDisconnect:
            pass
        finally:
            if ws in _ws_clients:
                _ws_clients.remove(ws)

    # ── background import job ─────────────────────────────────────────────────

    async def _run_import(video_id: str, track_id: str) -> None:
        loop = asyncio.get_event_loop()

        async def emit(status: str, **extra) -> None:
            await _broadcast({
                "type":     "import_progress",
                "track_id": track_id,
                "status":   status,
                **extra,
            })

        await emit("queued")

        # ── dependency checks ────────────────────────────────────────────────
        try:
            import yt_dlp  # noqa: F401
        except ImportError:
            await emit("error", message="yt-dlp not installed. Run: pip install yt-dlp")
            return

        music_dir = _get_music_dir()
        music_dir.mkdir(parents=True, exist_ok=True)
        out_path = music_dir / f"{track_id}.mp3"

        # ── Step 1: Download ─────────────────────────────────────────────────
        if out_path.exists():
            log.info("File already exists, skipping download: %s", out_path)
            await emit("downloading", progress=100, skipped=True)
        else:
            await emit("downloading", progress=0)

            def _progress_hook(d: dict):
                if d["status"] == "downloading":
                    total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                    done  = d.get("downloaded_bytes", 0)
                    pct   = int(done / total * 100) if total else 0
                    asyncio.run_coroutine_threadsafe(
                        emit("downloading", progress=pct), loop
                    )
                elif d["status"] == "finished":
                    asyncio.run_coroutine_threadsafe(
                        emit("downloading", progress=100), loop
                    )

            ydl_opts = {
                "format":    "bestaudio[ext=m4a]/bestaudio/best",
                "outtmpl":   str(music_dir / f"{track_id}.%(ext)s"),
                "postprocessors": [{
                    "key":              "FFmpegExtractAudio",
                    "preferredcodec":   "mp3",
                    "preferredquality": "192",
                }],
                "quiet":            True,
                "no_warnings":      True,
                "progress_hooks":   [_progress_hook],
                # ── bypass YouTube 403 / bot-detection ─────────────────────
                # Use cookies from Chrome/Chromium if available so yt-dlp
                # looks like a real browser session.
                "cookiesfrombrowser": ("chrome",),
                "http_headers": {
                    "User-Agent": (
                        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/123.0.0.0 Safari/537.36"
                    ),
                    "Accept-Language": "en-US,en;q=0.9",
                },
                "extractor_args": {
                    "youtube": {"player_client": ["web", "android"]},
                },
                "retries": 5,
                "fragment_retries": 5,
            }

            def _download():
                url = f"https://www.youtube.com/watch?v={video_id}"
                yt_dlp = __import__("yt_dlp")
                # First attempt: with Chrome cookies (bypasses bot-detection).
                try:
                    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                        ydl.download([url])
                    return
                except Exception as first_exc:
                    err_str = str(first_exc)
                    # If the failure was cookies-related, retry without them.
                    if "cookie" in err_str.lower() or "keyring" in err_str.lower():
                        log.warning("Chrome cookies unavailable, retrying without: %s", err_str)
                        fallback = {**ydl_opts}
                        fallback.pop("cookiesfrombrowser", None)
                        with yt_dlp.YoutubeDL(fallback) as ydl:
                            ydl.download([url])
                    else:
                        raise

            try:
                await loop.run_in_executor(executor, _download)
            except Exception as exc:
                await emit("error", message=f"Download failed: {exc}")
                return

            if not out_path.exists():
                await emit(
                    "error",
                    message="Download finished but MP3 not found — is ffmpeg installed?",
                )
                return

        # ── Step 2: Extract ──────────────────────────────────────────────────
        await emit("extracting")

        try:
            from beatbot.extractor.extractor import Extractor

            def _extract():
                return Extractor().extract(out_path, track_id=track_id)

            track = await loop.run_in_executor(executor, _extract)
        except Exception as exc:
            await emit("error", message=f"Extraction failed: {exc}")
            return

        # ── Step 3: Upload PKL to cloud API ──────────────────────────────────
        await emit("uploading")

        try:
            try:
                id_token = get_id_token_fn()
            except SystemExit:
                await emit(
                    "error",
                    message="Not logged in. Run: beatbot login",
                )
                return
            pkl = pickle.dumps(track)

            def _upload():
                url = f"{api_url}/predict/{urllib.parse.quote(track_id, safe='')}"
                print(f"[daemon] uploading to: {url}  ({len(pkl)} bytes)", flush=True)
                req = urllib.request.Request(
                    url, data=pkl, method="POST",
                    headers={
                        "Authorization": f"Bearer {id_token}",
                        "Content-Type":  "application/octet-stream",
                    },
                )
                try:
                    with urllib.request.urlopen(req, timeout=60) as resp:
                        resp.read()  # consume response
                except urllib.error.HTTPError as exc:
                    body = ""
                    try:
                        body = exc.read().decode("utf-8", errors="replace")[:500]
                    except Exception:
                        pass
                    print(f"[daemon] upload error body: {body}", flush=True)
                    raise RuntimeError(
                        f"HTTP {exc.code} — {body or exc.reason}"
                    ) from exc

            await loop.run_in_executor(executor, _upload)
        except Exception as exc:
            await emit("error", message=f"Upload failed: {exc}")
            return

        await emit("done", file_path=str(out_path))

    return app


# ── autostart (macOS launchd) ───────────────────────────────────────────────

def _install_autostart(port: int) -> None:
    """Write a launchd plist and load it so the daemon starts at login."""
    import shutil

    beatbot_bin = shutil.which("beatbot")
    if beatbot_bin:
        prog_args = [beatbot_bin, "daemon", f"--port={port}"]
    else:
        prog_args = [sys.executable, "-m", "beatbot.cli", "daemon", f"--port={port}"]

    xml_args = "\n        ".join(f"<string>{a}</string>" for a in prog_args)
    path_val = os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin")

    plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
    "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.beatbot.daemon</string>
    <key>ProgramArguments</key>
    <array>
        {xml_args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/beatbot-daemon.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/beatbot-daemon-error.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{path_val}</string>
    </dict>
</dict>
</plist>
"""

    plist_dir  = Path.home() / "Library" / "LaunchAgents"
    plist_dir.mkdir(parents=True, exist_ok=True)
    plist_path = plist_dir / "com.beatbot.daemon.plist"
    plist_path.write_text(plist)
    print(f"  ✓  Plist written to {plist_path}")

    # Unload first (ignore errors), then load.
    subprocess.run(["launchctl", "unload", str(plist_path)], capture_output=True)
    result = subprocess.run(
        ["launchctl", "load", str(plist_path)],
        capture_output=True, text=True,
    )
    if result.returncode == 0:
        print("  ✓  Daemon registered as a macOS login item (com.beatbot.daemon)")
        print("  ✓  It will start on login and auto-restart if it crashes.")
        print(f"\n  Daemon is now starting at http://127.0.0.1:{port}")
        print("  Open BeatBot in your browser and go to Discover.\n")
    else:
        print(f"  ⚠  launchctl load returned: {result.stderr.strip()}")
        print(f"\n  Plist written. Load manually with:")
        print(f"      launchctl load {plist_path}\n")


def _uninstall_autostart() -> None:
    plist_path = Path.home() / "Library" / "LaunchAgents" / "com.beatbot.daemon.plist"
    if not plist_path.exists():
        print("  ⚠  No autostart plist found.")
        return
    subprocess.run(["launchctl", "unload", str(plist_path)], capture_output=True)
    plist_path.unlink()
    print(f"  ✓  Removed {plist_path}")
    print("  ✓  Daemon will no longer start at login.\n")


# ── entry point ─────────────────────────────────────────────────────────────

def run(
    port: int = DAEMON_PORT,
    api_url: str | None = None,
    autostart: bool = False,
    uninstall: bool = False,
) -> None:
    if uninstall:
        _uninstall_autostart()
        return

    if autostart:
        _install_autostart(port)
        return

    try:
        import uvicorn  # noqa: F401
    except ImportError:
        print("  ✗  uvicorn not installed. Run: pip install uvicorn fastapi")
        sys.exit(1)

    # Import auth helpers from the CLI module.
    from beatbot.cli import API_URL as _DEFAULT_API_URL
    from beatbot.cli import get_id_token

    _api_url  = api_url or _DEFAULT_API_URL
    music_dir = _get_music_dir()
    music_dir.mkdir(parents=True, exist_ok=True)

    app = create_app(_api_url, get_id_token)

    print(f"\n  BeatBot Daemon  —  http://127.0.0.1:{port}")
    print(f"  Music directory : {music_dir}")
    print(f"  Cloud API       : {_api_url}")
    print(f"\n  Open BeatBot in your browser and go to Discover.")
    print(f"  Press Ctrl+C to stop.\n")

    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", ws="websockets")
