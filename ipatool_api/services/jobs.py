"""In-memory background job registry for long-running downloads.

The App Store download + zip-patching step can take anywhere from a few
seconds to several minutes depending on app size and Apple's servers. Doing
this synchronously inside a single HTTP request/response (the old
``/api/download-stream`` design) means:

  - the client gets zero feedback until the *entire* operation finishes -
    both frontends showed a static "Preparing download..." the whole time
  - the underlying connection has to stay open for that whole duration,
    which flaky mobile networks (and old browsers - Mobile Safari on iOS 6
    doesn't even support the ``blob`` XHR responseType the old JS relied on
    to receive the file at the end) are prone to killing well before it
    completes, with no way to recover

This module lets a POST kick off the work in a background thread and return
almost immediately with a job id. The client then polls a small, fast GET
endpoint for status/progress, and finally fetches the finished file via a
plain GET - which works as an ordinary browser download/navigation (e.g. a
hidden iframe's ``src`` or a real ``<a href>``), no Blob/XHR2 support
required on the client at all.
"""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Optional

# Abandoned jobs (started but never polled/collected, e.g. the tab was
# closed) have their temp file and bookkeeping swept after this long.
JOB_TTL_SECONDS = 30 * 60


@dataclass
class DownloadJob:
    id: str
    status: str = "pending"  # pending -> downloading -> ready -> error
    # Sub-stage within "downloading": 'download' (raw bytes from Apple),
    # 'patching' (rewriting the zip to add iTunesMetadata.plist), or
    # 'finalizing' (rewriting the zip again to inject the SINF signature).
    # The patching/finalizing phases are pure-Python zip rewrites of the
    # *entire* package and can easily take several minutes for a large app
    # on slow hardware - without this, the client sees byte progress hit
    # 100% and then nothing for a long time, which looks exactly like a
    # hang even though it's just quietly doing more work.
    phase: str = "download"
    bytes_done: int = 0
    bytes_total: Optional[int] = None
    items_done: int = 0
    items_total: Optional[int] = None
    filename: Optional[str] = None
    file_path: Optional[str] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    # Set instead of file_path when the job was asked to save straight to a
    # persistent folder on the server (see /api/download-jobs's
    # saveToServerFolder option) rather than being served to the browser and
    # deleted afterwards. Kept separate from file_path so neither the TTL
    # sweep below nor /api/download-jobs/<id>/file ever touches it - a
    # deliberately saved file should never be auto-deleted.
    server_path: Optional[str] = None
    saved_to_server: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "phase": self.phase,
            "bytesDone": self.bytes_done,
            "bytesTotal": self.bytes_total,
            "itemsDone": self.items_done,
            "itemsTotal": self.items_total,
            "filename": self.filename,
            "error": self.error,
            "savedToServer": self.saved_to_server,
            "serverPath": self.server_path,
        }


class DownloadJobRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: Dict[str, DownloadJob] = {}

    def create(self) -> DownloadJob:
        self._sweep()
        job = DownloadJob(id=uuid.uuid4().hex)
        with self._lock:
            self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> Optional[DownloadJob]:
        with self._lock:
            return self._jobs.get(job_id)

    def update(self, job_id: str, **kwargs: Any) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            for key, value in kwargs.items():
                setattr(job, key, value)

    def progress_callback(self, job_id: str) -> Callable[[int, Optional[int]], None]:
        def _cb(bytes_done: int, bytes_total: Optional[int]) -> None:
            self.update(job_id, status="downloading", phase="download", bytes_done=bytes_done, bytes_total=bytes_total)

        return _cb

    def patch_progress_callback(self, job_id: str) -> Callable[[int, int], None]:
        def _cb(items_done: int, items_total: int) -> None:
            self.update(job_id, status="downloading", phase="patching", items_done=items_done, items_total=items_total)

        return _cb

    def finalize_progress_callback(self, job_id: str) -> Callable[[int, int], None]:
        def _cb(items_done: int, items_total: int) -> None:
            self.update(job_id, status="downloading", phase="finalizing", items_done=items_done, items_total=items_total)

        return _cb

    def remove(self, job_id: str) -> None:
        with self._lock:
            self._jobs.pop(job_id, None)

    def _sweep(self) -> None:
        cutoff = time.time() - JOB_TTL_SECONDS
        with self._lock:
            stale = [jid for jid, job in self._jobs.items() if job.created_at < cutoff]
        for jid in stale:
            job = self.get(jid)
            if job and job.file_path:
                try:
                    Path(job.file_path).unlink(missing_ok=True)
                except Exception:
                    pass
            self.remove(jid)


# One process-wide registry, mirroring how AppStoreService itself is a single
# instance stored on app.config.
download_jobs = DownloadJobRegistry()
