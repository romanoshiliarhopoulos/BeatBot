/**
 * FolderContext — manages local music directories granted via the
 * File System Access API.  Handles are persisted in IndexedDB so the user
 * only has to pick once per browser session (re-permission is requested
 * automatically on next load).
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import {
  loadFolderHandles,
  saveFolderHandle,
  removeFolderHandle,
  verifyHandlePermission,
  type StoredFolder,
} from "../lib/idb";

// ── types ──────────────────────────────────────────────────────────────────

export interface ScannedTrack {
  /** Stable key: "<folder_id>/<filename>" */
  key: string;
  folderId: string;
  filename: string; // e.g. "Bicep - Glue.mp3"
  /** Populated lazily when the file is first opened */
  fileSize: number;
}

interface FolderContextValue {
  /** All .mp3 files found across all granted folders */
  tracks: ScannedTrack[];
  /** Currently granted folders */
  folders: StoredFolder[];
  /** Open the OS directory picker and grant access to a new folder */
  addFolder: () => Promise<void>;
  /** Remove a previously linked folder */
  removeFolder: (id: string) => Promise<void>;
  /** Get a File object for a given ScannedTrack key (for audio playback) */
  getFile: (key: string) => Promise<File | null>;
  /** Look up a File by track_id (filename without .mp3 extension) */
  getFileByTrackId: (trackId: string) => Promise<File | null>;
  /** Saves a downloaded blob directly to the linked folder */
  saveDownloadedTrack: (trackId: string, blob: Blob) => Promise<void>;
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Walk a directory handle and collect all .mp3 file entries. */
async function scanDirectory(
  folderId: string,
  dir: FileSystemDirectoryHandle,
): Promise<ScannedTrack[]> {
  const result: ScannedTrack[] = [];

  async function walk(
    handle: FileSystemDirectoryHandle,
    _depth = 0,
  ): Promise<void> {
    // Limit recursion depth to avoid walking a huge library tree unexpectedly
    if (_depth > 4) return;
    // @ts-ignore – AsyncIterable<FileSystemHandle> is in spec but TS lib may lag
    for await (const entry of handle.values()) {
      if (entry.kind === "file") {
        const name: string = entry.name;
        if (name.toLowerCase().endsWith(".mp3")) {
          const file: File = await (entry as FileSystemFileHandle).getFile();
          result.push({
            key: `${folderId}/${name}`,
            folderId,
            filename: name,
            fileSize: file.size,
          });
        }
      } else if (entry.kind === "directory") {
        await walk(entry as FileSystemDirectoryHandle, _depth + 1);
      }
    }
  }

  await walk(dir);
  return result;
}

// ── context ────────────────────────────────────────────────────────────────

const FolderContext = createContext<FolderContextValue | null>(null);

export function FolderProvider({ children }: { children: ReactNode }) {
  const [folders, setFolders] = useState<StoredFolder[]>([]);
  const [tracks, setTracks] = useState<ScannedTrack[]>([]);

  // ── load persisted handles on mount ──────────────────────────────────

  useEffect(() => {
    (async () => {
      const stored = await loadFolderHandles();
      if (stored.length === 0) return;

      // Re-verify permissions — browser may have revoked them
      const valid: StoredFolder[] = [];
      for (const f of stored) {
        const ok = await verifyHandlePermission(f.handle);
        if (ok) valid.push(f);
      }
      setFolders(valid);
      if (valid.length > 0) await doScan(valid, setTracks);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── scan ──────────────────────────────────────────────────────────────

  const doScan = async (flds: StoredFolder[], setT: typeof setTracks) => {
    const all: ScannedTrack[] = [];
    for (const f of flds) {
      try {
        const found = await scanDirectory(f.id, f.handle);
        all.push(...found);
      } catch (err) {
        console.warn(`[FolderContext] scan failed for ${f.name}:`, err);
      }
    }
    setT(all);
  };

  // ── get File object ───────────────────────────────────────────────────

  const getFile = useCallback(
    async (key: string): Promise<File | null> => {
      const track = tracks.find((t) => t.key === key);
      if (!track) return null;
      const folder = folders.find((f) => f.id === track.folderId);
      if (!folder) return null;
      try {
        const fileHandle = await folder.handle.getFileHandle(track.filename);
        return await fileHandle.getFile();
      } catch {
        return null;
      }
    },
    [tracks, folders],
  );

  const getFileByTrackId = useCallback(
    async (trackId: string): Promise<File | null> => {
      const track = tracks.find(
        (t) => t.filename.replace(/\.mp3$/i, "") === trackId,
      );
      if (!track) return null;
      return getFile(track.key);
    },
    [tracks, getFile],
  );

  const addFolder = useCallback(async () => {
    try {
      // @ts-ignore – showDirectoryPicker is in the spec but not all TS libs
      const handle: FileSystemDirectoryHandle =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (window as any).showDirectoryPicker({ mode: "readwrite" });
      const id = crypto.randomUUID();
      const stored: StoredFolder = { id, name: handle.name, handle };

      // Clear out old folders (enforce single folder)
      for (const f of folders) {
        await removeFolderHandle(f.id);
      }

      await saveFolderHandle(stored);
      const nextFolders = [stored];
      setFolders(nextFolders);
      await doScan(nextFolders, setTracks);
    } catch (err: unknown) {
      // User cancelled the picker — not an error
      if (err instanceof Error && err.name === "AbortError") return;
      console.error("[FolderContext] addFolder failed:", err);
    }
  }, [folders]);

  const saveDownloadedTrack = useCallback(
    async (trackId: string, blob: Blob) => {
      if (folders.length === 0) throw new Error("No folder linked");
      const folder = folders[0];

      // FileSystemWritableFileStream is standard but sometimes missing in TS
      const fileHandle = await folder.handle.getFileHandle(`${trackId}.mp3`, {
        create: true,
      });
      // @ts-ignore
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();

      // Refresh to see the newly saved file
      await doScan(folders, setTracks);
    },
    [folders],
  );

  const removeFolder = useCallback(
    async (id: string) => {
      await removeFolderHandle(id);
      const nextFolders = folders.filter((f) => f.id !== id);
      setFolders(nextFolders);
      await doScan(nextFolders, setTracks);
    },
    [folders],
  );

  return (
    <FolderContext.Provider
      value={{
        tracks,
        folders,
        addFolder,
        removeFolder,
        getFile,
        getFileByTrackId,
        saveDownloadedTrack,
      }}
    >
      {children}
    </FolderContext.Provider>
  );
}

export function useFolders(): FolderContextValue {
  const ctx = useContext(FolderContext);
  if (!ctx) throw new Error("useFolders must be used inside <FolderProvider>");
  return ctx;
}
