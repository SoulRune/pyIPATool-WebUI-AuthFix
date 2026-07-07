"""Web UI routes."""
from __future__ import annotations

from flask import Blueprint, current_app, render_template

ui_bp = Blueprint("ui", __name__)


@ui_bp.get("/")
def index():
    legacy = bool(current_app.config.get("LEGACY_MODE", False))
    return render_template("index.html", legacy=legacy)
