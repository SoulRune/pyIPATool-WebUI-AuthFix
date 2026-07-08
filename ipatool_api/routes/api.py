"""REST API routes for the Flask application."""
from __future__ import annotations

import threading
import time
from http import HTTPStatus
from typing import Any, Dict
from pathlib import Path

from flask import Blueprint, current_app, jsonify, request, Response

from ..services.appstore import AppStoreService
from ..services.errors import (
    AppStoreError,
    LicenseRequiredError,
    PasswordTokenExpiredError,
    AuthCodeRequiredError,
)
from ..services.jobs import download_jobs
from ..services.models import Account, App

api_bp = Blueprint("api", __name__, url_prefix="/api")


def _service() -> AppStoreService:
    return current_app.config["APPSTORE_SERVICE"]


def _send_file_and_cleanup(file_path: Path, filename: str, extra_cleanup=None) -> Response:
    """Stream a file to the client.

    Deliberately does NOT delete the file immediately after this response
    finishes. Some browsers' download managers (observed: Orion on iOS) make
    more than one request to a download URL before actually committing to
    save it - e.g. a quick check followed by the real fetch. Deleting the
    file after the first request served it out from under the second one,
    which 404's and shows as an immediate "failed" download with no
    filename (since the browser never got far enough to read
    Content-Disposition). The existing 30-minute job TTL sweep
    (DownloadJobRegistry._sweep) still cleans the file up - this just stops
    racing a possible second fetch attempt against our own cleanup.

    Also deliberately NOT using send_file()+call_on_close(): on Windows you
    can't delete a file while any handle to it is still open (unlike POSIX,
    where unlink() on an open file just removes the directory entry and the
    data is freed once the last handle closes). We still stream via our own
    `with open(...)` (rather than send_file) so our own handle is always
    closed promptly regardless of framework timing quirks, even though nothing
    here deletes the file anymore - if extra_cleanup is provided it still runs
    after the stream finishes for callers that need it.
    """

    def generate():
        try:
            with file_path.open("rb") as handle:
                while True:
                    chunk = handle.read(1024 * 1024)
                    if not chunk:
                        break
                    yield chunk
        finally:
            if extra_cleanup is not None:
                try:
                    extra_cleanup()
                except Exception:
                    pass

    size = file_path.stat().st_size if file_path.exists() else None
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    if size is not None:
        headers["Content-Length"] = str(size)

    return Response(generate(), mimetype="application/octet-stream", headers=headers)


@api_bp.errorhandler(AppStoreError)
def _handle_appstore_error(exc: AppStoreError):
    payload = {"error": str(exc)}
    if exc.metadata is not None:
        payload["metadata"] = exc.metadata
    
    # Add specific handling for license errors
    if isinstance(exc, LicenseRequiredError):
        payload["licenseRequired"] = True
    
    return jsonify(payload), HTTPStatus.BAD_REQUEST


@api_bp.post("/auth/login")
def login():
    data = request.get_json(force=True) or {}
    email = data.get("email")
    password = data.get("password")
    auth_code = data.get("authCode")
    if not email or not password:
        return jsonify({"error": "email and password are required"}), HTTPStatus.BAD_REQUEST

    try:
        account = _service().login(email=email, password=password, auth_code=auth_code)
    except AuthCodeRequiredError as exc:
        return (
            jsonify({"error": str(exc) or "auth code required", "authCodeRequired": True}),
            HTTPStatus.UNAUTHORIZED,
        )

    return jsonify({"account": account.to_dict()})


@api_bp.post("/auth/logout")
def logout():
    """Sign out of the current App Store session.

    Prior to the recent changes this only deleted the account blob from the
    keychain file; the HTTP cookie jar was left intact which meant Apple
    continued to recognise the session and never prompted for a new 2‑factor
    code.  ``AppStoreService.revoke()`` now clears cookies too.

    If you're wiping storage manually for testing make sure the server is
    restarted or call this endpoint after removing the files, otherwise the in
    memory cookie jar will still hold valid tokens.
    """
    _service().revoke()
    return jsonify({"status": "ok"})


