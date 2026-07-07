"""Re-implementation of the Go App Store client in Python."""
from __future__ import annotations

import json
import os
import plistlib
import html
import re
import time
from email.utils import parsedate_to_datetime
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo
from urllib.parse import urlparse, urlencode, parse_qs

import requests

from . import constants
from . import platform as platform_module
from .cookie_store import CookieStore
from .errors import (
    AppStoreError,
    AuthCodeRequiredError,
    InvalidCredentialsError,
    LicenseRequiredError,
    PasswordTokenExpiredError,
    SubscriptionRequiredError,
    TemporarilyUnavailableError,
)
from .http_client import (
    HTTPClient,
    HTTPClientResponseError,
    HTTPRequest,
    HTTPResult,
    Payload,
    ResponseDecodeError,
    XMLPayload,
    extract_urls,
)
from .keychain import FileKeychain
from .machine import Machine
from .models import (
    Account,
    App,
    BagOutput,
    DownloadOutput,
    GetVersionMetadataOutput,
    ListVersionsOutput,
    SearchOutput,
    Sinf,
)


@dataclass(slots=True)
class AppStoreConfig:
    keychain: FileKeychain
    cookie_store: CookieStore
    machine: Machine
    verify: bool | str = True


def normalize_auth_endpoint(*endpoints: str) -> str:
    for endpoint in endpoints:
        endpoint = (endpoint or "").strip()
        if not endpoint:
            continue

        normalized = normalize_native_auth_endpoint(endpoint)
        return normalized or endpoint

    return constants.DEFAULT_NATIVE_AUTH_ENDPOINT


def normalize_native_auth_endpoint(endpoint: str) -> str:
    parsed = urlparse(endpoint)
    if parsed.hostname != constants.PRIVATE_AUTH_DOMAIN:
        return ""

    path = parsed.path.rstrip("/")
    if not path.endswith("/fast"):
        path = f"{path.rstrip('/')}/fast"
    return parsed._replace(path=f"{path}/").geturl()


def auth_endpoint_from_response_error(exc: ResponseDecodeError) -> str:
    parts = list(exc.urls)
    if exc.body:
        parts.append(exc.body)
    return auth_endpoint_from_text(" ".join(parts))


def auth_endpoint_from_text(text: str) -> str:
    text = html.unescape(text.replace("\\/", "/"))
    for url in extract_urls(text.encode("utf-8", errors="replace")):
        endpoint = normalize_native_auth_endpoint(url.rstrip(".,;)"))
        if endpoint:
            return endpoint
    return ""


