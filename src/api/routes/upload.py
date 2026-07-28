import asyncio
import logging
import os
import re
from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import APIRouter, UploadFile, File, Form, Depends, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse

from api.auth import DEV_UID, verify_token
from api.firestore_client import set_features, set_library_track
from api.state import app_state
from api.schemas import TrackMeta
import pickle

from extractor.extractor import Extractor

log = logging.getLogger("beatbot.upload")

router = APIRouter()

# ── YouTube proxy rotation ───────────────────────────────────────────────────
# YOUTUBE_PROXIES env var: newline-separated list of host:port:user:pass

import random

def _get_proxy() -> str | None:
    """Pick a random residential proxy from the configured list."""
    raw = os.getenv("YOUTUBE_PROXIES", "")
    if not raw:
        return None
    proxies = [p.strip() for p in raw.strip().splitlines() if p.strip()]
    if not proxies:
        return None
    chosen = random.choice(proxies)
    parts = chosen.split(":")
    if len(parts) == 4:
        host, port, user, passwd = parts
        url = f"http://{user}:{passwd}@{host}:{port}"
    else:
        url = f"http://{chosen}"
    log.info("Using YouTube proxy: %s:%s", parts[0], parts[1])
    return url

# ── YouTube cookies resolution ───────────────────────────────────────────────
# Priority: YOUTUBE_COOKIES env var (Cloud Run) → local cookies.txt (dev)

_COOKIES_PATH: str | None = None

def _resolve_cookies() -> str | None:
    """Write cookies from env var to a temp file, or use a local file."""
    global _COOKIES_PATH
    if _COOKIES_PATH is not None:
        return _COOKIES_PATH

    env_cookies = os.getenv("YOUTUBE_COOKIES")
    if env_cookies:
        tmp = Path("/tmp/yt_cookies.txt")
        tmp.write_text(env_cookies)
        _COOKIES_PATH = str(tmp)
        log.info("Using YouTube cookies from YOUTUBE_COOKIES env var.")
        return _COOKIES_PATH

    local = Path("cookies.txt")
    if local.exists():
        _COOKIES_PATH = str(local.resolve())
        log.info("Using YouTube cookies from local cookies.txt.")
        return _COOKIES_PATH

    log.warning("No YouTube cookies found — downloads may fail.")
    return None

def make_track_meta(t):
    _NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    key_name = None
    
    
    if t.key_tonic is not None and t.key_scale is not None:
        note = _NOTE_NAMES[t.key_tonic % 12]
        key_name = f"{note}{'m' if t.key_scale == 'minor' else ''}"
    collection = "m-djcue" if t.source.upper().replace("_", "-") == "M-DJCUE" else "custom"
    
    return TrackMeta(
        track_id=t.track_id,
        duration=t.duration,
        tempo=t.tempo,
        key=key_name,
        camelot=t.camelot_code,
        num_bars=t.num_bars,
        has_cue_labels=t.has_cue_labels,
        collection=collection,
    )

def sanitize_track_id(title: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", title).strip()[:100]

@router.post("/upload/local")
async def upload_local(
    file: UploadFile = File(...),
    uid: str = Depends(verify_token)
):
    import shutil
    track_id = file.filename
    if track_id.lower().endswith(".mp3"):
        track_id = track_id[:-4]
    
    track_id = sanitize_track_id(track_id)

    with NamedTemporaryFile(delete=False, suffix=".mp3") as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    try:
        ex = Extractor(enable_vocal_separation=False)
        track = await asyncio.to_thread(ex.extract, tmp_path, track_id=track_id)
        
        # Save to DB
        set_features(uid, track_id, pickle.dumps(track))
        set_library_track(uid, track_id, make_track_meta(track).model_dump())
        
        # Local registry
        app_state.track_registry[track_id] = track
        
        return make_track_meta(track).model_dump()
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@router.post("/upload/youtube")
async def upload_youtube(
    background_tasks: BackgroundTasks,
    video_id: str = Form(...),
    title: str = Form(...),
    uid: str = Depends(verify_token)
):
    import shutil
    from tempfile import TemporaryDirectory

    track_id = sanitize_track_id(title)

    try:
        with TemporaryDirectory() as tmp_dir:
            out_path = Path(tmp_dir) / f"{track_id}.mp3"

            # Download audio from YouTube using yt-dlp with cookies
            try:
                import yt_dlp
            except ImportError:
                raise HTTPException(
                    status_code=503,
                    detail="YouTube download is not available: yt-dlp is not installed."
                )

            cookies_path = _resolve_cookies()
            proxy_url = _get_proxy()

            ydl_opts = {
                "format": "bestaudio/best",
                "postprocessors": [{
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "192",
                }],
                "quiet": False,
                "no_warnings": False,
                "outtmpl": str(out_path).replace(".mp3", ""),
            }
            if cookies_path:
                ydl_opts["cookies"] = cookies_path
            if proxy_url:
                ydl_opts["proxy"] = proxy_url

            try:
                def _download():
                    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                        ydl.download([f"https://www.youtube.com/watch?v={video_id}"])

                await asyncio.to_thread(_download)
            except Exception as e:
                import logging
                logging.error(f"YouTube download failed: {e}")
                raise HTTPException(status_code=500, detail=f"Failed to download YouTube video: {str(e)}")

            if not out_path.exists():
                raise HTTPException(status_code=500, detail="Downloaded MP3 file was not found. Processing failed.")

            # Extract audio features
            ex = Extractor(enable_vocal_separation=False)
            track = await asyncio.to_thread(ex.extract, str(out_path), track_id=track_id)

            # Save to DB
            set_features(uid, track_id, pickle.dumps(track))
            set_library_track(uid, track_id, make_track_meta(track).model_dump())

            app_state.track_registry[track_id] = track

            return make_track_meta(track).model_dump()

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="Failed to process YouTube upload.")

@router.get("/search/youtube")
async def search_youtube(q: str):
    try:
        import yt_dlp
    except ImportError:
        raise HTTPException(
            status_code=503,
            detail="YouTube search is not available: yt-dlp is not installed on this server."
        )

    ydl_opts = {
        "format": "bestaudio/best",
        "quiet": True,
        "extract_flat": True,
        "default_search": "ytsearch20",
        "extractor_args": {
            "youtube": {
                "player_client": ["android", "web"]
            }
        },
    }
    try:
        search_query = f"ytsearch20:{q}" if not q.startswith(("http", "ytsearch")) else q
        
        def _extract():
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                return ydl.extract_info(search_query, download=False)
                
        res = await asyncio.to_thread(_extract)
        
        if "entries" in res:
            return [{"video_id": e["id"], "title": e["title"], "channel": e.get("uploader"), "duration": e.get("duration"), "url": e["url"]} for e in res["entries"]]
        return []
    except Exception as e:
        import logging
        logging.error(f"YouTube search failed: {e}")
        raise HTTPException(status_code=500, detail="Search failed to process request.")
