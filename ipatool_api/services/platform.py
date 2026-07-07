"""Platform selection (iPhone / iPad / Apple TV).

Ported from majd/ipatool's ``pkg/appstore/platform.go`` - a real mechanism
shipped in the current (v2.3.0+) Go tool, not a guess. See:
https://github.com/majd/ipatool (search for "platform.go").

Universal Purchase means most apps share a single adamId/trackId across
iOS/iPadOS/tvOS, so the normal search/download/list-versions endpoints can't
tell platforms apart by trackId alone - they default to iOS metadata. The
piece that actually resolves this is a separate MDM app-lookup endpoint
(see appstore.py's ``lookup_latest_external_version_id``), which upstream
only uses for Apple TV specifically (iPad content is generally already
reachable through the normal iOS metadata/binary).
"""
from __future__ import annotations

from typing import Optional

PLATFORM_IPHONE = "iphone"
PLATFORM_IPAD = "ipad"
PLATFORM_APPLETV = "appletv"

_ALIASES = {
    "": "",
    "iphone": PLATFORM_IPHONE,
    "ios": PLATFORM_IPHONE,
    "ipad": PLATFORM_IPAD,
    "appletv": PLATFORM_APPLETV,
    "apple-tv": PLATFORM_APPLETV,
    "atv": PLATFORM_APPLETV,
    "tvos": PLATFORM_APPLETV,
}


def parse_platform(value: Optional[str]) -> str:
    """Normalize a user-supplied platform string. Empty/None means 'default'
    (iPhone + iPad combined, matching the tool's original behavior)."""
    if not value:
        return ""
    key = value.strip().lower()
    if key not in _ALIASES:
        raise ValueError(f"invalid platform {value!r}: must be iphone, ipad, or appletv")
    return _ALIASES[key]


def search_entity(platform: str) -> str:
    """iTunes Search API 'entity' parameter for this platform.

    Matches Platform.searchEntity() in platform.go exactly.
    """
    if platform == "":
        return "software,iPadSoftware"
    if platform == PLATFORM_IPHONE:
        return "software"
    if platform == PLATFORM_IPAD:
        return "iPadSoftware"
    if platform == PLATFORM_APPLETV:
        return "software,tvSoftware"
    raise ValueError(f"invalid platform {platform!r}")


def metadata_platform(platform: str) -> str:
    """Value for the 'platform' query param on the MDM app-lookup endpoint
    (uclient-api.itunes.apple.com/.../MZStorePlatform.woa/wa/lookup).

    Matches Platform.metadataPlatform() in platform.go exactly - only
    iphone/ipad ("enterprisestore") and appletv ("atv9") are valid; there is
    no bare "" case here because upstream only calls this when it already
    knows it needs a platform-specific lookup (i.e. for Apple TV).
    """
    if platform in (PLATFORM_IPHONE, PLATFORM_IPAD):
        return "enterprisestore"
    if platform == PLATFORM_APPLETV:
        return "atv9"
    raise ValueError(f"invalid platform {platform!r} for metadata lookup")
