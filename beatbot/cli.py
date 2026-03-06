#!/usr/bin/env python3
"""
BeatBot CLI — local feature extraction + cloud cue-point prediction.

Usage
─────
  beatbot login
      Authenticate with your BeatBot account.
      Credentials are saved to ~/.beatbot/credentials.json and
      refreshed automatically on next run.

  beatbot extract <folder> [<folder2> ...]
      Scan each folder for MP3/WAV files.  For each track:
        1. Run librosa feature extraction locally (15–30 s per track).
        2. Upload the extracted features (pkl) to the BeatBot API.
        3. The server runs the cue-point model on upload and on every
           web-app visit — predictions are always computed fresh from
           the latest deployed model, never served from a stale cache.

  beatbot extract <folder> --force
      Re-upload features for every track, even if already stored.

  beatbot status <folder> [<folder2> ...]
      Show which tracks in each folder have features uploaded vs pending.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import pickle
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# ── built-in config (these are client-side values, intentionally public) ──────
API_URL          = os.environ.get("BEATBOT_API_URL",      "https://beatbot-api-65953831924.us-east5.run.app")
FIREBASE_API_KEY = os.environ.get("BEATBOT_FIREBASE_KEY", "AIzaSyChzGuK_tgwscYd5sZX3iBCNRYPLiLgeig")

CREDS_FILE = Path.home() / ".beatbot" / "credentials.json"


# ── helpers ────────────────────────────────────────────────────────────────────

def _print_ok(msg: str)   -> None: print(f"  ✓  {msg}")
def _print_warn(msg: str) -> None: print(f"  ⚠  {msg}")
def _print_err(msg: str)  -> None: print(f"  ✗  {msg}", file=sys.stderr)

def _post_json(url: str, body: dict, *, timeout: int = 15) -> dict:
    data = json.dumps(body).encode()
    req  = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


# ── auth ───────────────────────────────────────────────────────────────────────

def _save_creds(data: dict) -> None:
    CREDS_FILE.parent.mkdir(parents=True, exist_ok=True)
    CREDS_FILE.write_text(json.dumps(data, indent=2))


def _load_creds() -> dict | None:
    if not CREDS_FILE.exists():
        return None
    try:
        return json.loads(CREDS_FILE.read_text())
    except Exception:
        return None


def _refresh(refresh_token: str) -> dict:
    url  = f"https://securetoken.googleapis.com/v1/token?key={FIREBASE_API_KEY}"
    resp = _post_json(url, {"grant_type": "refresh_token", "refresh_token": refresh_token})
    return {
        "idToken":      resp["id_token"],
        "refreshToken": resp["refresh_token"],
        "expiresAt":    time.time() + int(resp["expires_in"]),
    }


def get_id_token() -> str:
    """Return a valid Firebase ID token, refreshing it if expired."""
    creds = _load_creds()
    if not creds:
        _print_err("Not logged in.  Run:  beatbot login")
        sys.exit(1)

    if time.time() > creds.get("expiresAt", 0) - 60:
        try:
            fresh = _refresh(creds["refreshToken"])
            creds.update(fresh)
            _save_creds(creds)
        except Exception as exc:
            _print_err(f"Token refresh failed: {exc}")
            _print_err("Run:  beatbot login")
            sys.exit(1)

    return creds["idToken"]


# ── server helpers ─────────────────────────────────────────────────────────────

def _has_features(track_id: str, id_token: str) -> bool:
    """Return True if features for this track have been uploaded to the API."""
    url = f"{API_URL}/features/{urllib.parse.quote(track_id, safe='')}"
    req = urllib.request.Request(
        url, method="GET",
        headers={"Authorization": f"Bearer {id_token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
            return bool(data.get("uploaded", False))
    except Exception:
        return False


def _upload_pkl(track_id: str, pkl: bytes, id_token: str) -> bool:
    """POST pickled Track bytes to /predict/{id}. Returns True on success."""
    url = f"{API_URL}/predict/{urllib.parse.quote(track_id, safe='')}"
    req = urllib.request.Request(
        url, data=pkl, method="POST",
        headers={
            "Authorization":  f"Bearer {id_token}",
            "Content-Type":   "application/octet-stream",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30):
            return True
    except Exception as exc:
        _print_warn(f"Upload failed for '{track_id}': {exc}")
        return False


# ── commands ───────────────────────────────────────────────────────────────────

def cmd_login(_args) -> None:
    """Interactive Firebase email/password login."""
    print("\nBeatBot — Login\n")
    email    = input("  Email:    ")
    password = getpass.getpass("  Password: ")

    url  = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={FIREBASE_API_KEY}"
    try:
        resp = _post_json(url, {"email": email, "password": password, "returnSecureToken": True})
    except urllib.error.HTTPError as exc:
        _print_err(f"Login failed: {json.loads(exc.read()).get('error', {}).get('message', exc)}")
        sys.exit(1)
    except Exception as exc:
        _print_err(f"Login failed: {exc}")
        sys.exit(1)

    _save_creds({
        "email":        email,
        "idToken":      resp["idToken"],
        "refreshToken": resp["refreshToken"],
        "expiresAt":    time.time() + int(resp["expiresIn"]),
    })
    _print_ok(f"Logged in as {email}")
    _print_ok(f"Credentials saved to {CREDS_FILE}")


def cmd_status(args) -> None:
    """Show cached vs pending counts for one or more folders without extracting."""
    folders = [Path(f).expanduser().resolve() for f in args.folders]
    bad = [f for f in folders if not f.is_dir()]
    if bad:
        for f in bad:
            _print_err(f"Not a directory: {f}")
        sys.exit(1)

    mp3s: list[Path] = []
    for folder in folders:
        mp3s += sorted(folder.rglob("*.mp3")) + sorted(folder.rglob("*.wav"))

    if not mp3s:
        print("No audio files found.")
        return

    id_token = get_id_token()
    print(f"\nChecking {len(mp3s)} tracks across {len(folders)} folder(s)…\n")

    cached: list[str]  = []
    pending: list[str] = []
    for mp3 in mp3s:
        track_id = mp3.stem
        if _has_features(track_id, id_token):
            cached.append(track_id)
            print(f"  ✓  {track_id[:70]}")
        else:
            pending.append(track_id)
            print(f"  ·  {track_id[:70]}  (features not uploaded)")

    print(f"\n{len(cached)} uploaded, {len(pending)} pending.")
    if pending:
        folder_args = " ".join(f'"{f}"' for f in args.folders)
        print(f"\nRun to upload pending tracks:\n  beatbot extract {folder_args}")


def cmd_extract(args) -> None:
    """Extract features locally and push pkl to the BeatBot API."""
    folders = [Path(f).expanduser().resolve() for f in args.folders]
    bad = [f for f in folders if not f.is_dir()]
    if bad:
        for f in bad:
            _print_err(f"Not a directory: {f}")
        sys.exit(1)

    # ── dependency check ────────────────────────────────────────────────
    missing = []
    for dep in ("librosa", "numpy", "scipy"):
        try:
            __import__(dep)
        except ImportError:
            missing.append(dep)
    if missing:
        _print_err("Missing Python packages: " + ", ".join(missing))
        _print_err("Install with:  pip install " + " ".join(missing))
        sys.exit(1)

    try:
        from beatbot.extractor.extractor import Extractor
    except ImportError as exc:
        _print_err(f"Could not import Extractor: {exc}")
        sys.exit(1)

    # ── discover audio files ─────────────────────────────────────────────
    mp3s: list[Path] = []
    for folder in folders:
        mp3s += sorted(folder.rglob("*.mp3")) + sorted(folder.rglob("*.wav"))

    if not mp3s:
        print("No audio files found.")
        return

    print(f"\nBeatBot Extractor — {len(mp3s)} file(s) across {len(folders)} folder(s)\n")
    id_token = get_id_token()
    ext      = Extractor()

    ok = skipped = failed = 0
    total_str = str(len(mp3s))

    for i, mp3 in enumerate(mp3s, 1):
        track_id = mp3.stem
        col_w    = min(60, max(20, len(track_id)))
        prefix   = f"[{i:>{len(total_str)}}/{len(mp3s)}] {track_id[:col_w]:<{col_w}}"

        if not args.force and _has_features(track_id, id_token):
            print(f"{prefix}  features already uploaded, skipping")
            skipped += 1
            continue

        print(f"{prefix}  extracting…", end="\r", flush=True)
        try:
            track = ext.extract(mp3, track_id=track_id)
        except Exception as exc:
            print(f"{prefix}  FAILED — {exc}          ")
            failed += 1
            continue

        print(f"{prefix}  uploading… ", end="\r", flush=True)
        pkl = pickle.dumps(track)
        if _upload_pkl(track_id, pkl, id_token):
            print(f"{prefix}  ✓ done ({len(pkl) / 1024:.0f} KB)  ")
            ok += 1
        else:
            print(f"{prefix}  ✗ upload failed        ")
            failed += 1

    print(f"\n{'─' * 60}")
    print(f"  Processed : {ok}")
    print(f"  Skipped   : {skipped}  (features already uploaded — use --force to re-upload)")
    print(f"  Failed    : {failed}")
    print(f"{'\u2500' * 60}\n")

    if ok > 0:
        print("Features uploaded! Reload the BeatBot web app to see your updated cue points.\n")


# ── entry point ────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        prog="beatbot",
        description="BeatBot CLI — extract audio features and sync to the cloud.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("login", help="Authenticate with your BeatBot account")

    p_ext = sub.add_parser("extract", help="Extract features and upload to BeatBot cloud")
    p_ext.add_argument("folders", nargs="+", metavar="folder",
                       help="Path(s) to your music folder(s)")
    p_ext.add_argument("--force", action="store_true",
                       help="Re-upload features even if already stored server-side")

    p_stat = sub.add_parser("status", help="Show cached vs pending tracks")
    p_stat.add_argument("folders", nargs="+", metavar="folder",
                        help="Path(s) to your music folder(s)")

    args = parser.parse_args()
    {
        "login":   cmd_login,
        "extract": cmd_extract,
        "status":  cmd_status,
    }[args.command](args)


if __name__ == "__main__":
    main()
