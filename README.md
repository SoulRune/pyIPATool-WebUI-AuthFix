# IPATool WebUI Python

A feature-first web interface for interacting with the Apple App Store IPA files: search apps with configurable result limits (including tvOS), view versions and metadata, acquire free app licenses automatically, and download IPA files (including older and tvOS releases) with optional automatic license purchase. Supports Apple ID sign‑in with two‑factor authentication and exposes a REST API for programmatic use. Implemented as a clean, responsive frontend served by a Python Flask backend.

## Features

- **Authentication**: Sign in with your Apple ID (supports two-factor authentication)
- **App Search**: Search the App Store with customizable result limits including tvOS apps
- **License Management**: Acquire free app licenses automatically
- **Version Control**: List all available versions of an app
- **Metadata Access**: View version-specific metadata (display version, release date)
- **IPA Downloads**: Download IPA files with optional automatic license purchasing
- **Modern UI**: Clean, responsive interface for simple usage

<img width="2018" height="4448" alt="image" src="https://github.com/user-attachments/assets/ec40a529-51bb-4032-9ec5-6bce70532a71" />

<img width="1931" height="1145" alt="image" src="https://github.com/user-attachments/assets/362fdf7c-57df-435e-a386-78929d833e27" />

## Prerequisites

- Python 3.8 or higher
- An Apple ID account
- Internet connection

## Installation

1. **Clone or download this repository**

2. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

## Usage

### Starting the Server

Run the Flask application:

```bash
python app.py
```

The web interface will be available at `http://127.0.0.1:5002`

### Legacy / old-browser mode

For very old browsers that can't run modern JS/CSS — the target case is Mobile
Safari on iOS 6 — start the server with `--legacy`:

```bash
python app.py --legacy
```

This serves an ES5-only `legacy.js` (no arrow functions, `fetch`, `async`/
`await`, optional chaining, `Promise`, or `classList` reliance — uses `XMLHttpRequest`
and manual `style.display`/`visibility` toggling instead) and a `legacy.css`
that avoids CSS custom properties, CSS Grid, and modern Flexbox/`backdrop-filter`
in favor of float/inline-block layout and `-webkit-`-prefixed gradients,
transitions, and animations. Same server, same REST API, same HTML template
and element IDs as the modern UI — no functionality is dropped, and the visual
design is kept as close to the modern look as old WebKit allows.

Other flags:

```bash
python app.py --host 0.0.0.0 --port 5002 --debug
```

### Running as a background service

If the server needs to survive the terminal session that started it (e.g.
running it directly on a jailbroken iOS device, where the terminal app can
get killed on screen lock/app switch and takes its child processes with it),
there are three options, roughly in order of how much setup they need.

**`serverctl.py`** - the easiest option, a small cross-platform wrapper
around `--daemon` below. By default it's equivalent to
`python app.py --daemon --pid-file ipatool-webui.pid --log-file ipatool-webui.log`:

```bash
python serverctl.py                      # start (add --legacy / --debug as needed)
python serverctl.py --kill-server         # stop it
```

On POSIX it just drives `app.py --daemon` (see below). On Windows, since
double-fork daemonizing doesn't exist there, it instead launches `app.py`
directly as a detached process (`CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS`)
and manages the PID file/log redirection itself. Refuses to start a second
copy if one's already running (per the PID file), and `--kill-server` cleans
up a stale PID file gracefully if the process is already gone.

**`--daemon`** - a plain double-fork daemonize, implemented with nothing but
the Python stdlib `os` module (this is literally what `nohup`/`setsid` do
internally), so it works even where those binaries aren't installed:

```bash
python app.py --legacy --daemon --pid-file ipatool-webui.pid --log-file ipatool-webui.log
```

