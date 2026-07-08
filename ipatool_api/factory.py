"""Flask application factory."""
from __future__ import annotations

import os
import shutil
from pathlib import Path

from flask import Flask

from .routes.api import api_bp
from .routes.ui import ui_bp
from .services import AppStoreConfig, AppStoreService, CookieStore, FileKeychain, Machine


def create_app(legacy: bool = False) -> Flask:
    package_root = Path(__file__).resolve().parent
    template_dir = package_root.parent / "templates"
    static_dir = package_root.parent / "static"

    app = Flask(
        __name__,
        template_folder=str(template_dir),
        static_folder=str(static_dir),
    )

    # When True, templates link the ES5 / prefixed-CSS "legacy" assets instead
    # of the modern ones, for compatibility with old browsers (e.g. Mobile
    # Safari on iOS 6). Toggle with `python app.py --legacy`.
    app.config["LEGACY_MODE"] = legacy

    machine = Machine()
    config_dir = Path(machine.home_directory()) / ".ipatool"
    config_dir.mkdir(parents=True, exist_ok=True)

    # Job tracking (DownloadJobRegistry) lives entirely in memory and its TTL
    # sweep only ever runs lazily, when a new job is created - so it never
    # gets a chance to clean up files left behind by a run that crashed or
    # was restarted before that happened. Anything already in temp_downloads
    # at startup is necessarily orphaned (nothing "in progress" can survive
    # a process restart), so it's always safe to just clear it out fresh.
    temp_downloads_dir = config_dir / "temp_downloads"
    if temp_downloads_dir.exists():
        for leftover in temp_downloads_dir.iterdir():
            try:
                if leftover.is_file():
                    leftover.unlink()
                elif leftover.is_dir():
                    shutil.rmtree(leftover, ignore_errors=True)
            except OSError:
                pass  # best-effort - a stubborn leftover here isn't worth failing startup over
    temp_downloads_dir.mkdir(parents=True, exist_ok=True)

    keychain = FileKeychain(str(config_dir / "keychain.json"))
    cookie_store = CookieStore(str(config_dir / "cookies.lwp"))

    verify: bool | str = True
    if os.getenv("IPATOOL_SSL_NO_VERIFY") == "1":
        verify = False
    else:
        ca_bundle_env = os.getenv("IPATOOL_CA_BUNDLE")
        if ca_bundle_env:
            verify = ca_bundle_env
        else:
            default_bundle = config_dir / "ca-bundle.pem"
            if default_bundle.exists():
                verify = str(default_bundle)

    appstore = AppStoreService(
        AppStoreConfig(
            keychain=keychain,
            cookie_store=cookie_store,
            machine=machine,
            verify=verify,
        )
    )

    app.config["APPSTORE_SERVICE"] = appstore

    app.register_blueprint(api_bp)
    app.register_blueprint(ui_bp)

    return app
