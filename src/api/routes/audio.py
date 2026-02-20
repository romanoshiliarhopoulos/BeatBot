"""GET /audio/{track_id} — stream the MP3 file with Range support."""
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from api.state import app_state

router = APIRouter()


@router.get("/audio/{track_id}")
def stream_audio(track_id: str):
    """
    Stream the raw MP3 for the given track.  FastAPI's FileResponse handles
    HTTP Range headers automatically, so the browser can seek without
    downloading the whole file.
    """
    t = app_state.track_registry.get(track_id)
    if t is None:
        raise HTTPException(status_code=404, detail=f"Track '{track_id}' not found.")

    path = t.audio_path
    if path is None or not path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Audio file for '{track_id}' not found on disk.",
        )

    return FileResponse(
        path=str(path),
        media_type="audio/mpeg",
        filename=path.name,
    )
