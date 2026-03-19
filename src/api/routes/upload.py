import asyncio
import os
import re
from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import APIRouter, UploadFile, File, Form, Depends, HTTPException
from fastapi.responses import FileResponse

from api.auth import DEV_UID, verify_token
from api.firestore_client import set_features, set_library_track
from api.state import app_state

from extractor.extractor import Extractor

router = APIRouter()

def sanitize_track_id(title: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", title).strip()[:100]

@router.post("/upload/local")
async def upload_local(
    file: UploadFile = File(...),
    uid: str = Depends(verify_token)
):
    track_id = file.filename
    if track_id.lower().endswith(".mp3"):
        track_id = track_id[:-4]
    
    track_id = sanitize_track_id(track_id)

    with NamedTemporaryFile(delete=False, suffix=".mp3") as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        ex = Extractor(enable_vocal_separation=False)
        track = ex.extract(tmp_path, track_id=track_id)
        
        # Save to DB
        set_features(track)
        set_library_track(uid, track)
        
        # Local registry
        app_state.track_registry[track_id] = track.to_meta()
        
        return track.to_meta().model_dump()
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@router.post("/upload/youtube")
async def upload_youtube(
    video_id: str = Form(...),
    title: str = Form(...),
    uid: str = Depends(verify_token)
):
    import yt_dlp
    
    track_id = sanitize_track_id(title)
    if not track_id:
        track_id = sanitize_track_id(video_id)
        
    out_dir = Path("/tmp/beatbot_yt")
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
    }

    try:
        url = f"https://www.youtube.com/watch?v={video_id}"
        await asyncio.to_thread(lambda: yt_dlp.YoutubeDL(ydl_opts).download([url]))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    try:
        ex = Extractor(enable_vocal_separation=False)
        track = ex.extract(out_path, track_id=track_id)
        
        # Save to DB
        set_features(track)
        set_library_track(uid, track)
        
        app_state.track_registry[track_id] = track.to_meta()
        
        # Return the mp3 file for download.
        return FileResponse(
            out_path, 
            media_type='audio/mpeg', 
            headers={"Content-Disposition": f'attachment; filename="{track_id}.mp3"'}
        )
    except Exception as e:
        if os.path.exists(out_path):
            os.remove(out_path)
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/search/youtube")
async def search_youtube(q: str):
    import yt_dlp
    ydl_opts = {
        "format": "bestaudio/best",
        "quiet": True,
        "extract_flat": True,
        "default_search": "ytsearch5",
    }
    try:
        import yt_dlp
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            res = ydl.extract_info(q, download=False)
            if "entries" in res:
                return [{"video_id": e["id"], "title": e["title"], "channel": e.get("uploader"), "duration": e.get("duration"), "url": e["url"]} for e in res["entries"]]
            return []
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