@api_bp.get("/account")
def account_info():
    try:
        account = _service().account_info()
    except AppStoreError:
        return jsonify({"account": None}), HTTPStatus.NOT_FOUND

    return jsonify({"account": account.to_dict()})


@api_bp.get("/search")
def search():
    term = request.args.get("term")
    if not term:
        return jsonify({"error": "term query parameter is required"}), HTTPStatus.BAD_REQUEST
    limit = int(request.args.get("limit", 5))
    include_tvos = request.args.get("includeTvos", "false").lower() == "true"
    platform = _parse_platform_param(request.args.get("platform"))

    account = _service().account_info()
    result = _service().search(account, term, limit, include_tvos, platform=platform)
    return jsonify({
        "count": result.count,
        "results": [app.to_dict() for app in result.results],
    })


@api_bp.post("/purchase")
def purchase():
    payload = request.get_json(force=True) or {}
    account = _service().account_info()
    app = _resolve_app(payload, account)
    _service().purchase(account, app)
    return jsonify({"status": "purchased"})


@api_bp.post("/download")
def download():
    payload = request.get_json(force=True) or {}
    platform = _parse_platform_param(payload.get("platform"))
    account = _service().account_info()
    app = _resolve_app(payload, account)
    output_path = payload.get("outputPath")
    external_version_id = _resolve_external_version_id(account, app, platform, payload.get("externalVersionId"))
    auto_purchase = bool(payload.get("purchaseIfNeeded", False))

    service = _service()
    download_result = None
    for _ in range(3):
        try:
            download_result = service.download(
                account=account,
                app=app,
                output_path=output_path,
                external_version_id=external_version_id,
            )
            break
        except PasswordTokenExpiredError:
            if not account.password:
                raise
            account = service.login(email=account.email, password=account.password)
        except LicenseRequiredError:
            if not auto_purchase:
                raise
            service.purchase(account, app)
    if download_result is None:
        raise AppStoreError("failed to download app")

    service.replicate_sinf(download_result.destination_path, download_result.sinfs)
    service.validate_package_platform(download_result.destination_path, platform)

    return jsonify(
        {
            "destinationPath": download_result.destination_path,
            "sinfCount": len(download_result.sinfs),
        }
    )


@api_bp.post("/download-stream")
def download_stream():
    """Stream IPA download directly to the browser."""
    payload = request.get_json(force=True) or {}
    platform = _parse_platform_param(payload.get("platform"))
    account = _service().account_info()
    app = _resolve_app(payload, account)
    external_version_id = _resolve_external_version_id(account, app, platform, payload.get("externalVersionId"))
    auto_purchase = bool(payload.get("purchaseIfNeeded", False))

    service = _service()
    
    # Use a temp directory for downloads
    temp_dir = Path(service._storage_dir) / "temp_downloads"
    temp_dir.mkdir(parents=True, exist_ok=True)
    
    download_result = None
    for _ in range(3):
        try:
            download_result = service.download(
                account=account,
                app=app,
                output_path=str(temp_dir),
                external_version_id=external_version_id,
            )
            break
        except PasswordTokenExpiredError:
            if not account.password:
                raise
            account = service.login(email=account.email, password=account.password)
        except LicenseRequiredError:
            if not auto_purchase:
                raise
            service.purchase(account, app)
    
    if download_result is None:
        raise AppStoreError("failed to download app")

    service.replicate_sinf(download_result.destination_path, download_result.sinfs)
    service.validate_package_platform(download_result.destination_path, platform)
    
    file_path = Path(download_result.destination_path)
    filename = file_path.name

    return _send_file_and_cleanup(file_path, filename)


