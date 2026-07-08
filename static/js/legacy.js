(function () {
  var loginForm;
  var logoutButton;
  var accountBox;
  var toast;
  var appFinderSection;
  var versionsSection;
  var authModal;
  var authModalForm;
  var authModalMessage;
  var authModalError;
  var authModalInput;
  var authModalCancel;
  var authCodeMessage;
  var searchForm;
  var directLookupForm;
  var searchResults;
  var versionsList;
  var appTitle;
  var appSubtitle;
  var communityFallbackCheckbox;
  var directCommunityFallbackCheckbox;
  var searchTab;
  var directTab;
  var tabButtons;
  var purchaseModal;
  var purchaseModalForm;
  var purchaseModalCancel;
  var purchaseAppId;
  var purchaseBundleId;
  var downloadProgress;
  var downloadProgressText;
  var downloadProgressFilename;
  var pendingCredentials = null;
  var lastSearchPlatform = '';
  var lastSearchCommunityFallback = false;
  var currentAppId = null;
  var currentBundleId = null;
  var currentPlatform = '';
  var currentExternalVersionId = null;

  function byId(id) {
    return document.getElementById(id);
  }

  function setElementHidden(element, hidden) {
    if (!element) {
      return;
    }
    if ('hidden' in element) {
      element.hidden = hidden;
    } else {
      element.style.display = hidden ? 'none' : '';
    }
    try {
      // Force inline display/visibility and aria-hidden for older browsers or CSS overrides
      element.style.display = hidden ? 'none' : '';
      element.style.visibility = hidden ? 'hidden' : 'visible';
      if (hidden) {
        element.setAttribute('aria-hidden', 'true');
      } else {
        element.removeAttribute('aria-hidden');
      }
    } catch (e) {
      // ignore any style assignment errors on exotic elements
    }
  }

  function showToast(message, isError) {
    if (!toast) {
      return;
    }
    toast.textContent = message || '';
    toast.className = isError ? 'toast error' : 'toast';
    setElementHidden(toast, false);
    window.setTimeout(function () {
      setElementHidden(toast, true);
    }, 3000);
  }

  function serializeForm(form) {
    var result = {};
    if (!form || !form.elements) {
      return result;
    }

    for (var i = 0; i < form.elements.length; i += 1) {
      var element = form.elements[i];
      if (!element.name || element.disabled) {
        continue;
      }
      if ((element.type === 'checkbox' || element.type === 'radio') && !element.checked) {
        continue;
      }
      if (element.type === 'checkbox') {
        result[element.name] = element.checked ? 'on' : '';
      } else {
        result[element.name] = element.value;
      }
    }
    return result;
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function apiUrl(path) {
    var baseUrl = window.APP_BASE_URL || '';
    if (baseUrl === '/') {
      baseUrl = '';
    } else if (baseUrl && baseUrl.charAt(baseUrl.length - 1) === '/') {
      baseUrl = baseUrl.slice(0, -1);
    }
    if (path.charAt(0) !== '/') {
      path = '/' + path;
    }
    return baseUrl + path;
  }

  function updateAccountBox(account) {
    if (!accountBox) {
      return;
    }
    var nodes = accountBox.querySelectorAll('[data-field]');
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var field = node.getAttribute('data-field');
      node.textContent = (account && account[field]) || 'N/A';
    }
  }

  function clearAccountFields() {
    if (!accountBox) {
      return;
    }
    var nodes = accountBox.querySelectorAll('[data-field]');
    for (var i = 0; i < nodes.length; i += 1) {
      nodes[i].textContent = 'N/A';
    }
  }

  function setLoggedIn(isLoggedIn) {
    if (loginForm) {
      setElementHidden(loginForm, isLoggedIn);
    }
    if (logoutButton) {
      setElementHidden(logoutButton, !isLoggedIn);
    }
    if (accountBox) {
      setElementHidden(accountBox, !isLoggedIn);
    }
    if (appFinderSection) {
      setElementHidden(appFinderSection, !isLoggedIn);
    }
    if (versionsSection) {
      setElementHidden(versionsSection, true);
    }
    if (!isLoggedIn) {
      clearAccountFields();
      if (authCodeMessage) {
        setElementHidden(authCodeMessage, true);
      }
      hidePurchaseModal();
      hideDownloadProgress();
    }
  }

  function showAuthModal(message) {
    if (!authModal) {
      return;
    }
    if (authModalMessage) {
      authModalMessage.textContent = message || 'Enter the verification code to continue.';
    }
    if (authModalError) {
      authModalError.textContent = '';
      setElementHidden(authModalError, true);
    }
    if (authModalInput) {
      authModalInput.value = '';
      try {
        authModalInput.focus();
      } catch (e) {
        // ignore focus issues on old devices
      }
    }
    setElementHidden(authModal, false);
  }

  function hideAuthModal() {
    setElementHidden(authModal, true);
  }

  function showPurchaseModal(appId, bundleId) {
    if (!purchaseModal) {
      return;
    }
    if (purchaseAppId) {
      purchaseAppId.value = appId || '';
    }
    if (purchaseBundleId) {
      purchaseBundleId.value = bundleId || '';
    }
    setElementHidden(purchaseModal, false);
  }

  function hidePurchaseModal() {
    setElementHidden(purchaseModal, true);
  }

  function showDownloadProgress(message, filename) {
    if (!downloadProgress) {
      return;
    }
    if (downloadProgressText) {
      downloadProgressText.textContent = message || 'Downloading...';
    }
    if (downloadProgressFilename) {
      downloadProgressFilename.textContent = filename || '';
      setElementHidden(downloadProgressFilename, !filename);
    }
    setElementHidden(downloadProgress, false);
  }

  function updateDownloadProgress(message, filename) {
    if (downloadProgressText) {
      downloadProgressText.textContent = message || 'Downloading...';
    }
    if (downloadProgressFilename) {
      downloadProgressFilename.textContent = filename || '';
      setElementHidden(downloadProgressFilename, !filename);
    }
  }

  function hideDownloadProgress() {
    setElementHidden(downloadProgress, true);
  }

  function copyTextToClipboard(text) {
    if (!text) {
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        showToast('Copied: ' + text);
      }, function () {
        showToast('Failed to copy', true);
      });
      return;
    }

    var textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand('copy');
      showToast('Copied: ' + text);
    } catch (e) {
      showToast('Failed to copy', true);
    } finally {
      document.body.removeChild(textArea);
    }
  }

  function sendRequest(method, url, payload, callback) {
    var xhr = new XMLHttpRequest();
    if (!xhr) {
      callback({ status: 0, body: null });
      return;
    }

    xhr.open(method, url, true);
    if (payload !== null) {
      xhr.setRequestHeader('Content-Type', 'application/json');
    }
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) {
        return;
      }
      var body = null;
      try {
        body = parseJson(xhr.responseText);
      } catch (e) {
        body = null;
      }
      callback({ status: xhr.status, body: body });
    };
    if (payload === null) {
      xhr.send(null);
    } else {
      xhr.send(JSON.stringify(payload));
    }
  }

  function handleLoginFormSubmit(event) {
    if (event && event.preventDefault) {
      event.preventDefault();
    }
    if (!loginForm) {
      return false;
    }

    var entries = serializeForm(loginForm);
    pendingCredentials = {
      email: entries.email || '',
      password: entries.password || ''
    };
    performLogin(pendingCredentials);
    return false;
  }

  function performLogin(credentials) {
    var payload = {
      email: credentials.email || '',
      password: credentials.password || ''
    };

    if (credentials.authCode) {
      payload.authCode = String(credentials.authCode).replace(/\s+/g, '');
    }

    sendRequest('POST', apiUrl('/api/auth/login'), payload, function (response) {
      var result = response.body || {};

      if (response.status === 401 && result.authCodeRequired) {
        pendingCredentials = {
          email: credentials.email || '',
          password: credentials.password || ''
        };
        showAuthModal(result.error || 'Verification code required');
        return;
      }

      if (response.status >= 200 && response.status < 300 && result.account) {
        pendingCredentials = null;
        hideAuthModal();
        if (loginForm) {
          loginForm.reset();
        }
        updateAccountBox(result.account);
        setLoggedIn(true);
        showToast('Signed in successfully');
        return;
      }

      if (credentials.authCode) {
        pendingCredentials = {
          email: credentials.email || '',
          password: credentials.password || ''
        };
      } else {
        pendingCredentials = null;
      }
      showToast((result && result.error) ? result.error : 'Login failed', true);
    });
  }

  function handleAuthModalSubmit(event) {
    if (event && event.preventDefault) {
      event.preventDefault();
    }

    if (!pendingCredentials) {
      showToast('Please start the sign-in flow again', true);
      hideAuthModal();
      return false;
    }

    var code = authModalInput && authModalInput.value ? authModalInput.value.trim() : '';
    if (!code) {
      if (authModalError) {
        authModalError.textContent = 'Enter the verification code to continue.';
        setElementHidden(authModalError, false);
      }
      return false;
    }

    pendingCredentials.authCode = code;
    hideAuthModal();
    performLogin(pendingCredentials);
    return false;
  }

  function handleLogout() {
    sendRequest('POST', apiUrl('/api/auth/logout'), {}, function () {
      showToast('Signed out');
      setLoggedIn(false);
    });
  }

  function refreshAccountState() {
    sendRequest('GET', apiUrl('/api/account'), null, function (response) {
      if (response.status >= 200 && response.status < 300 && response.body && response.body.account) {
        updateAccountBox(response.body.account);
        setLoggedIn(true);
        return;
      }
      setLoggedIn(false);
    });
  }

  function switchTab(tabName) {
    // Only touch buttons that declare a data-tab attribute so we don't wipe
    // unrelated button classes (e.g. .secondary). Use querySelectorAll when
    // available; otherwise fall back to filtering the global button list.
    var tabs = null;
    if (document.querySelectorAll) {
      tabs = document.querySelectorAll('button[data-tab]');
    } else if (tabButtons) {
      var tmp = [];
      for (var k = 0; k < tabButtons.length; k += 1) {
        try {
          if (tabButtons[k] && tabButtons[k].getAttribute && tabButtons[k].getAttribute('data-tab')) {
            tmp.push(tabButtons[k]);
          }
        } catch (err) {}
      }
      tabs = tmp;
    }
    if (!tabs) {
      return;
    }

    for (var i = 0; i < tabs.length; i += 1) {
      var button = tabs[i];
      var isActive = button.getAttribute && (button.getAttribute('data-tab') === tabName);
      try {
        if (button.classList) {
          if (isActive) button.classList.add('active'); else button.classList.remove('active');
        } else {
          // preserve existing classes while toggling 'active'
          var cls = (button.className || '').split(/\s+/).filter(function (c) { return c && c !== 'active'; });
          if (isActive) cls.push('active');
          button.className = cls.join(' ');
        }
      } catch (err) {
        // ignore class toggling errors
      }
    }

    if (searchTab && directTab) {
      if (tabName === 'direct') {
        setElementHidden(searchTab, true);
        setElementHidden(directTab, false);
        // Ensure CSS active class matches for older browsers
        try { searchTab.className = 'tab-content'; } catch (e) {}
        try { directTab.className = 'tab-content active'; } catch (e) {}
      } else {
        setElementHidden(searchTab, false);
        setElementHidden(directTab, true);
        try { searchTab.className = 'tab-content active'; } catch (e) {}
        try { directTab.className = 'tab-content'; } catch (e) {}
      }
    }

    if (versionsSection) {
      setElementHidden(versionsSection, true);
    }
    if (searchResults) {
      setElementHidden(searchResults, true);
    }
  }

  function renderSearchResults(results) {
    if (!searchResults) {
      return;
    }

    if (!results || results.length === 0) {
      searchResults.innerHTML = '<div class="empty-state"><p>No apps found</p></div>';
      setElementHidden(searchResults, false);
      return;
    }

    var html = [];
    for (var i = 0; i < results.length; i += 1) {
      var app = results[i];
      var priceText = app && app.price && app.price > 0 ? '$' + app.price : 'Free';
      html.push('<div class="app-card" data-app-id="' + (app.trackId || '') + '" data-bundle-id="' + (app.bundleId || '') + '"><div class="app-card-header"><div><h3>' + (app.trackName || 'Unknown') + '</h3><p>' + (app.bundleId || 'N/A') + '</p><p>v' + (app.version || 'N/A') + ' · ' + priceText + '</p><div style="margin-top:0.5rem;"><span class="copy-code" data-copy="' + (app.trackId || '') + '" title="Click to copy App ID"><span>🆔</span> <span>' + (app.trackId || '') + '</span></span></div></div></div></div>');
    }
    searchResults.innerHTML = html.join('');

    var cards = searchResults.getElementsByTagName('div');
    for (var j = 0; j < cards.length; j += 1) {
      var card = cards[j];
      var className = card.className || '';
      if ((' ' + className + ' ').indexOf(' app-card ') === -1) {
        continue;
      }
      card.onclick = function (event) {
        if (event && event.target && event.target.className && event.target.className.indexOf('copy-code') !== -1) {
          return false;
        }
        var appId = this.getAttribute('data-app-id');
        var bundleId = this.getAttribute('data-bundle-id');
        loadAppVersions(appId, bundleId, null, lastSearchPlatform, lastSearchCommunityFallback);
        return false;
      };
    }

    setElementHidden(searchResults, false);
  }

  function runSearch() {
    if (!searchForm) {
      return;
    }

    var formData = serializeForm(searchForm);
    if (!formData.term) {
      showToast('Please enter a search term', true);
      return;
    }

    var params = [];
    params.push('term=' + encodeURIComponent(formData.term));
    if (formData.limit) {
      params.push('limit=' + encodeURIComponent(formData.limit));
    }
    lastSearchPlatform = formData.platform || '';
    if (lastSearchPlatform) {
      params.push('platform=' + encodeURIComponent(lastSearchPlatform));
    }
    lastSearchCommunityFallback = formData.communityFallback === 'on';

    showToast('Searching...');
    sendRequest('GET', apiUrl('/api/search') + '?' + params.join('&'), null, function (response) {
      if (response.status < 200 || response.status >= 300 || !response.body) {
        showToast('Search failed', true);
        return;
      }
      renderSearchResults(response.body.results || []);
    });
  }

  function loadAppVersions(appId, bundleId, externalVersionId, platform, communityFallback) {
    currentAppId = appId || null;
    currentBundleId = bundleId || null;
    currentExternalVersionId = externalVersionId || null;
    currentPlatform = platform || '';

    if (!versionsSection || !versionsList) {
      return;
    }

    var communityFallbackEnabled = !!communityFallback;

    if (appTitle) {
      appTitle.textContent = 'Loading...';
    }
    if (appSubtitle) {
      appSubtitle.textContent = '';
    }
    versionsList.innerHTML = '<div style="text-align:center;padding:2rem;"><div class="loading"></div><div class="hint" style="margin-top:1rem;">Loading versions...</div></div>';
    setElementHidden(versionsSection, false);

    var params = [];
    if (currentAppId) {
      params.push('appId=' + encodeURIComponent(currentAppId));
    }
    if (currentBundleId) {
      params.push('bundleId=' + encodeURIComponent(currentBundleId));
    }
    if (currentExternalVersionId) {
      params.push('externalVersionId=' + encodeURIComponent(currentExternalVersionId));
    }
    if (currentPlatform) {
      params.push('platform=' + encodeURIComponent(currentPlatform));
    }

    var url = apiUrl('/api/versions');
    if (params.length > 0) {
      url += '?' + params.join('&');
    }

    sendRequest('GET', url, null, function (response) {
      if (response.status >= 400 || !response.body) {
        var body = response.body || {};
        var errorText = body.error || 'Unable to load versions';
        var metadata = body.metadata || {};

        // Genuine "you don't own this yet" - always the normal license
        // flow, regardless of the community-fallback toggle. Falling back
        // to Timbrd here would just paper over a license Apple is telling
        // us outright is missing.
        var isLicenseError = body.licenseRequired || (body.error && body.error.toLowerCase().indexOf('license') !== -1) || metadata.failureType === '9610';
        if (isLicenseError) {
          if (purchaseModal) {
            showPurchaseModal(currentAppId, currentBundleId);
            versionsList.innerHTML = '<div class="empty-state"><p>A license is required to view versions for this app.</p></div>';
          } else if (window.confirm('A license is required to view versions for this app. Would you like to acquire it now?')) {
            acquireLicenseAndRetry(currentAppId, currentBundleId, currentExternalVersionId, currentPlatform);
          } else {
            versionsList.innerHTML = '<div class="empty-state"><p>License required</p></div>';
          }
          return;
        }

        // The Chrome-style "5002 / m-allowed:false" signature: Apple's
        // generic refusal that isn't really about licensing (can persist
        // even after a successful purchase). Only worth trying Timbrd for
        // this specific, confirmed pattern.
        if (communityFallbackEnabled && metadata.failureType === '5002' && metadata['m-allowed'] === false) {
          showToast('Apple refused this app (not a licensing issue) - trying the community database instead...');
          loadAppVersionsFromCommunity(currentAppId, currentBundleId);
          return;
        }

        showToast(errorText, true);
        versionsList.innerHTML = '<div class="empty-state"><p>' + errorText + '</p></div>';
        return;
      }

      var identifiers = response.body.externalVersionIdentifiers || [];
      var latest = response.body.latestExternalVersionId || '';
      if (!identifiers.length) {
        versionsList.innerHTML = '<div class="empty-state"><p>No versions found</p></div>';
        return;
      }

      // Apply client-side external version filter if provided (backend may ignore it)
      if (currentExternalVersionId) {
        var filtered = [];
        for (var k = 0; k < identifiers.length; k += 1) {
          if (String(identifiers[k]) === String(currentExternalVersionId)) {
            filtered.push(identifiers[k]);
          }
        }
        identifiers = filtered;
        if (!identifiers.length) {
          versionsList.innerHTML = '<div class="empty-state"><p>No versions match the provided Version ID</p></div>';
          return;
        }
      }

      loadAndRenderVersionMetadata(identifiers, latest);
    });
  }

  function loadAndRenderVersionMetadata(identifiers, latest) {
    var versionCount = identifiers.length;
    var loaded = 0;
    // Index-keyed slots (not push-on-completion) keep render order equal to the
    // original `identifiers` order regardless of which XHR resolves first.
    // Pushing on completion made versions appear in whatever order the network
    // happened to return them, not their real numbering order.
    var versionSlots = new Array(versionCount);

    function finish() {
      if (loaded < versionCount) {
        return;
      }

      var versions = [];
      for (var i = 0; i < versionSlots.length; i += 1) {
        if (versionSlots[i]) {
          versions.push(versionSlots[i]);
        }
      }

      if (versions.length === 0) {
        versionsList.innerHTML = '<div class="empty-state"><p>No versions found</p></div>';
        return;
      }

      if (appTitle) {
        appTitle.textContent = versions[0].itemName || 'App Versions';
      }
      if (appSubtitle) {
        appSubtitle.textContent = (versions[0].bundleId || currentBundleId || currentAppId || 'Versions') + ' • ' + versions.length + ' version' + (versions.length === 1 ? '' : 's');
      }

      renderVersionCards(versions, latest);
    }

    function fetchMetadataForVersion(versionId, index) {
      var params = [];
      if (currentAppId) {
        params.push('appId=' + encodeURIComponent(currentAppId));
      }
      if (currentBundleId) {
        params.push('bundleId=' + encodeURIComponent(currentBundleId));
      }
      params.push('versionId=' + encodeURIComponent(versionId));

      var metadataUrl = apiUrl('/api/version-metadata') + '?' + params.join('&');
      sendRequest('GET', metadataUrl, null, function (response) {
        loaded += 1;
        if (response.status >= 200 && response.status < 300 && response.body) {
          var metadata = response.body;
          if (!metadata.versionId) {
            metadata.versionId = versionId;
          }
          versionSlots[index] = metadata;
        }
        finish();
      });
    }

    for (var i = 0; i < identifiers.length; i += 1) {
      fetchMetadataForVersion(identifiers[i], i);
    }
  }

  function formatLegacyReleaseDisplay(display, raw) {
    // Manually parse "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS[.sss]" (optionally
    // with a trailing Z/offset, which we ignore) into numeric components and
    // build the Date via Date.UTC(...) instead of new Date(string). Old
    // WebKit (iOS 6) is unreliable parsing ISO strings that omit a timezone
    // designator - new Date("2013-05-01T00:00:00") often comes back as
    // Invalid Date there, even though the exact same string parses fine in
    // modern engines. That mismatch is why release dates showed "Unknown"
    // for every single version here while the modern UI (running in a
    // current browser) displayed them fine.
    function parseDate(value) {
      if (!value) {
        return null;
      }
      var m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?/);
      if (!m) {
        return null;
      }
      var year = parseInt(m[1], 10);
      var month = parseInt(m[2], 10) - 1;
      var day = parseInt(m[3], 10);
      var hour = m[4] ? parseInt(m[4], 10) : 0;
      var minute = m[5] ? parseInt(m[5], 10) : 0;
      var second = m[6] ? parseInt(m[6], 10) : 0;
      var utcMillis = Date.UTC(year, month, day, hour, minute, second);
      if (isNaN(utcMillis)) {
        return null;
      }
      return new Date(utcMillis);
    }

    if (display) {
      var m = display.match(/\((\d{4}-\d{2}-\d{2})\)$/);
      if (m && m[1]) {
        var d = parseDate(m[1]);
        if (d) {
          return display.replace(m[1], d.toLocaleDateString());
        }
      }
      if (/^\d{4}-\d{2}-\d{2}/.test(display)) {
        var d2 = parseDate(display);
        return d2 ? d2.toLocaleDateString() : display;
      }
      return display;
    }
    if (raw) {
      var dr = parseDate(raw);
      return dr ? dr.toLocaleDateString() : 'Unknown';
    }
    return 'Unknown';
  }

  function renderVersionCards(versions, latest) {
    var html = [];
    for (var i = 0; i < versions.length; i += 1) {
      var version = versions[i];
      var versionId = version.versionId || '';
      var releaseDate = formatLegacyReleaseDisplay(version.releaseDateDisplay, version.releaseDate);
      var fileSizeMB = 'Unknown';
      if (version.fileSize) {
        fileSizeMB = (version.fileSize / (1024 * 1024)).toFixed(2) + ' MB';
      }
      var isLatest = latest && versionId === latest;
      html.push('<div class="version-card' + (isLatest ? ' latest' : '') + '" data-version-id="' + versionId + '"><div class="version-header"><div class="version-basic"><div><strong>Version:</strong> ' + (version.displayVersion || 'N/A') + '</div><div><strong>Build:</strong> ' + (version.buildNumber || 'N/A') + '</div><div><strong>Size:</strong> ' + fileSizeMB + '</div><div><strong>Released:</strong> ' + releaseDate + '</div></div><span class="expand-icon">▼</span></div><div class="version-details"><dl><dt>Version ID:</dt><dd><span class="copy-code" data-copy="' + versionId + '" title="Click to copy Version ID">' + (versionId || 'N/A') + '</span></dd><dt>Bundle ID:</dt><dd>' + (version.bundleId || 'N/A') + '</dd><dt>Developer:</dt><dd>' + (version.artistName || 'N/A') + '</dd><dt>Genre:</dt><dd>' + (version.genre || 'N/A') + '</dd><dt>Age Rating:</dt><dd>' + (version.ageRating || 'N/A') + '</dd><dt>Copyright:</dt><dd>' + (version.copyright || 'N/A') + '</dd></dl><div class="version-actions"><button type="button" class="download-version-btn" data-version-id="' + versionId + '">Download IPA</button> <button type="button" class="save-server-btn secondary" data-version-id="' + versionId + '" title="Save directly on the machine running the server, skip the browser download entirely">💾 Save on server</button></div></div></div>');
    }
    versionsList.innerHTML = html.join('');
  }

  function toggleLegacyVersionCard(card) {
    if (!card) {
      return;
    }
    if (card.className.indexOf('expanded') === -1) {
      card.className = card.className + ' expanded';
    } else {
      card.className = card.className.replace(' expanded', '');
    }
  }

  function loadAppVersionsFromCommunity(appId, bundleId) {
    var params = [];
    if (appId) {
      params.push('appId=' + encodeURIComponent(appId));
    }
    if (bundleId) {
      params.push('bundleId=' + encodeURIComponent(bundleId));
    }

    if (appTitle) {
      appTitle.textContent = 'Loading...';
    }
    if (appSubtitle) {
      appSubtitle.textContent = '';
    }
    versionsList.innerHTML = '<div style="text-align:center;padding:2rem;"><div class="loading"></div><div class="hint" style="margin-top:1rem;">Loading community versions...</div></div>';
    setElementHidden(versionsSection, false);

    var url = apiUrl('/api/versions/community');
    if (params.length > 0) {
      url += '?' + params.join('&');
    }

    sendRequest('GET', url, null, function (response) {
      if (response.status >= 400 || !response.body) {
        var body = response.body || {};
        var errorText = body.error || 'Failed to load community versions';
        showToast(errorText, true);
        versionsList.innerHTML = '<div class="empty-state"><p>' + errorText + '</p></div>';
        return;
      }

      var entries = response.body.entries || [];
      if (appTitle) {
        appTitle.textContent = 'App Versions';
      }
      if (appSubtitle) {
        appSubtitle.textContent = 'Community database (Timbrd) \u2022 ' + entries.length + ' version' + (entries.length === 1 ? '' : 's');
      }
      renderCommunityVersions(entries);
    });
  }

  function renderCommunityVersions(entries) {
    if (!entries || entries.length === 0) {
      versionsList.innerHTML = '<div class="empty-state"><p>No versions found in the community database</p></div>';
      return;
    }

    var bundleIdText = currentBundleId || 'N/A';
    var html = [];
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      var sizeText = entry.size ? (entry.size / (1024 * 1024)).toFixed(2) + ' MB' : 'Unknown';
      var dateText = entry.createdAt || 'Unknown';
      var vid = entry.externalVersionId || '';
      html.push('<div class="version-card" data-version-id="' + vid + '"><div class="version-header"><div class="version-basic"><div><strong>Version:</strong> ' + (entry.bundleVersion || 'unknown') + '</div><div><strong>Build:</strong> N/A</div><div><strong>Size:</strong> ' + sizeText + '</div><div><strong>Seen:</strong> ' + dateText + '</div></div><span class="expand-icon">\u25BC</span></div><div class="version-details"><dl><dt>Version ID:</dt><dd><span class="copy-code" data-copy="' + vid + '" title="Click to copy Version ID">' + vid + '</span></dd><dt>Bundle ID:</dt><dd>' + bundleIdText + '</dd><dt>Source:</dt><dd>Community database (Timbrd) - not run or endorsed by Apple</dd></dl><div class="version-actions"><button type="button" class="download-version-btn" data-version-id="' + vid + '">Download IPA</button> <button type="button" class="save-server-btn secondary" data-version-id="' + vid + '" title="Save directly on the machine running the server, skip the browser download entirely">\uD83D\uDCBE Save on server</button></div></div></div>');
    }
    versionsList.innerHTML = html.join('');
  }

  function copyLegacyText(text) {
    copyTextToClipboard(text);
  }

  function downloadLegacyVersion(button) {
    if (!button) {
      return;
    }
    var versionId = button.getAttribute('data-version-id');
    if (versionId) {
      downloadVersion(versionId, false);
    }
  }

  function acquireLicenseAndRetry(appId, bundleId, externalVersionId, platform) {
    var payload = {};
    if (appId) {
      payload.appId = appId;
    }
    if (bundleId) {
      payload.bundleId = bundleId;
    }

    showToast('Acquiring license...');
    sendRequest('POST', apiUrl('/api/purchase'), payload, function (response) {
      if (response.status >= 200 && response.status < 300) {
        showToast('License acquired successfully');
        loadAppVersions(appId, bundleId, externalVersionId, platform);
        return;
      }
      var errorMessage = 'Failed to acquire license';
      if (response.body && response.body.error) {
        errorMessage = response.body.error;
      }
      showToast(errorMessage, true);
    });
  }

  // Old approach used xhr.responseType = 'blob' to receive the finished IPA
  // in one giant request. Mobile Safari on iOS 6 has no XHR2 blob support at
  // all (added in iOS 7), so that request either silently failed to produce
  // usable data or sat there buffering a huge binary payload as text/UTF-16
  // until the tab ran out of memory - from the user's side this looked like
  // "Preparing download..." forever, with the actual download never
  // starting. It also meant the entire multi-minute Apple-side download+zip
  // patch had to finish inside one open connection before any bytes came
  // back at all, with zero progress feedback in the meantime - true for
  // *any* browser, not just old ones.
  //
  // Now: POST starts a background job on the server and returns immediately;
  // we poll its real byte progress with ordinary text XHR (sendRequest, no
  // blob involved), and once the file is ready we hand the actual bytes off
  // to the browser via a hidden iframe pointed at a plain GET url - which is
  // just a normal file download/navigation any browser (including iOS 6
  // Safari) already knows how to do natively, no JS-side binary handling
  // required.
  var DOWNLOAD_POLL_INTERVAL_MS = 1500;

  function formatBytes(n) {
    if (!n && n !== 0) {
      return '';
    }
    var mb = n / (1024 * 1024);
    return mb >= 1 ? mb.toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB';
  }

  function fetchFileViaHiddenIframe(url) {
    var iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = url;
    document.body.appendChild(iframe);
    // Leave it in the DOM for a while in case the browser needs it to finish
    // streaming the response; then quietly remove it.
    setTimeout(function () {
      if (iframe.parentNode) {
        iframe.parentNode.removeChild(iframe);
      }
    }, 60000);
  }

  // Some WebKit-based iOS browsers (observed: Orion, likely due to its
  // built-in tracker/ad blocking flagging the hidden-iframe navigation
  // pattern above as suspicious) fail to actually save the file even though
  // the request succeeds - Safari handles the same trick fine. A real,
  // visible link the user taps themselves is a much more reliable fallback,
  // since genuine user-initiated navigation isn't what those blockers
  // target.
  function showManualDownloadLink(url, filename) {
    var existing = byId('manual-download-banner');
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }

    var banner = document.createElement('div');
    banner.id = 'manual-download-banner';
    // Deliberately avoids calc() and CSS transforms - neither is supported
    // on iOS 6 Safari (calc() landed in iOS 7, and fixed-position elements
    // combined with transforms render unpredictably on old WebKit). Uses
    // the same fixed-width + negative-margin-left centering trick already
    // proven working for #toast on this exact browser instead.
    banner.style.cssText = 'position:fixed;bottom:20px;left:50%;margin-left:-150px;width:300px;background:#1e293b;border:1px solid rgba(148,163,184,0.3);border-radius:12px;-webkit-border-radius:12px;padding:0.85rem 1rem;box-shadow:0 10px 30px rgba(0,0,0,0.4);-webkit-box-shadow:0 10px 30px rgba(0,0,0,0.4);z-index:9998;font-size:0.9rem;color:#f8fafc;box-sizing:border-box;-webkit-box-sizing:border-box;';

    var header = document.createElement('div');
    header.style.cssText = 'display:-webkit-box;-webkit-box-align:start;-webkit-box-pack:justify;margin-bottom:0.6rem;';

    var label = document.createElement('div');
    label.style.cssText = 'color:rgba(226,232,240,0.8);line-height:1.3;-webkit-box-flex:1;';
    label.appendChild(document.createTextNode("If the download didn't start automatically:"));

    var closeBtn = document.createElement('button');
    closeBtn.setAttribute('type', 'button');
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.appendChild(document.createTextNode('\u2715'));
    closeBtn.style.cssText = 'width:28px;height:28px;line-height:26px;text-align:center;background:rgba(148,163,184,0.15);border:none;border-radius:50%;-webkit-border-radius:50%;color:rgba(226,232,240,0.8);cursor:pointer;font-size:0.9rem;padding:0;margin-left:0.75rem;';
    closeBtn.onclick = function () {
      if (banner.parentNode) {
        banner.parentNode.removeChild(banner);
      }
    };

    header.appendChild(label);
    header.appendChild(closeBtn);

    var link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    // word-wrap:break-word (not word-break:break-all) - much better old
    // WebKit support for wrapping a long unbreakable filename.
    link.style.cssText = 'display:block;color:#60a5fa;font-weight:600;text-decoration:none;word-wrap:break-word;line-height:1.4;';
    link.appendChild(document.createTextNode('Tap to download: ' + filename));

    banner.appendChild(header);
    banner.appendChild(link);
    document.body.appendChild(banner);

    // Don't let it linger forever if it's never dismissed manually.
    setTimeout(function () {
      if (banner.parentNode) {
        banner.parentNode.removeChild(banner);
      }
    }, 5 * 60 * 1000);
  }

  function pollDownloadJob(jobId, filename, saveToServerFolder) {
    sendRequest('GET', apiUrl('/api/download-jobs/' + jobId), null, function (response) {
      var job = response.body || {};

      if (response.status === 404) {
        hideDownloadProgress();
        showToast('Download failed', true);
        return;
      }

      if (job.status === 'error') {
        hideDownloadProgress();
        showToast(job.error || 'Download failed', true);
        return;
      }

      if (job.filename) {
        filename = job.filename;
      }

      if (job.status === 'ready') {
        if (saveToServerFolder) {
          hideDownloadProgress();
          showToast('Saved on server: ' + (job.serverPath || filename));
          return;
        }
        var fileUrl = apiUrl('/api/download-jobs/' + jobId + '/file');
        updateDownloadProgress('Saving file...', filename);
        fetchFileViaHiddenIframe(fileUrl);
        showManualDownloadLink(fileUrl, filename);
        // The iframe download is fire-and-forget from here (no progress
        // events are available for a plain navigation), so just let the
        // user know it has handed off to the browser.
        setTimeout(function () {
          hideDownloadProgress();
          showToast('Downloading: ' + filename);
        }, 800);
        return;
      }

      if (job.phase === 'patching' || job.phase === 'finalizing') {
        // The raw download already finished (100%); the server is now
        // rewriting the whole package on its own CPU to add metadata and
        // inject the SINF signature. This is genuinely slow for big apps on
        // weak hardware and used to be totally invisible here - it just
        // looked stuck at 100% with no explanation.
        var label = job.phase === 'patching' ? 'Patching package...' : 'Finalizing (adding signature)...';
        if (job.itemsTotal) {
          label += ' ' + job.itemsDone + ' / ' + job.itemsTotal + ' files';
        }
        updateDownloadProgress(label, filename);
      } else if (job.bytesTotal) {
        var percent = Math.floor((job.bytesDone / job.bytesTotal) * 100);
        updateDownloadProgress(percent + '% (' + formatBytes(job.bytesDone) + ' / ' + formatBytes(job.bytesTotal) + ')', filename);
      } else if (job.bytesDone) {
        updateDownloadProgress('Downloading... ' + formatBytes(job.bytesDone), filename);
      } else {
        updateDownloadProgress('Preparing download...', filename);
      }

      setTimeout(function () {
        pollDownloadJob(jobId, filename, saveToServerFolder);
      }, DOWNLOAD_POLL_INTERVAL_MS);
    });
  }

  function startDownloadJob(versionId, purchaseIfNeeded, saveToServerFolder) {
    if (!versionId) {
      return;
    }

    var payload = {
      externalVersionId: versionId
    };
    if (currentAppId) {
      payload.appId = currentAppId;
    }
    if (currentBundleId) {
      payload.bundleId = currentBundleId;
    }
    if (currentPlatform) {
      payload.platform = currentPlatform;
    }
    if (purchaseIfNeeded) {
      payload.purchaseIfNeeded = true;
    }
    if (saveToServerFolder) {
      payload.saveToServerFolder = true;
    }

    showToast(saveToServerFolder ? 'Starting server-side download...' : 'Starting download...');
    showDownloadProgress('Preparing download...');

    sendRequest('POST', apiUrl('/api/download-jobs'), payload, function (response) {
      var body = response.body || {};

      if (response.status < 200 || response.status >= 300 || !body.jobId) {
        var bodyError = body.error || '';
        var isLicenseError = body.licenseRequired || bodyError.toLowerCase().indexOf('license') !== -1 || (body.metadata && body.metadata.failureType === '9610');
        hideDownloadProgress();
        if (isLicenseError) {
          if (purchaseModal) {
            showPurchaseModal(currentAppId, currentBundleId);
          }
          showToast('License required for this download', true);
        } else {
          showToast(bodyError || 'Download failed', true);
        }
        return;
      }

      pollDownloadJob(body.jobId, 'app.ipa', saveToServerFolder);
    });
  }

  function downloadVersion(versionId, purchaseIfNeeded) {
    startDownloadJob(versionId, purchaseIfNeeded, false);
  }

  // Downloads straight to a folder on the machine running the server
  // (~/Downloads/IPATool), never sent over HTTP to the browser at all. For
  // browsers that can't reliably receive a file download - Mobile Safari on
  // iOS 6 appears to be one of these, even with the hidden-iframe handoff
  // used by downloadVersion() above - this is the only download path that
  // actually results in a usable file.
  function downloadVersionToServer(versionId, purchaseIfNeeded) {
    startDownloadJob(versionId, purchaseIfNeeded, true);
  }

  function handleSearchFormSubmit(event) {
    if (event && event.preventDefault) {
      event.preventDefault();
    }
    runSearch();
    return false;
  }

  function handlePurchaseModalSubmit(event) {
    if (event && event.preventDefault) {
      event.preventDefault();
    }

    var formData = serializeForm(purchaseModalForm);
    var appId = formData.appId || currentAppId || '';
    var bundleId = formData.bundleId || currentBundleId || '';

    hidePurchaseModal();
    if (!appId && !bundleId) {
      showToast('Unable to acquire license', true);
      return false;
    }

    acquireLicenseAndRetry(appId, bundleId, currentExternalVersionId, currentPlatform);
    return false;
  }

  function handleDirectLookupSubmit(event) {
    if (event && event.preventDefault) {
      event.preventDefault();
    }

    var formData = serializeForm(directLookupForm);
    if (!formData.appId && !formData.bundleId) {
      showToast('Please provide App ID or Bundle ID', true);
      return false;
    }

    loadAppVersions(formData.appId, formData.bundleId, formData.externalVersionId, formData.platform, formData.communityFallback === 'on');
    return false;
  }

  function attachEvents() {
    if (loginForm) {
      loginForm.onsubmit = function (event) {
        return handleLoginFormSubmit(event);
      };
    }

    if (authModalForm) {
      authModalForm.onsubmit = function (event) {
        return handleAuthModalSubmit(event);
      };
    }

    if (searchForm) {
      searchForm.onsubmit = function (event) {
        return handleSearchFormSubmit(event);
      };
    }

    if (directLookupForm) {
      directLookupForm.onsubmit = function (event) {
        return handleDirectLookupSubmit(event);
      };
    }

    if (logoutButton) {
      logoutButton.onclick = function () {
        handleLogout();
        return false;
      };
    }

    if (authModalCancel) {
      authModalCancel.onclick = function () {
        hideAuthModal();
        pendingCredentials = null;
        return false;
      };
    }

    if (purchaseModalForm) {
      purchaseModalForm.onsubmit = function (event) {
        return handlePurchaseModalSubmit(event);
      };
    }

    if (purchaseModalCancel) {
      purchaseModalCancel.onclick = function () {
        hidePurchaseModal();
        return false;
      };
    }

    if (tabButtons) {
      for (var i = 0; i < tabButtons.length; i += 1) {
        var button = tabButtons[i];
        if (!button.getAttribute('data-tab')) {
          continue;
        }
        button.onclick = function () {
          switchTab(this.getAttribute('data-tab'));
          return false;
        };
      }
    }

    // Delegated click handler for copy buttons, download buttons, and version card toggles
    function delegatedClickHandler(e) {
      var target = e.target || e.srcElement;
      // Copy code
      var copyEl = target.closest ? target.closest('.copy-code') : findAncestorByClass(target, 'copy-code');
      if (copyEl) {
        try {
          var txt = copyEl.getAttribute('data-copy') || copyEl.textContent || '';
          copyTextToClipboard(txt.trim());
        } catch (err) {}
        e.stopPropagation && e.stopPropagation();
        e.preventDefault && e.preventDefault();
        return false;
      }

      // Download button
      var dl = target.closest ? target.closest('.download-version-btn') : findAncestorByClass(target, 'download-version-btn');
      if (dl) {
        var vid = dl.getAttribute('data-version-id');
        if (vid) {
          downloadVersion(vid, false);
        }
        e.stopPropagation && e.stopPropagation();
        e.preventDefault && e.preventDefault();
        return false;
      }

      // Save-on-server button (downloads straight to a folder on the
      // machine running the server, never sent over HTTP to the browser -
      // for browsers, like Mobile Safari on iOS 6, that can't reliably
      // receive a file download at all, even via the hidden-iframe trick)
      var saveServer = target.closest ? target.closest('.save-server-btn') : findAncestorByClass(target, 'save-server-btn');
      if (saveServer) {
        var svid = saveServer.getAttribute('data-version-id');
        if (svid) {
          downloadVersionToServer(svid, false);
        }
        e.stopPropagation && e.stopPropagation();
        e.preventDefault && e.preventDefault();
        return false;
      }

      // Version header toggle
      var header = target.closest ? target.closest('.version-header') : findAncestorByClass(target, 'version-header');
      if (header) {
        var card = header.parentNode;
        toggleLegacyVersionCard(card);
        e.stopPropagation && e.stopPropagation();
        e.preventDefault && e.preventDefault();
        return false;
      }
      return true;
    }

    if (searchResults && searchResults.addEventListener) {
      searchResults.addEventListener('click', delegatedClickHandler, false);
    }
    if (versionsList && versionsList.addEventListener) {
      versionsList.addEventListener('click', delegatedClickHandler, false);
    }

    // Ensure tab clicks work even if per-button handlers fail (older browsers)
    if (document && document.addEventListener) {
      document.addEventListener('click', function (e) {
        var t = e.target || e.srcElement;
        var btn = findAncestorWithDataTab(t);
        if (btn) {
          try {
            switchTab(btn.getAttribute('data-tab'));
          } catch (err) {}
          if (e.preventDefault) e.preventDefault();
          if (e.stopPropagation) e.stopPropagation();
          return false;
        }
      }, false);
    }
  }

  // Helper for older browsers without Element.closest
  function findAncestorByClass(el, className) {
    var needle = ' ' + className + ' ';
    while (el) {
      if (el.className && (' ' + ('' + el.className) + ' ').indexOf(needle) !== -1) {
        return el;
      }
      el = el.parentNode;
    }
    return null;
  }

  function findAncestorWithDataTab(el) {
    while (el) {
      try {
        if (el.getAttribute && el.getAttribute('data-tab')) {
          return el;
        }
      } catch (e) {}
      el = el.parentNode;
    }
    return null;
  }

  function init() {
    loginForm = byId('login-form');
    logoutButton = byId('logout-button');
    accountBox = byId('account-info');
    toast = byId('toast');
    appFinderSection = byId('app-finder-section');
    versionsSection = byId('versions-section');
    authModal = byId('auth-modal');
    authModalForm = byId('auth-modal-form');
    authModalMessage = byId('auth-modal-message');
    authModalError = byId('auth-modal-error');
    authModalInput = byId('auth-modal-input');
    authModalCancel = byId('auth-modal-cancel');
    authCodeMessage = byId('auth-code-message');
    searchForm = byId('search-form');
    directLookupForm = byId('direct-lookup-form');
    searchResults = byId('search-results');
    versionsList = byId('versions-list');
    appTitle = byId('app-title');
    appSubtitle = byId('app-subtitle');
    communityFallbackCheckbox = byId('community-fallback-checkbox');
    directCommunityFallbackCheckbox = byId('direct-community-fallback-checkbox');
    searchTab = byId('search-tab');
    directTab = byId('direct-tab');
    var platformSelect = byId('platform-select');
    var directPlatformSelect = byId('direct-platform-select');
    var platformHint = byId('platform-hint');
    purchaseModal = byId('purchase-modal');
    purchaseModalForm = byId('purchase-modal-form');
    purchaseModalCancel = byId('purchase-modal-cancel');
    purchaseAppId = byId('purchase-app-id');
    purchaseBundleId = byId('purchase-bundle-id');
    downloadProgress = byId('download-progress');
    downloadProgressText = byId('download-progress-text');
    downloadProgressFilename = byId('download-progress-filename');
    tabButtons = document.getElementsByTagName('button');

    attachEvents();
    switchTab('search');
    setLoggedIn(false);
    refreshAccountState();

    // Apple TV hint toggle for legacy (shown only when 'appletv' is selected)
    if (platformSelect && platformHint) {
      try {
        platformSelect.onchange = function () {
          setElementHidden(platformHint, this.value !== 'appletv');
        };
        setElementHidden(platformHint, platformSelect.value !== 'appletv');
      } catch (e) {
        // ignore
      }
    }
    if (directPlatformSelect && platformHint) {
      try {
        directPlatformSelect.onchange = function () {
          setElementHidden(platformHint, this.value !== 'appletv');
        };
      } catch (e) {
        // ignore
      }
    }
  }

  if (document.readyState === 'loading') {
    if (document.addEventListener) {
      document.addEventListener('DOMContentLoaded', init, false);
    }
  } else {
    init();
  }
})();
