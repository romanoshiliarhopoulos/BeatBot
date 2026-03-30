import asyncio
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

router = APIRouter()

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
    try:
        import yt_dlp
    except ImportError:
        raise HTTPException(
            status_code=503,
            detail="YouTube download is not available: yt-dlp is not installed or not configured on this server."
        )
    
    track_id = sanitize_track_id(title)
    if not track_id:
        track_id = sanitize_track_id(video_id)
        
    import uuid
    import shutil
    req_id = uuid.uuid4().hex[:8]
    out_dir = Path(f"/tmp/beatbot_yt_{req_id}")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{track_id}.mp3"

    ydl_opts = {
        "format":    "bestaudio[ext=m4a]/bestaudio/best",
        "outtmpl":   str(out_dir / f"{track_id}.%(ext)s"),
        "postprocessors": [{
            "key":              "FFmpegExtractAudio",
            "preferredcodec":   "mp3",
            "preferredquality": "192",
        }],
        "quiet":            True,
        "no_warnings":      True,
        "extractor_args": {
            "youtube": {
                "player_client": ["android", "web"]
            }
        },
    }

    try:
        url = f"https://www.youtube.com/watch?v={video_id}"
        await asyncio.to_thread(lambda: yt_dlp.YoutubeDL(ydl_opts).download([url]))
    except Exception as e:
        import logging
        logging.error(f"YouTube download failed: {e}")
        shutil.rmtree(out_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail="Failed to fetch audio from YouTube. The video might be restricted.")

    try:
        if not out_path.exists():
            raise HTTPException(status_code=500, detail="Downloaded MP3 file was not found. Processing failed.")

        ex = Extractor(enable_vocal_separation=False)
        track = await asyncio.to_thread(ex.extract, str(out_path), track_id=track_id)
        
        # Save to DB
        set_features(uid, track_id, pickle.dumps(track))
        set_library_track(uid, track_id, make_track_meta(track).model_dump())
        
        app_state.track_registry[track_id] = track
        
        # Return the mp3 file for download.
        def cleanup_files():
            shutil.rmtree(out_dir, ignore_errors=True)
            
        background_tasks.add_task(cleanup_files)
        
        return FileResponse(
            out_path, 
            media_type='audio/mpeg', 
            headers={"Content-Disposition": f'attachment; filename="{track_id}.mp3"'}
        )
    except HTTPException:
        import shutil
        shutil.rmtree(out_dir, ignore_errors=True)
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        import shutil
        shutil.rmtree(out_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail="Extractor encountered an error processing the audio.")

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