@api_bp.post("/download-jobs")
def start_download_job():
    """Kick off a download in a background thread and return immediately.

    This replaces the old pattern of doing the whole Apple download + zip
    patch inside a single blocking request (see /download-stream above): that
    gave the client zero feedback for however long the transfer took, and
    required the connection to survive the whole thing. Old/flaky clients -
    Mobile Safari on iOS 6 in particular, which also can't receive a binary
    response via XHR2 blob responseType at all - would just sit on
    "Preparing download..." forever with no way to tell if anything was
    actually happening.

    Here, the client polls GET /api/download-jobs/<id> (fast, tiny requests)
    for real byte-level progress, then either fetches the finished file via a
    plain GET to /api/download-jobs/<id>/file (an ordinary browser download/
    navigation, no Blob/XHR2 needed), or - if `saveToServerFolder` was set -
    the file is left in a persistent, user-visible folder on the machine
    running the server and never sent over HTTP at all. The latter exists
    because on some old/constrained browsers (Mobile Safari on iOS 6 in
    particular) even the hidden-iframe download handoff doesn't reliably
    result in a saved file - there's no download manager to catch it. If the
    server itself runs on the device in question (e.g. via a jailbreak),
    saving straight to a folder sidesteps the browser entirely.
    """
    payload = request.get_json(force=True) or {}
    platform = _parse_platform_param(payload.get("platform"))
    account = _service().account_info()
    app = _resolve_app(payload, account)
    external_version_id = _resolve_external_version_id(account, app, platform, payload.get("externalVersionId"))
    auto_purchase = bool(payload.get("purchaseIfNeeded", False))
    save_to_server_folder = bool(payload.get("saveToServerFolder", False))

    service = _service()
    job = download_jobs.create()

    def worker() -> None:
        try:
            if save_to_server_folder:
                # A persistent, user-visible folder (not the transient
                # temp_downloads dir used for browser-served downloads,
                # which gets swept/deleted automatically).
                out_dir = Path(service._machine.home_directory()) / "Downloads" / "IPATool"
            else:
                out_dir = Path(service._storage_dir) / "temp_downloads"
            out_dir.mkdir(parents=True, exist_ok=True)

            local_account = account
            download_result = None
            for _ in range(3):
                try:
                    download_result = service.download(
                        account=local_account,
                        app=app,
                        output_path=str(out_dir),
                        external_version_id=external_version_id,
                        on_progress=download_jobs.progress_callback(job.id),
                        on_patch_progress=download_jobs.patch_progress_callback(job.id),
                    )
                    break
                except PasswordTokenExpiredError:
                    if not local_account.password:
                        raise
                    local_account = service.login(email=local_account.email, password=local_account.password)
                except LicenseRequiredError:
                    if not auto_purchase:
                        raise
                    service.purchase(local_account, app)

            if download_result is None:
                raise AppStoreError("failed to download app")

            service.replicate_sinf(
                download_result.destination_path,
                download_result.sinfs,
                on_progress=download_jobs.finalize_progress_callback(job.id),
            )
            service.validate_package_platform(download_result.destination_path, platform)

            file_path = Path(download_result.destination_path)
            size = file_path.stat().st_size
            if save_to_server_folder:
                download_jobs.update(
                    job.id,
                    status="ready",
                    filename=file_path.name,
                    server_path=str(file_path),
                    saved_to_server=True,
                    bytes_done=size,
                    bytes_total=size,
                )
            else:
                download_jobs.update(
                    job.id,
                    status="ready",
                    filename=file_path.name,
                    file_path=str(file_path),
                    bytes_done=size,
                    bytes_total=size,
                )
        except Exception as exc:  # noqa: BLE001 - surface any failure to the poller instead of losing it in a dead thread
            download_jobs.update(job.id, status="error", error=str(exc))

    threading.Thread(target=worker, daemon=True, name=f"download-job-{job.id}").start()
    return jsonify({"jobId": job.id})