class AppStoreService:
    """Port of the Go ``appstore.AppStore`` implementation."""

    def __init__(self, config: AppStoreConfig) -> None:
        self._keychain = config.keychain
        self._machine = config.machine
        self._http = HTTPClient(config.cookie_store, verify=config.verify)
        self._verify = config.verify
        self._version_history_cache: Dict[Tuple[int, str], Dict[str, str]] = {}
        self._storage_dir = Path(config.machine.home_directory()) / ".ipatool"
        self._storage_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Authentication
    # ------------------------------------------------------------------

    def login(self, email: str, password: str, auth_code: str | None = None) -> Account:
        guid = self._guid()
        redirect_url: Optional[str] = None
        last_result: Optional[HTTPResult] = None

        retry = False

        bag_result = self.bag()
        auth_endpoint = normalize_auth_endpoint(bag_result.auth_endpoint)

        for attempt in range(1, 5):
            payload: Payload = XMLPayload(
                {
                    "appleId": email,
                    "attempt": str(attempt),
                    "guid": guid,
                    "password": f"{password}{(auth_code or '').replace(' ', '')}",
                    "rmp": "0",
                    "why": "signIn",
                }
            )
            url = redirect_url or auth_endpoint
            request = HTTPRequest(
                method="POST",
                url=url,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                payload=payload,
                response_format=constants.ResponseFormatXML,
                follow_redirects=False,
            )
            print(f"Attempt {attempt}: POST {url}")
            try:
                result = self._send_request(request, allow_decode_error=True)
            except ResponseDecodeError as exc:
                discovered_endpoint = auth_endpoint_from_response_error(exc)
                if discovered_endpoint and discovered_endpoint != auth_endpoint:
                    auth_endpoint = discovered_endpoint
                    redirect_url = None
                    continue
                raise AppStoreError("unexpected response from Apple", metadata={
                    "status": exc.status_code,
                    "headers": exc.headers,
                    "contentType": exc.content_type,
                    "body": exc.body,
                    "urls": exc.urls,
                }) from exc
            print(f"Status: {result.status_code}")
            print(f"Headers: {result.headers}")
            print(f"Data keys: {list(result.data.keys()) if isinstance(result.data, dict) else type(result.data)}")
            last_result = result

            retry, redirect_url = self._parse_login_response(result, attempt, auth_code)
            print(f"Retry: {retry}, Redirect URL: {redirect_url}")
            if not retry:
                break

        if last_result is None:
            raise AppStoreError("login attempt did not produce a response")

        if retry:
            raise AppStoreError("too many login attempts", metadata=last_result.data)

        try:
            store_front = last_result.get_header(constants.HTTP_HEADER_STOREFRONT)
        except KeyError as exc:
            raise AppStoreError("missing storefront header", metadata=last_result.headers) from exc

        try:
            pod = last_result.get_header(constants.HTTP_HEADER_POD)
        except KeyError:
            pod = None

        account_info = last_result.data.get("accountInfo", {})
        address = account_info.get("address", {})
        account = Account(
            email=account_info.get("appleId", email),
            name=" ".join(filter(None, [address.get("firstName"), address.get("lastName")])),
            password_token=last_result.data.get("passwordToken", ""),
            directory_services_id=last_result.data.get("dsPersonId", ""),
            store_front=store_front,
            password=password,
            pod=pod,
        )

        self._persist_account(account)
        return account

    def account_info(self) -> Account:
        try:
            data = self._keychain.get("account")
        except KeyError as exc:
            raise AppStoreError("no active account") from exc

        payload = json.loads(data.decode("utf-8"))
        return Account.from_dict(payload)

    def revoke(self) -> None:
        """Forget the currently-stored credentials.

        The earlier implementation only removed the account blob from the keychain
        which left the HTTP client's cookie jar intact.  That meant subsequent
        login attempts reused an existing App Store session and Apple never asked
        for a fresh 2‑factor code.  In order to fully reset the state we need to
        clear both pieces of storage.
        """
        # remove the serialized account
        self._keychain.remove("account")

        # clear cookies in memory and on disk so the next request starts a
        # completely fresh session.
        try:
            self._http.session.cookies.clear()
        except Exception:  # pragma: no cover - paranoia
            pass
        try:
            self._http._cookie_store.clear()
        except Exception:  # pragma: no cover
            pass

        # rotate the device guid as well; Apple can trust the guid itself even
        # after cookies are gone, so using a fresh guid forces a full login
        # challenge on the next attempt.
        try:
            self._machine.reset_device_guid()
        except Exception:  # pragma: no cover
            pass

    # ------------------------------------------------------------------
    # Bag retrieval
    # ------------------------------------------------------------------

    def bag(self) -> BagOutput:
        """Fetch the App Store bag to discover custom API endpoints."""
        guid = self._guid()
        request = HTTPRequest(
            method="GET",
            url=f"https://{constants.PRIVATE_INIT_DOMAIN}{constants.PRIVATE_INIT_PATH}?guid={guid}",
            headers={"Accept": "application/xml"},
            payload=None,
            response_format=constants.ResponseFormatXML,
        )
        result = self._send_request(request)
        url_bag = result.data.get("urlBag", {})
        auth_endpoint = normalize_auth_endpoint(
            result.data.get("authenticateAccount", ""),
            url_bag.get("authenticateAccount", ""),
        )
        return BagOutput(auth_endpoint=auth_endpoint)

    # ------------------------------------------------------------------
    # App discovery
    # ------------------------------------------------------------------

    def search(
        self,
        account: Account,
        term: str,
        limit: int = 5,
        include_tvos: bool = False,
        platform: str = "",
    ) -> SearchOutput:
        country = self._country_code_from_storefront(account.store_front)
        # `platform` (iphone/ipad/appletv) takes precedence when given and
        # uses the exact entity mapping majd/ipatool ships (searchEntity()):
        # iphone->software, ipad->iPadSoftware, appletv->software,tvSoftware,
        # default->software,iPadSoftware. `include_tvos` is kept only for
        # backward compatibility with callers that predate platform support.
        if platform:
            entity = platform_module.search_entity(platform)
        else:
            entity = "software,iPadSoftware"
            if include_tvos:
                entity += ",tvSoftware"
        params = {
            "entity": entity,
            "limit": str(limit),
            "media": "software",
            "term": term,
            "country": country,
        }
        url = self._build_query_url(constants.ITUNES_API_SEARCH_PATH, params)
        request = HTTPRequest(
            method="GET",
            url=url,
            headers={},
            payload=None,
            response_format=constants.ResponseFormatJSON,
        )
        result = self._send_request(request)
        apps = [App.from_dict(item) for item in result.data.get("results", [])]
        return SearchOutput(count=int(result.data.get("resultCount", len(apps))), results=apps)

    def lookup(self, account: Account, bundle_id: str) -> App:
        country = self._country_code_from_storefront(account.store_front)
        params = {
            "entity": "software,iPadSoftware",
            "limit": "1",
            "media": "software",
            "bundleId": bundle_id,
            "country": country,
        }
        url = self._build_query_url(constants.ITUNES_API_LOOKUP_PATH, params)
        request = HTTPRequest(
            method="GET",
            url=url,
            headers={},
            payload=None,
            response_format=constants.ResponseFormatJSON,
        )
        result = self._send_request(request)
        results = result.data.get("results", [])
        if not results:
            raise AppStoreError("app not found", metadata=result.data)
        return App.from_dict(results[0])

    # ------------------------------------------------------------------
    # Purchasing & downloading
    # ------------------------------------------------------------------

    def purchase(self, account: Account, app: App) -> None:
        if app.price and app.price > 0:
            raise AppStoreError("purchasing paid apps is not supported")

        guid = self._guid()
        try:
            self._purchase_with_params(account, app, guid, constants.PRICING_PARAM_APPSTORE)
        except TemporarilyUnavailableError:
            self._purchase_with_params(account, app, guid, constants.PRICING_PARAM_ARCADE)

    def _purchase_with_params(self, account: Account, app: App, guid: str, pricing: str) -> None:
        payload = {
            "appExtVrsId": "0",
            "hasAskedToFulfillPreorder": "true",
            "buyWithoutAuthorization": "true",
            "hasDoneAgeCheck": "true",
            "guid": guid,
            "needDiv": "0",
            "origPage": f"Software-{app.id}",
            "origPageLocation": "Buy",
            "price": "0",
            "pricingParameters": pricing,
            "productType": "C",
            "salableAdamId": app.id,
        }
        pod_prefix = f"p{account.pod}-" if account.pod else ""
        request = HTTPRequest(
            method="POST",
            url=f"https://{pod_prefix}{constants.PRIVATE_APPSTORE_HOST}{constants.PRIVATE_PURCHASE_PATH}",
            headers={
                "iCloud-DSID": account.directory_services_id,
                "X-Dsid": account.directory_services_id,
                "X-Apple-Store-Front": account.store_front,
                "X-Token": account.password_token,
            },
            payload=XMLPayload(payload),
            response_format=constants.ResponseFormatXML,
        )
        result = self._send_request(request)
        failure_type = result.data.get("failureType", "")
        customer_message = result.data.get("customerMessage", "")

        if failure_type == constants.FAILURE_TEMPORARILY_UNAVAILABLE:
            raise TemporarilyUnavailableError("item temporarily unavailable", metadata=result.data)
        if customer_message == constants.CUSTOMER_MESSAGE_SUBSCRIPTION_REQUIRED:
            raise SubscriptionRequiredError("subscription required", metadata=result.data)
        if failure_type == constants.FAILURE_PASSWORD_TOKEN_EXPIRED:
            raise PasswordTokenExpiredError("password token expired", metadata=result.data)
        if failure_type:
            message = customer_message or "purchase failed"
            raise AppStoreError(message, metadata=result.data)

        if result.status_code == 500:
            raise AppStoreError("license already exists", metadata=result.data)

        if result.data.get("jingleDocType") != "purchaseSuccess" or result.data.get("status") != 0:
            raise AppStoreError("failed to complete purchase", metadata=result.data)

    def download(
        self,
        account: Account,
        app: App,
        output_path: Optional[str] = None,
        external_version_id: Optional[str] = None,
        on_progress: Optional["Callable[[int, Optional[int]], None]"] = None,
        on_patch_progress: Optional["Callable[[int, int], None]"] = None,
    ) -> DownloadOutput:
        guid = self._guid()
        result = self._send_download_request(account, app, guid, external_version_id)
        self._validate_download_result(result)

        items = result.data.get("songList", [])
        if not items:
            raise AppStoreError("invalid download response", metadata=result.data)

        item = items[0]
        metadata = dict(item.get("metadata", {}))
        version = str(metadata.get("bundleShortVersionString", "unknown"))

        destination = self._resolve_destination_path(app, version, output_path)
        temp_destination = destination + ".tmp"
        self._download_file(item.get("URL"), temp_destination, on_progress=on_progress)
        self._apply_patches(temp_destination, destination, metadata, account, on_progress=on_patch_progress)
        Path(temp_destination).unlink(missing_ok=True)

        sinfs = [Sinf(id=int(s.get("id", 0)), data=s.get("sinf", b"")) for s in item.get("sinfs", [])]
        return DownloadOutput(destination_path=destination, sinfs=sinfs)

    def replicate_sinf(
        self,
        package_path: str,
        sinfs: Iterable[Sinf],
        on_progress: Optional["Callable[[int, int], None]"] = None,
    ) -> None:
        source = Path(package_path)
        temp = source.with_suffix(source.suffix + ".tmp")

        try:
            with ZipFile(source, "r") as src_zip, temp.open("wb") as dst_fd:
                with ZipFile(dst_fd, "w") as dst_zip:
                    self._replicate_zip(src_zip, dst_zip, on_progress=on_progress)
                    bundle_name = self._read_bundle_name(src_zip)
                    manifest = self._read_manifest_plist(src_zip)
                    info = self._read_info_plist(src_zip)

                    sinf_list = list(sinfs)
                    if manifest:
                        self._replicate_sinf_from_manifest(dst_zip, manifest, sinf_list, bundle_name)
                    elif info:
                        self._replicate_sinf_from_info(dst_zip, info, sinf_list, bundle_name)
                    else:
                        raise AppStoreError("failed to find manifest or info plist")
        except Exception:
            # temp is fully our own responsibility here; source is untouched
            # at this point (see below for why that matters), so just clean
            # up our half-written temp file and let the error propagate.
            temp.unlink(missing_ok=True)
            raise

        # temp now holds a complete, correctly SINF-patched IPA. Swap it in
        # for `source` with a single atomic replace() rather than a separate
        # unlink() + rename(): those are two independent syscalls, and if
        # anything went wrong between them (a transient lock - see the
        # Windows PermissionError handling in _send_file_and_cleanup - a
        # concurrent request touching the same destination path, or any
        # other interruption) the old unlink()-then-rename() code would
        # leave the stale, SINF-less `source` sitting untouched next to a
        # fully valid, unrenamed `temp` - exactly the "two files, .tmp is
        # the one that actually installs" symptom. replace() is a single
        # syscall on both POSIX and Windows and overwrites the destination
        # if it exists, so there's no window where that can happen.
        last_error: Optional[Exception] = None
        for attempt in range(5):
            try:
                temp.replace(source)
                return
            except PermissionError as exc:
                last_error = exc
                time.sleep(0.3 * (attempt + 1))
        raise AppStoreError(f"failed to finalize patched package: {last_error}") from last_error

    def list_versions(self, account: Account, app: App, external_version_id: Optional[str] = None) -> ListVersionsOutput:
        guid = self._guid()
        result = self._send_download_request(account, app, guid, external_version_id)
        self._validate_download_result(result)
        item = self._extract_first_item(result)

        metadata = item.get("metadata", {})
        identifiers = metadata.get("softwareVersionExternalIdentifiers")
        if not isinstance(identifiers, list):
            raise AppStoreError("invalid version identifiers", metadata=metadata)
        external_ids = [str(value) for value in identifiers]
        latest = str(metadata.get("softwareVersionExternalIdentifier"))
        return ListVersionsOutput(
            external_version_identifiers=external_ids,
            latest_external_version_id=latest,
        )

    # ------------------------------------------------------------------
    # Platform (iPhone / iPad / Apple TV) support
    # ------------------------------------------------------------------
    #
    # Ported from majd/ipatool v2.3.0's pkg/appstore/appstore_platform_version_lookup.go
    # (github.com/majd/ipatool). Universal Purchase means most apps share one
    # adamId across iOS/iPadOS/tvOS, so the normal search/download endpoints
    # can't distinguish platforms by trackId alone and default to iOS
    # metadata. This separate MDM app-lookup endpoint resolves the *latest*
    # external version id for a specific platform; feeding that id into the
    # existing list_versions()/download() calls (which already accept an
    # external_version_id) then returns that platform's own metadata/binary
    # instead of iOS's.

    def lookup_latest_external_version_id(self, account: Account, app: App, platform: str) -> str:
        if not app.id:
            raise AppStoreError("app id is required for platform version lookup")

        country_code = self._country_code_from_storefront(account.store_front)
        metadata_platform = platform_module.metadata_platform(platform)

        params = {
            "version": "2",
            "id": str(app.id),
            "p": "mdm-lockup",
            "caller": "MDM",
            "platform": metadata_platform,
            "cc": country_code.lower(),
            "l": "en",
        }
        url = "https://uclient-api.itunes.apple.com/WebObjects/MZStorePlatform.woa/wa/lookup?" + urlencode(params)
        request = HTTPRequest(
            method="GET",
            url=url,
            headers={},
            payload=None,
            response_format=constants.ResponseFormatJSON,
        )
        result = self._send_request(request)

        data = result.data if isinstance(result.data, dict) else {}
        results = data.get("results", {}) if isinstance(data.get("results"), dict) else {}
        item = results.get(str(app.id))
        if not item:
            raise AppStoreError("platform version lookup returned no app", metadata=data)

        offers = item.get("offers") or []
        if not offers:
            raise AppStoreError("platform version lookup returned no offers", metadata=data)

        offer = offers[0]
        version_info = offer.get("version") or {}
        external_version_id = str(version_info.get("externalId") or "")

        if not external_version_id:
            buy_params = offer.get("buyParams", "")
            parsed = parse_qs(buy_params)
            values = parsed.get("appExtVrsId")
            external_version_id = values[0] if values else ""

        if not external_version_id:
            raise AppStoreError("platform version lookup returned no external version id", metadata=data)

        return external_version_id

    def validate_package_platform(self, package_path: str, platform: str) -> None:
        """Sanity-check that a downloaded .ipa actually declares support for
        the requested platform. Only meaningful for Apple TV (iPhone/iPad
        binaries aren't distinguished this way) - mirrors validatePackagePlatform
        in majd/ipatool's appstore_download.go.
        """
        if platform != platform_module.PLATFORM_APPLETV:
            return

        with ZipFile(package_path) as zf:
            for name in zf.namelist():
                if not name.startswith("Payload/") or not name.endswith(".app/Info.plist"):
                    continue
                try:
                    data = zf.read(name)
                    info = plistlib.loads(data)
                except Exception:
                    continue
                supported = info.get("CFBundleSupportedPlatforms", [])
                if "AppleTVOS" in supported:
                    return

        raise AppStoreError("downloaded package does not declare AppleTVOS support")

    def get_version_metadata(self, account: Account, app: App, version_id: str) -> GetVersionMetadataOutput:
        guid = self._guid()
        result = self._send_download_request(account, app, guid, version_id)
        self._validate_download_result(result)
        item = self._extract_first_item(result)

        metadata = item.get("metadata", {})
        asset_info = item.get("asset-info", {})
        
        display_version = str(metadata.get("bundleShortVersionString", "N/A"))
        release = self._release_date_from_metadata(metadata, result.headers)
        history_date = self._app_store_history_dates(account, app).get(display_version)
        if history_date:
            release = self._parse_apple_date(history_date)
        release_display = self._release_date_display(account, app, metadata, release)

        age_ratings = metadata.get("appAgeRatings", {})
        us_rating = age_ratings.get("US", {})

        return GetVersionMetadataOutput(
            display_version=display_version,
            build_number=str(metadata.get("bundleVersion", "N/A")),
            release_date=release,
            release_date_display=release_display,
            file_size=asset_info.get("file-size", 0),
            bundle_id=str(metadata.get("softwareVersionBundleId", "N/A")),
            artist_name=str(metadata.get("artistName", "N/A")),
            item_name=str(metadata.get("itemName", "N/A")),
            genre=str(metadata.get("genre", "N/A")),
            age_rating=str(us_rating.get("label", "N/A")),
            requires_rosetta=bool(metadata.get("requiresRosetta", False)),
            runs_on_apple_silicon=bool(metadata.get("runsOnAppleSilicon", False)),
            copyright_info=str(metadata.get("copyright", "N/A")),
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _persist_account(self, account: Account) -> None:
        payload = json.dumps(account.to_dict(), indent=2)
        self._keychain.set("account", payload.encode("utf-8"))

    def _parse_login_response(
        self, result: HTTPResult, attempt: int, auth_code: Optional[str]
    ) -> Tuple[bool, Optional[str]]:
        status = result.status_code
        data = result.data
        failure_type = data.get("failureType", "")
        customer_message = data.get("customerMessage", "")

        if status in (301, 302, 303, 307, 308):
            try:
                return True, result.get_header("Location")
            except KeyError:
                return True, None

        if attempt == 1 and failure_type == constants.FAILURE_INVALID_CREDENTIALS:
            return True, None

        if not failure_type and not auth_code and customer_message == constants.CUSTOMER_MESSAGE_BAD_LOGIN:
            raise AuthCodeRequiredError("two-factor auth code required", metadata=data)

        if not failure_type and customer_message == constants.CUSTOMER_MESSAGE_ACCOUNT_DISABLED:
            raise AppStoreError("account is disabled", metadata=data)

        if not failure_type and customer_message == constants.CUSTOMER_MESSAGE_ACTION_SIGN_IN_PAGE:
            raise AppStoreError(
                "account requires browser sign-in (2FA or Apple ID review required)",
                metadata=data,
            )

        if failure_type and customer_message:
            raise AppStoreError(customer_message, metadata=data)

        if failure_type:
            raise AppStoreError("authentication failed", metadata=data)

        if status != 200 or not data.get("passwordToken") or not data.get("dsPersonId"):
            raise AppStoreError("invalid authentication response", metadata=data)

        return False, None

    def _country_code_from_storefront(self, store_front: str) -> str:
        prefix = store_front.split("-")[0]
        for code, value in constants.STORE_FRONTS.items():
            if value == prefix:
                return code
        raise AppStoreError(f"unknown storefront: {store_front}")

    def _build_query_url(self, path: str, params: Dict[str, str]) -> str:
        from urllib.parse import urlencode

        query = urlencode(params)
        return f"https://{constants.ITUNES_API_DOMAIN}{path}?{query}"

    def _release_date_from_metadata(
        self,
        metadata: Dict[str, Any],
        headers: Dict[str, str],
    ) -> Optional[datetime]:
        generated_dates = self._response_generated_dates(headers)
        for key in (
            "softwareVersionReleaseDate",
            "versionReleaseDate",
            "currentVersionReleaseDate",
        ):
            raw_value = metadata.get(key)
            parsed = self._parse_apple_date(raw_value)
            if not parsed:
                continue
            if any(parsed == generated or parsed.date() == generated.date() for generated in generated_dates):
                continue
            return parsed
        return None

    def _release_date_display(
        self,
        account: Account,
        app: App,
        metadata: Dict[str, Any],
        release: Optional[datetime],
    ) -> str:
        display_version = str(metadata.get("bundleShortVersionString", "")).strip()
        history_date = self._app_store_history_dates(account, app).get(display_version)
        if history_date:
            return history_date
        if release:
            return release.date().isoformat()

        original_release = self._parse_apple_date(metadata.get("releaseDate"))
        if original_release:
            return f"Unknown ({original_release.date().isoformat()})"
        return "Unknown"

    def _app_store_history_dates(self, account: Account, app: App) -> Dict[str, str]:
        country = self._country_code_from_storefront(account.store_front).lower()
        cache_key = (app.id, country)
        cached = self._version_history_cache.get(cache_key)
        if cached is not None:
            return cached

        url = f"https://apps.apple.com/{country}/app/id{app.id}"
        try:
            response = requests.get(
                url,
                headers={"User-Agent": constants.DEFAULT_USER_AGENT},
                timeout=10,
                verify=self._verify,
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            print(f"Failed to fetch App Store version history from {url}: {exc}")
            self._version_history_cache[cache_key] = {}
            return {}

        history = self._parse_app_store_history_dates(response.text)
        self._version_history_cache[cache_key] = history
        return history

    def _parse_app_store_history_dates(self, page_html: str) -> Dict[str, str]:
        history: Dict[str, str] = {}
        pattern = re.compile(
            r'<div[^>]*class="[^"]*\bmetadata\b[^"]*"[^>]*>\s*'
            r'<span[^>]*>\s*([^<]+?)\s*</span>\s*'
            r'<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"[^>]*>',
            re.IGNORECASE | re.DOTALL,
        )
        for version, release_date in pattern.findall(page_html):
            version = html.unescape(version).strip()
            if version and version not in history:
                history[version] = release_date
        return history

    def _response_generated_dates(self, headers: Dict[str, str]) -> List[datetime]:
        dates: List[datetime] = []
        for key in ("x-apple-date-generated", "Date", "Expires"):
            parsed = self._parse_apple_date(headers.get(key))
            if parsed:
                dates.append(parsed)
        return dates

    def _parse_apple_date(self, value: Any) -> Optional[datetime]:
        if not value:
            return None
        if isinstance(value, datetime):
            return value
        text = str(value).strip()
        if not text:
            return None
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            pass
        try:
            return parsedate_to_datetime(text)
        except (TypeError, ValueError):
            return None

    def _send_request(self, request: HTTPRequest, allow_decode_error: bool = False) -> HTTPResult:
        try:
            print(f"Sending {request.method} request to {request.url}")
            response = self._http.send(request)
            print(f"Response status: {response.status_code}")
            print(f"Response headers: {response.headers}")
            print(f"Response data type: {type(response.data)}")
            return response
        except HTTPClientResponseError as exc:
            print(f"HTTP error: {exc.status_code} {exc.body}")
            body_preview = exc.body[:2048]
            if isinstance(body_preview, bytes):
                body_text = body_preview.decode("utf-8", errors="replace")
            else:
                body_text = str(body_preview)
            metadata = {
                "status": exc.status_code,
                "headers": exc.headers,
                "body": body_text,
            }
            raise AppStoreError("unexpected response from Apple", metadata=metadata) from exc
        except ResponseDecodeError as exc:
            if allow_decode_error:
                raise
            metadata = {
                "status": exc.status_code,
                "headers": exc.headers,
                "contentType": exc.content_type,
                "body": exc.body,
                "urls": exc.urls,
            }
            raise AppStoreError("unexpected response from Apple", metadata=metadata) from exc
        except requests.RequestException as exc:
            raise AppStoreError("network request failed", metadata={"error": str(exc)}) from exc

    def _guid(self) -> str:
        return self._machine.device_guid()

    def _send_download_request(
        self,
        account: Account,
        app: App,
        guid: str,
        external_version_id: Optional[str],
    ) -> HTTPResult:
        pod_prefix = f"p{account.pod}-" if account.pod else ""
        payload: Dict[str, Any] = {
            "creditDisplay": "",
            "guid": guid,
            "salableAdamId": app.id,
        }
        if external_version_id:
            payload["externalVersionId"] = external_version_id

        request = HTTPRequest(
            method="POST",
            url=f"https://{pod_prefix}{constants.PRIVATE_APPSTORE_HOST}{constants.PRIVATE_DOWNLOAD_PATH}?guid={guid}",
            headers={
                "iCloud-DSID": account.directory_services_id,
                "X-Dsid": account.directory_services_id,
            },
            payload=XMLPayload(payload),
            response_format=constants.ResponseFormatXML,
        )
        return self._send_request(request)

    def _validate_download_result(self, result: HTTPResult) -> None:
        failure_type = result.data.get("failureType", "")
        customer_message = result.data.get("customerMessage", "")

        if failure_type == constants.FAILURE_PASSWORD_TOKEN_EXPIRED:
            raise PasswordTokenExpiredError("password token expired", metadata=result.data)
        if failure_type == constants.FAILURE_LICENSE_NOT_FOUND:
            raise LicenseRequiredError("license required", metadata=result.data)
        if failure_type and customer_message:
            raise AppStoreError(customer_message, metadata=result.data)
        if failure_type:
            raise AppStoreError(f"download failed ({failure_type})", metadata=result.data)

    def _extract_first_item(self, result: HTTPResult) -> Dict[str, Any]:
        items = result.data.get("songList", [])
        if not items:
            raise AppStoreError("invalid response payload", metadata=result.data)
        return items[0]

    def _resolve_destination_path(self, app: App, version: str, output_path: Optional[str]) -> str:
        file_name_parts = []
        if app.bundle_id:
            file_name_parts.append(app.bundle_id)
        if app.id:
            file_name_parts.append(str(app.id))
        if version:
            file_name_parts.append(version)
        file_name = "_".join(file_name_parts) + ".ipa"

        if not output_path:
            return str(Path.cwd() / file_name)

        output = Path(output_path)
        if output.is_dir() or output_path.endswith(os.sep):
            return str(output / file_name)
        return str(output)

    # ipatool-py wraps its download in up to 10 retries (downloadFile()) on
    # top of a connection-level retrying adapter; we mirror that here so a
    # stalled/reset connection to Apple's CDN (which used to hang forever -
    # see DEFAULT_READ_TIMEOUT / DOWNLOAD_READ_TIMEOUT in constants.py, or
    # previously had no timeout at all) is retried automatically server-side
    # instead of surfacing as a failed request the user has to notice and
    # retry by hand.
    _DOWNLOAD_MAX_RETRIES = 8

    def _download_file(
        self,
        url: str,
        destination: str,
        on_progress: Optional["Callable[[int, Optional[int]], None]"] = None,
    ) -> None:
        dest_path = Path(destination)
        dest_path.parent.mkdir(parents=True, exist_ok=True)

        last_error: Optional[Exception] = None
        for attempt in range(1, self._DOWNLOAD_MAX_RETRIES + 1):
            try:
                self._download_file_once(url, dest_path, on_progress=on_progress)
                return
            except (requests.exceptions.RequestException, OSError) as exc:
                last_error = exc
                if attempt < self._DOWNLOAD_MAX_RETRIES:
                    # The partial file is intentionally left on disk: the
                    # next attempt resumes via Range instead of restarting
                    # the whole transfer.
                    time.sleep(min(2 ** (attempt - 1), 15))
                    continue

        dest_path.unlink(missing_ok=True)
        raise AppStoreError(
            f"download failed after {self._DOWNLOAD_MAX_RETRIES} attempts: {last_error}"
        ) from last_error

    def _download_file_once(
        self,
        url: str,
        dest_path: Path,
        on_progress: Optional["Callable[[int, Optional[int]], None]"] = None,
    ) -> None:
        existing = dest_path.stat().st_size if dest_path.exists() else 0
        headers = {}
        if existing:
            headers["Range"] = f"bytes={existing}-"

        response = self._http.raw_request("GET", url, headers=headers, stream=True)
        try:
            response.raise_for_status()

            # Some pre-signed CDN URLs ignore Range and just return 200 with
            # the full body again. Appending that onto an existing partial
            # file would silently produce a corrupt, oversized IPA, so only
            # treat this as a resume if the server actually replied 206.
            resumed = existing > 0 and response.status_code == 206
            mode = "ab" if resumed else "wb"
            base_offset = existing if resumed else 0

            expected_total: Optional[int] = None
            content_length = response.headers.get("Content-Length")
            if content_length is not None:
                try:
                    expected_total = base_offset + int(content_length)
                except ValueError:
                    expected_total = None

            written = base_offset
            if on_progress:
                on_progress(written, expected_total)
            with dest_path.open(mode) as handle:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    handle.write(chunk)
                    written += len(chunk)
                    if on_progress:
                        on_progress(written, expected_total)

            if expected_total is not None and written != expected_total:
                # Treat a short/incomplete transfer as retryable rather than
                # silently handing a truncated IPA to the zip-patching step.
                raise requests.exceptions.ChunkedEncodingError(
                    f"incomplete download: got {written} bytes, expected {expected_total}"
                )
        finally:
            response.close()

    def _apply_patches(
        self,
        source_path: str,
        destination_path: str,
        metadata: Dict[str, Any],
        account: Account,
        on_progress: Optional["Callable[[int, int], None]"] = None,
    ) -> None:
        src = Path(source_path)
        dst = Path(destination_path)
        dst.parent.mkdir(parents=True, exist_ok=True)

        with src.open("rb") as src_fd, dst.open("wb") as dst_fd:
            with ZipFile(src_fd) as src_zip, ZipFile(dst_fd, "w") as dst_zip:
                self._replicate_zip(src_zip, dst_zip, on_progress=on_progress)
                self._write_metadata(dst_zip, metadata, account)

    def _replicate_zip(
        self,
        src_zip: ZipFile,
        dst_zip: ZipFile,
        on_progress: Optional["Callable[[int, int], None]"] = None,
    ) -> None:
        entries = src_zip.infolist()
        total = len(entries)
        for index, info in enumerate(entries):
            data = src_zip.read(info.filename)
            new_info = ZipInfo(filename=info.filename)
            new_info.compress_type = info.compress_type
            new_info.external_attr = info.external_attr
            new_info.date_time = info.date_time
            dst_zip.writestr(new_info, data)
            if on_progress:
                on_progress(index + 1, total)

    def _write_metadata(self, zip_file: ZipFile, metadata: Dict[str, Any], account: Account) -> None:
        metadata = dict(metadata)
        metadata["apple-id"] = account.email
        metadata["userName"] = account.email
        data = plistlib.dumps(metadata, fmt=plistlib.FMT_BINARY)
        info = ZipInfo("iTunesMetadata.plist")
        info.compress_type = ZIP_DEFLATED
        zip_file.writestr(info, data)

    def _read_manifest_plist(self, zip_file: ZipFile) -> Optional[Dict[str, Any]]:
        for info in zip_file.infolist():
            if info.filename.endswith(".app/SC_Info/Manifest.plist"):
                with zip_file.open(info.filename) as fh:
                    return plistlib.loads(fh.read())
        return None

    def _read_info_plist(self, zip_file: ZipFile) -> Optional[Dict[str, Any]]:
        for info in zip_file.infolist():
            if info.filename.endswith(".app/Info.plist") and "/Watch/" not in info.filename:
                with zip_file.open(info.filename) as fh:
                    return plistlib.loads(fh.read())
        return None

    def _read_bundle_name(self, zip_file: ZipFile) -> str:
        for info in zip_file.infolist():
            if info.filename.endswith(".app/Info.plist") and "/Watch/" not in info.filename:
                path = Path(info.filename)
                return path.parent.name
        raise AppStoreError("could not determine bundle name")

    def _replicate_sinf_from_manifest(
        self,
        zip_file: ZipFile,
        manifest: Dict[str, Any],
        sinfs: List[Sinf],
        bundle_name: str,
    ) -> None:
        paths = manifest.get("SinfPaths", [])
        for sinf_data, relative_path in zip(sinfs, paths):
            # bundle_name already ends in ".app" (it's the .app folder's own
            # name, from _read_bundle_name's path.parent.name) - appending
            # ".app" again here produced "X.app.app", putting the SINF in a
            # directory that doesn't exist in the actual package.
            full_path = f"Payload/{bundle_name}/{relative_path}"
            info = ZipInfo(full_path)
            info.compress_type = ZIP_DEFLATED
            zip_file.writestr(info, sinf_data.data)

    def _replicate_sinf_from_info(
        self,
        zip_file: ZipFile,
        info_plist: Dict[str, Any],
        sinfs: List[Sinf],
        bundle_name: str,
    ) -> None:
        if not sinfs:
            raise AppStoreError("missing sinf payloads")
        executable = info_plist.get("CFBundleExecutable")
        if not executable:
            raise AppStoreError("missing CFBundleExecutable")
        # See the note in _replicate_sinf_from_manifest: bundle_name already
        # includes ".app", so this must not append it again.
        full_path = f"Payload/{bundle_name}/SC_Info/{executable}.sinf"
        info = ZipInfo(full_path)
        info.compress_type = ZIP_DEFLATED
        zip_file.writestr(info, sinfs[0].data)