The command returns immediately; the server keeps running detached from the
terminal entirely (not just SIGHUP-immune - it has no controlling terminal at
all, so closing/killing the terminal app can't touch it). Check on it with:

```bash
ps -p $(cat ipatool-webui.pid)   # is it still running?
tail -f ipatool-webui.log        # what's it doing? (stdout/stderr go here)
kill $(cat ipatool-webui.pid)    # stop it
```

Note `--daemon` only detaches the process - it doesn't restart it if it
crashes, and it won't survive a reboot on its own.

**launchd** - the actual OS-native service manager on iOS/macOS, if you want
auto-restart-on-crash and start-on-boot. See `scripts/com.ipatool.webui.plist`
for a template; fill in the paths for your setup (the `python3` inside your
venv - find it with `which python3` while the venv is active - and the repo's
working directory), then:

```bash
# copy it into place (needs root)
cp scripts/com.ipatool.webui.plist /Library/LaunchDaemons/
chown root:wheel /Library/LaunchDaemons/com.ipatool.webui.plist
chmod 644 /Library/LaunchDaemons/com.ipatool.webui.plist

# load it (older launchctl syntax; some setups may need
# `launchctl bootstrap system /Library/LaunchDaemons/com.ipatool.webui.plist` instead)
launchctl load /Library/LaunchDaemons/com.ipatool.webui.plist

# stop/unload later with:
launchctl unload /Library/LaunchDaemons/com.ipatool.webui.plist
```

### Authentication

1. Navigate to the web interface
2. Enter your Apple ID email and password
3. Click "Sign In"
4. If two-factor authentication is enabled, a modal will appear:
   - Enter the 6-digit verification code sent to your trusted device
   - Click "Verify"

### Searching for Apps

1. After signing in, the search section will appear
2. Enter a search term
3. Optionally adjust the results limit (1-50) and choose whether to search tvOS apps vs just iOS/iPadOS apps
4. Click "Search"

### Listing App Versions

1. Click on any app in search results, or use Direct Lookup to list versions to a specifc app id and optionally version id (to find related versions)
2. View the latest version and complete version list

### Viewing Version Metadata

1. Click on a version to expand its metadata

### Downloading IPAs

1. In the expanded metadata view, click Download IPA
2. The server downloads it in the background (a job you can poll for real progress) and hands the finished file to your browser as a normal download once ready - no more one giant blocking request with zero feedback

There's also a **💾 Save on server** button next to Download IPA. Instead of sending the finished file to the browser at all, it's left in `~/Downloads/IPATool/` on the machine running the server. Use this if browser downloads aren't landing anywhere usable - this has been observed on old/constrained browsers (Mobile Safari on iOS 6, specifically) that don't reliably save a file even when it's handed off via a normal navigation. If you're running the server directly on the device in question (e.g. via a jailbreak), this sidesteps the browser download path entirely.

### Installing IPAs

- Use a tool like iMazing or 3uTools to "officially" install the ipa. You cannot and do not need to "sideload" these as that tries to sign them and these are already signed as they are from the app store. They can be installed and will not expire.
- Some people have also had success simply Airdropping it from a macOS computer and it will actually install it without any prompt, although I've had inconsistent results.
- Another user also mentioned Sideloadly with Advanced Options > Signing Mode > Normal Install.

## Platform selection (iPhone / iPad / Apple TV)

Search, Direct Lookup, and Download all have a **Platform** selector: iPhone + iPad (default), iPhone only, iPad only, or Apple TV.

Most apps use Apple's Universal Purchase, meaning the iPhone/iPad/tvOS builds all share the *same* App Store listing (App ID) - so the normal search/download calls can't tell platforms apart on their own and default to iOS. Picking **Apple TV** here resolves the latest tvOS-specific version through a separate Apple lookup endpoint (`MZStorePlatform.woa/wa/lookup`, the same one Apple's own MDM/enterprise app deployment tooling uses - and the same mechanism `majd/ipatool`'s `--platform` flag uses under the hood) before loading versions or downloading, so you get the actual tvOS build instead of the iPhone one. The downloaded package is also checked for `AppleTVOS` support in its `Info.plist` as a sanity check.

Caveats:
- This resolves the **latest** tvOS version automatically. Whether *older* tvOS versions show up in the list too depends on how Apple's backend chains version history for that particular app - for some apps it does, for others it may only be the latest.
- If you already have a known tvOS External Version ID (e.g. from iMazing, see below), you can still enter it directly in Direct Lookup - it isn't required anymore, just an alternative.

If the automatic resolution doesn't turn up what you need, iMazing remains a reliable manual fallback:
1. Make sure you have the current version of the app downloaded on your Apple TV.
2. Install **iMazing** on your Mac or PC
3. Follow iMazing's steps for connecting your Mac/PC to the Apple TV.
4. In iMazing, go to **Tools → Manage Apps**.
5. Right‑click (or use the options menu) and select **Export List to CSV**.
6. Open the CSV file. For the app's row:
   - **Store ID** = `AppID` for IPATool  
   - **Version ID** = `External Version ID` for IPATool
7. Use those values to do a Direct Lookup (with Platform set to Apple TV)
8. Choose the version you want and download it

## Storage Locations

The application stores data in `~/.ipatool/`:
- `keychain.json` - Account credentials
- `cookies.lwp` - Session cookies
- `ca-bundle.pem` - Optional custom CA certificate

## API Endpoints

The application provides a REST API for programmatic access:

### Authentication
- `POST /api/auth/login` - Sign in with Apple ID
- `POST /api/auth/logout` - Sign out
- `GET /api/account` - Get current account info

### App Operations
- `GET /api/search` - Search for apps
- `POST /api/purchase` - Acquire app license
- `POST /api/download` - Download IPA file
- `GET /api/versions` - List app versions
- `GET /api/version-metadata` - Get version metadata

## Security Notes

- Credentials are stored locally in `~/.ipatool/keychain.json`
- Session cookies are persisted in `~/.ipatool/cookies.lwp`
- The application uses password tokens for App Store authentication
- Two-factor authentication is fully supported

## Optional Configuration

### SSL/TLS Verification

The application supports custom SSL certificates:

- **Disable SSL verification** (not recommended):
  ```bash
  export IPATOOL_SSL_NO_VERIFY=1
  ```

- **Use custom CA bundle**:
  ```bash
  export IPATOOL_CA_BUNDLE=/path/to/ca-bundle.pem
  ```

- **Default CA bundle location**:
  Place your certificate at `~/.ipatool/ca-bundle.pem`
  

## Troubleshooting

### "Password token expired" error
- Sign out and sign in again to refresh the authentication token

### "License required" error
- A popup will prompt you to aquire the license
- This only works for free apps, if it is a paid app you must buy the app first in the App Store with the same account, then you can see it on here.

### Two-factor authentication not working
- Ensure you're entering the code correctly (spaces are automatically removed)
- Try requesting a new code if the current one expires

### Download fails
- Check that you have sufficient disk space
- Verify the app is available in your account's storefront
- Ensure you have the necessary license for the app

## Architecture

- **Backend**: Flask (Python)
- **Frontend**: Vanilla JavaScript with modern CSS
- **Storage**: File-based keychain and cookie persistence
- **App Store Integration**: Custom Python implementation of IPATool protocol

## Acknowledgments

Based on the [IPATool by Majd](https://github.com/majd/ipatool) for interacting with the Apple App Store.