@api_bp.get("/download-jobs/<job_id>")
def poll_download_job(job_id: str):
    job = download_jobs.get(job_id)
    if job is None:
        return jsonify({"error": "job not found"}), HTTPStatus.NOT_FOUND
    return jsonify(job.to_dict())


@api_bp.get("/download-jobs/<job_id>/file")
def fetch_download_job_file(job_id: str):
    job = download_jobs.get(job_id)
    if job is None or job.status != "ready" or not job.file_path:
        return jsonify({"error": "file not ready"}), HTTPStatus.NOT_FOUND

    file_path = Path(job.file_path)
    if not file_path.exists():
        return jsonify({"error": "file not found"}), HTTPStatus.NOT_FOUND

    # Deliberately does not remove the job or delete the file immediately
    # after serving - some browsers' download managers (observed: Orion on
    # iOS) make more than one request to a download URL before committing
    # to save it. Removing the job entry (or the file) after the first
    # request served it out from under a second one, which 404's and shows
    # up as an instant "failed" download with no filename. The existing
    # 30-minute job TTL sweep (DownloadJobRegistry._sweep) still cleans
    # both up.
    return _send_file_and_cleanup(file_path, job.filename or file_path.name)


@api_bp.get("/versions")
def list_versions():
    params = request.args or {}
    platform = _parse_platform_param(params.get("platform"))
    account = _service().account_info()
    app = _resolve_app(params, account)
    external_version_id = _resolve_external_version_id(account, app, platform, params.get("externalVersionId"))
    output = _service().list_versions(account, app, external_version_id)
    return jsonify(
        {
            "latestExternalVersionId": output.latest_external_version_id,
            "externalVersionIdentifiers": output.external_version_identifiers,
        }
    )


@api_bp.get("/versions/community")
def list_versions_community():
    """Version list from a third-party, crowd-sourced database (Timbrd),
    independent of the requesting Apple ID's own eligibility with Apple's
    servers. Separate, opt-in path - see AppStoreService.list_versions_community
    for details/caveats. The actual .ipa is still fetched through the
    normal, official download flow once you have an external_version_id."""
    params = request.args or {}
    account = _service().account_info()
    app = _resolve_app(params, account)
    output = _service().list_versions_community(app)
    return jsonify(
        {
            "source": output.source,
            "entries": [entry.to_dict() for entry in output.entries],
        }
    )


@api_bp.get("/version-metadata")
def version_metadata():
    params = request.args or {}
    version_id = params.get("versionId")
    if not version_id:
        return jsonify({"error": "versionId is required"}), HTTPStatus.BAD_REQUEST

    account = _service().account_info()
    app = _resolve_app(params, account)
    metadata = _service().get_version_metadata(account, app, version_id)
    return jsonify(metadata.to_dict())


def _resolve_app(payload: Dict[str, Any], account: Account) -> App:
    service = _service()
    bundle_id = payload.get("bundleId")
    app_id = payload.get("appId")

    if bundle_id:
        return service.lookup(account, bundle_id)

    if app_id:
        return App(id=int(app_id))

    raise AppStoreError("either appId or bundleId must be supplied")


def _parse_platform_param(value: Any) -> str:
    from ..services import platform as platform_module

    try:
        return platform_module.parse_platform(value)
    except ValueError as exc:
        raise AppStoreError(str(exc)) from exc


def _resolve_external_version_id(account: Account, app: App, platform: str, explicit_id: Any) -> Any:
    """If the caller asked for Apple TV but didn't pin a specific version,
    resolve the latest tvOS external version id via the MDM lookup so the
    normal download/list-versions calls return tvOS metadata instead of iOS's
    (see AppStoreService.lookup_latest_external_version_id)."""
    from ..services import platform as platform_module

    if explicit_id:
        return explicit_id
    if platform == platform_module.PLATFORM_APPLETV:
        return _service().lookup_latest_external_version_id(account, app, platform)
    return explicit_id
