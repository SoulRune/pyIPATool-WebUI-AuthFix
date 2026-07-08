class IPAToolUI {
  constructor() {
    this.loginForm = document.querySelector('#login-form');
    this.logoutButton = document.querySelector('#logout-button');
    this.accountBox = document.querySelector('#account-info');
    this.accountFields = this.accountBox?.querySelectorAll('[data-field]') || [];
    this.toast = document.querySelector('#toast');
    this.sections = document.querySelectorAll('#app-finder-section, #versions-section');

    this.baseUrl = window.APP_BASE_URL || '';
    if (this.baseUrl === '/') {
      this.baseUrl = '';
    } else if (this.baseUrl.endsWith('/') && this.baseUrl.length > 1) {
      this.baseUrl = this.baseUrl.slice(0, -1);
    }

    this.authCodeField = document.querySelector('#auth-code-field');
    this.authCodeMessage = document.querySelector('#auth-code-message');
    this.authCodeInput = this.authCodeField ? this.authCodeField.querySelector('input') : null;
  this.authModal = document.querySelector('#auth-modal');
  this.authModalForm = document.querySelector('#auth-modal-form');
  this.authModalMessage = document.querySelector('#auth-modal-message');
  this.authModalError = document.querySelector('#auth-modal-error');
  this.authModalInput = document.querySelector('#auth-modal-input');
  this.authModalCancel = document.querySelector('#auth-modal-cancel');
  this.pendingCredentials = null;

    this.currentAppId = null;
    this.currentBundleId = null;
    this.currentPlatform = '';

    this.tabs = document.querySelectorAll('.tab-btn');
    this.tabContents = document.querySelectorAll('.tab-content');
    this.searchForm = document.querySelector('#search-form');
    this.directLookupForm = document.querySelector('#direct-lookup-form');
    this.searchResults = document.querySelector('#search-results');
    this.versionsSection = document.querySelector('#versions-section');
    this.versionsList = document.querySelector('#versions-list');
    this.appTitle = document.querySelector('#app-title');
    this.appSubtitle = document.querySelector('#app-subtitle');
    this.communityFallbackCheckbox = document.querySelector('#community-fallback-checkbox');
    this.directCommunityFallbackCheckbox = document.querySelector('#direct-community-fallback-checkbox');
    this.currentCommunityFallback = false;
    this.downloadProgress = document.querySelector('#download-progress');
    this.downloadProgressText = document.querySelector('#download-progress-text');
    this.downloadProgressFilename = document.querySelector('#download-progress-filename');
  }

  apiUrl(path) {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}${normalizedPath}`;
  }

  toggleAuthCode(show) {
    if (!this.authCodeField) {
      return;
    }
    this.authCodeField.hidden = !show;
    if (this.authCodeMessage) {
      this.authCodeMessage.hidden = !show;
    }
    if (!show && this.authCodeInput) {
      this.authCodeInput.value = '';
    }
    if (show && this.authCodeInput) {
      this.authCodeInput.focus();
    }
  }

  init() {
    // Hide versions section on initial load
    if (this.versionsSection) {
      this.versionsSection.hidden = true;
    }

    this.loginForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.handleLogin();
    });

    this.logoutButton?.addEventListener('click', () => this.handleLogout());

    this.authModalForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.handleAuthModalSubmit();
    });

    this.authModalCancel?.addEventListener('click', () => {
      this.hideAuthCodeModal();
      this.pendingCredentials = null;
    });

    this.tabs?.forEach(tab => {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
    });

    // Show the Apple TV hint only when that platform is selected
    const platformSelect = document.querySelector('#platform-select');
    const platformHint = document.querySelector('#platform-hint');
    if (platformSelect && platformHint) {
      platformSelect.addEventListener('change', (e) => {
        platformHint.hidden = e.target.value !== 'appletv';
      });
    }

    this.searchForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.handleSearch();
    });

    this.directLookupForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.handleDirectLookup();
    });

    this.refreshAccountState();
  }

  switchTab(tabName) {
    this.tabs.forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    this.tabContents.forEach(content => {
      content.classList.toggle('active', content.id === `${tabName}-tab`);
    });
    
    // Hide versions section when switching tabs
    if (this.versionsSection) {
      this.versionsSection.hidden = true;
    }
    
    // Clear search results when switching away from search tab
    if (tabName !== 'search' && this.searchResults) {
      this.searchResults.hidden = true;
    }
  }

  setLoggedIn(isLoggedIn) {
    if (this.loginForm) {
      this.loginForm.hidden = isLoggedIn;
      if (isLoggedIn) {
        this.loginForm.style.display = 'none';
      } else {
        this.loginForm.style.removeProperty('display');
      }
    }
    if (this.logoutButton) {
      this.logoutButton.hidden = !isLoggedIn;
    }
    if (this.accountBox) {
      this.accountBox.hidden = !isLoggedIn;
    }
    this.sections.forEach((section) => {
      if (section.id === 'app-finder-section') {
        section.hidden = !isLoggedIn;
      } else if (section.id === 'versions-section') {
        // Always hide versions section when logging in/out
        section.hidden = true;
      }
    });
    if (!isLoggedIn) {
      this.clearAccountFields();
      this.toggleAuthCode(false);
    }
  }

  clearAccountFields() {
    this.accountFields.forEach((node) => {
      node.textContent = 'N/A';
    });
  }

  async refreshAccountState() {
    try {
      const response = await fetch(this.apiUrl('/api/account'));
      if (!response.ok) {
        this.setLoggedIn(false);
        return;
      }
      const payload = await response.json();
      this.updateAccountBox(payload.account);
      this.setLoggedIn(true);
    } catch (error) {
      console.error(error);
      this.setLoggedIn(false);
    }
  }

  updateAccountBox(account) {
    if (!account) {
      this.setLoggedIn(false);
      return;
    }
    this.accountFields.forEach((node) => {
      const field = node.dataset.field;
      node.textContent = account?.[field] ?? 'N/A';
    });
  }

  async handleLogin() {
    if (!this.loginForm) {
      return;
    }

    const entries = Object.fromEntries(new FormData(this.loginForm).entries());
    const credentials = {
      email: entries.email || '',
      password: entries.password || '',
    };
    if (entries.authCode) {
      credentials.authCode = entries.authCode;
    }

    this.pendingCredentials = { ...credentials };
    await this.performLogin(credentials);
  }

  async performLogin(credentials) {
    const baseCredentials = {
      email: credentials.email || '',
      password: credentials.password || '',
    };
    const payload = { ...credentials };
    if (payload.authCode) {
      payload.authCode = String(payload.authCode).replace(/\s+/g, '');
    } else {
      delete payload.authCode;
    }

    try {
      const response = await fetch(this.apiUrl('/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();

      if (!response.ok) {
        if (response.status === 401 && result.authCodeRequired) {
          this.pendingCredentials = baseCredentials;
          this.showAuthCodeModal(result.error || 'Verification code required');
          return;
        }
        throw new Error(result.error || 'Login failed');
      }

      this.pendingCredentials = null;
      this.toggleAuthCode(false);
      this.hideAuthCodeModal();
      if (this.loginForm) {
        this.loginForm.reset();
      }
      this.showToast('Signed in successfully');
      this.updateAccountBox(result.account);
      this.setLoggedIn(true);
    } catch (error) {
      if (credentials.authCode) {
        this.pendingCredentials = baseCredentials;
        this.showAuthCodeModal(error.message || 'Login failed');
        if (this.authModalError) {
          this.authModalError.textContent = error.message || 'Login failed';
          this.authModalError.hidden = false;
        }
      } else {
        this.pendingCredentials = null;
      }
      this.showToast(error.message || 'Login failed', true);
    }
  }

  handleAuthModalSubmit() {
    if (!this.pendingCredentials) {
      this.showToast('Please start the sign-in flow again', true);
      this.hideAuthCodeModal();
      return;
    }

    const code = this.authModalInput?.value.trim();
    if (!code) {
      if (this.authModalError) {
        this.authModalError.textContent = 'Enter the six-digit verification code to continue.';
        this.authModalError.hidden = false;
      }
      this.authModalInput?.focus();
      return;
    }

    if (this.authModalError) {
      this.authModalError.hidden = true;
    }

    const nextAttempt = {
      ...this.pendingCredentials,
      authCode: code,
    };

    if (this.authCodeInput) {
      this.authCodeInput.value = code;
    }

    this.hideAuthCodeModal();
    this.pendingCredentials = nextAttempt;
    this.performLogin(nextAttempt);
  }

  async handleLogout() {
    try {
      await fetch(this.apiUrl('/api/auth/logout'), { method: 'POST' });
    } finally {
      this.showToast('Signed out');
      this.setLoggedIn(false);
    }
  }

  async handleSearch() {
    const formData = this.serializeForm(this.searchForm);
    const params = new URLSearchParams();
    if (formData.term) params.set('term', formData.term);
    if (formData.limit) params.set('limit', formData.limit);
    if (formData.platform) params.set('platform', formData.platform);
    this.lastSearchPlatform = formData.platform || '';
    this.lastSearchCommunityFallback = !!formData.communityFallback;

    try {
      const response = await fetch(`${this.apiUrl('/api/search')}?${params.toString()}`);
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Search failed');
      }
      this.renderSearchResults(payload.results || []);
    } catch (error) {
      this.showToast(error.message || 'Search failed', true);
    }
  }

  renderSearchResults(results) {
    if (!this.searchResults) return;
    
    if (results.length === 0) {
      this.searchResults.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔍</div><p>No apps found</p></div>';
      this.searchResults.hidden = false;
      return;
    }

    this.searchResults.innerHTML = results.map(app => `
      <div class="app-card" data-app-id="${app.trackId}" data-bundle-id="${app.bundleId}">
        <div class="app-card-header">
          <div>
            <h3 class="app-card-title">${app.trackName || 'Unknown'}</h3>
            <div class="app-card-meta">
              <span>📦 ${app.bundleId || 'N/A'}</span>
              <span>🏷️ v${app.version || 'N/A'}</span>
              ${app.price > 0 ? `<span>💰 $${app.price}</span>` : '<span class="badge">Free</span>'}
            </div>
            <div style="margin-top: 0.5rem;">
              <span class="copy-code" data-copy="${app.trackId}" title="Click to copy App ID">
                <span class="copy-icon">🆔</span>
                <span>${app.trackId}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    `).join('');

    this.searchResults.querySelectorAll('.app-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.copy-code')) {
          return;
        }
        
        const appId = card.dataset.appId;
        const bundleId = card.dataset.bundleId;
        this.loadAppVersions(appId, bundleId, null, this.lastSearchPlatform, this.lastSearchCommunityFallback);
      });
    });

    this.searchResults.querySelectorAll('.copy-code').forEach(code => {
      code.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = code.dataset.copy;
        navigator.clipboard.writeText(text).then(() => {
          this.showToast(`Copied: ${text}`);
        }).catch(() => {
          this.showToast('Failed to copy', true);
        });
      });
    });

    this.searchResults.hidden = false;
  }

  async handleDirectLookup() {
    const formData = this.serializeForm(this.directLookupForm);
    if (!formData.appId && !formData.bundleId) {
      this.showToast('Please provide App ID or Bundle ID', true);
      return;
    }
    this.loadAppVersions(formData.appId, formData.bundleId, formData.externalVersionId, formData.platform, !!formData.communityFallback);
  }

  async loadAppVersions(appId, bundleId, externalVersionId = null, platform = '', communityFallback = false) {
    this.currentAppId = appId;
    this.currentBundleId = bundleId;
    this.currentPlatform = platform || '';

    const communityFallbackEnabled = !!communityFallback;

    const params = new URLSearchParams();
    if (appId) params.set('appId', appId);
    if (bundleId) params.set('bundleId', bundleId);
    if (externalVersionId) params.set('externalVersionId', externalVersionId);
    if (this.currentPlatform) params.set('platform', this.currentPlatform);

    try {
      this.versionsSection.hidden = false;
      this.versionsList.innerHTML = '<div style="text-align:center;padding:2rem;"><div class="loading"></div></div>';
      this.appTitle.textContent = 'Loading...';
      this.appSubtitle.textContent = '';

      const response = await fetch(`${this.apiUrl('/api/versions')}?${params.toString()}`);
      const data = await response.json();
      if (!response.ok) {
        const failureType = data.metadata?.failureType;
        const marketAllowed = data.metadata?.['m-allowed'];

        // Genuine "you don't own this yet" - always the normal license flow,
        // regardless of the community-fallback toggle. Falling back to
        // Timbrd here would just paper over a license Apple is telling us
        // outright is missing.
        if (failureType === '9610' || (data.error && data.error.includes('license'))) {
          const shouldAcquire = confirm('A license is required to view versions for this app. Would you like to acquire it now?');
          if (shouldAcquire) {
            await this.acquireLicenseAndRetry(appId, bundleId, externalVersionId, this.currentPlatform);
            return;
          }
          throw new Error(data.error || 'Failed to load versions');
        }

        // The Chrome-style "5002 / m-allowed:false" signature: Apple's
        // generic refusal that isn't really about licensing (can persist
        // even after a successful purchase - see prior investigation).
        // Only worth trying Timbrd for this specific, confirmed pattern -
        // not for arbitrary other failures, which Timbrd data can't explain
        // or fix anyway.
        if (communityFallbackEnabled && failureType === '5002' && marketAllowed === false) {
          this.showToast('Apple refused this app (not a licensing issue) - trying the community database instead...');
          await this.loadAppVersionsFromCommunity(appId, bundleId);
          return;
        }

        throw new Error(data.error || 'Failed to load versions');
      }

      const versions = Array.isArray(data.externalVersionIdentifiers) ? data.externalVersionIdentifiers : [];
      await this.loadAndRenderVersions(versions);
    } catch (error) {
      this.showToast(error.message || 'Failed to load versions', true);
      this.versionsList.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div><p>${error.message}</p></div>`;
      this.versionsSection.hidden = true;
    }
  }

  async loadAppVersionsFromCommunity(appId, bundleId) {
    const params = new URLSearchParams();
    if (appId) params.set('appId', appId);
    if (bundleId) params.set('bundleId', bundleId);

    try {
      this.versionsSection.hidden = false;
      this.versionsList.innerHTML = '<div style="text-align:center;padding:2rem;"><div class="loading"></div></div>';
      this.appTitle.textContent = 'Loading...';
      this.appSubtitle.textContent = '';

      const response = await fetch(`${this.apiUrl('/api/versions/community')}?${params.toString()}`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to load community versions');
      }

      const entries = Array.isArray(data.entries) ? data.entries : [];
      this.appTitle.textContent = 'App Versions';
      this.appSubtitle.textContent = `Community database (Timbrd) • ${entries.length} version${entries.length === 1 ? '' : 's'}`;
      this.renderCommunityVersions(entries);
    } catch (error) {
      this.showToast(error.message || 'Failed to load community versions', true);
      this.versionsList.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div><p>${error.message}</p></div>`;
    }
  }

  renderCommunityVersions(entries) {
    if (entries.length === 0) {
      this.versionsList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📦</div><p>No versions found in the community database</p></div>';
      return;
    }

    this.versionsList.innerHTML = entries.map(entry => {
      const sizeText = entry.size ? `${(entry.size / 1024 / 1024).toFixed(2)} MB` : 'Unknown';
      const dateText = entry.createdAt || 'Unknown';
      const bundleIdText = this.currentBundleId || 'N/A';
      return `
        <div class="version-card" data-version-id="${entry.externalVersionId}">
          <div class="version-header">
            <div class="version-basic">
              <div><strong>Version:</strong> ${entry.bundleVersion || 'unknown'}</div>
              <div><strong>Build:</strong> N/A</div>
              <div><strong>Size:</strong> ${sizeText}</div>
              <div><strong>Seen:</strong> ${dateText}</div>
            </div>
            <span class="expand-icon">▼</span>
          </div>
          <div class="version-details">
            <dl>
              <dt>Version ID:</dt>
              <dd>
                <span class="copy-code" data-copy="${entry.externalVersionId}" title="Click to copy Version ID">
                  <span>${entry.externalVersionId}</span>
                </span>
              </dd>
              <dt>Bundle ID:</dt><dd>${bundleIdText}</dd>
              <dt>Source:</dt><dd>Community database (Timbrd) - not run or endorsed by Apple</dd>
            </dl>
            <div class="version-actions">
              <button type="button" class="download-version-btn" data-version-id="${entry.externalVersionId}">Download IPA</button>
              <button type="button" class="save-server-btn secondary" data-version-id="${entry.externalVersionId}" title="Save directly on the machine running the server, skip the browser download entirely">💾 Save on server</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    this.versionsList.querySelectorAll('.version-card').forEach(card => {
      const header = card.querySelector('.version-header');
      header.addEventListener('click', () => {
        card.classList.toggle('expanded');
      });

      const downloadBtn = card.querySelector('.download-version-btn');
      downloadBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.downloadVersion(downloadBtn.dataset.versionId, false);
      });
      const saveServerBtn = card.querySelector('.save-server-btn');
      saveServerBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.downloadVersionToServer(saveServerBtn.dataset.versionId, false);
      });
      const copyCode = card.querySelector('.copy-code');
      copyCode?.addEventListener('click', () => {
        const text = copyCode.dataset.copy;
        navigator.clipboard?.writeText(text).then(() => this.showToast(`Copied: ${text}`));
      });
    });
  }

  async acquireLicenseAndRetry(appId, bundleId, externalVersionId = null, platform = '') {
    try {
      this.showToast('Acquiring license...');
      
      const payload = {};
      if (appId) payload.appId = appId;
      if (bundleId) payload.bundleId = bundleId;

      const response = await fetch(this.apiUrl('/api/purchase'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to acquire license');
      }
      
      this.showToast('License acquired successfully');
      
      // Retry loading versions
      await this.loadAppVersions(appId, bundleId, externalVersionId, platform);
    } catch (error) {
      this.showToast(error.message || 'Failed to acquire license', true);
      this.versionsSection.hidden = true;
    }
  }

  async loadAndRenderVersions(versionIds) {
    if (versionIds.length === 0) {
      this.versionsList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📦</div><p>No versions found</p></div>';
      this.versionsSection.hidden = true;
      return;
    }

    const metadataPromises = versionIds.map(versionId => this.fetchVersionMetadata(versionId));
    const metadataResults = await Promise.allSettled(metadataPromises);
    
    const versions = metadataResults
      .map((result, index) => {
        if (result.status === 'fulfilled') {
          return { ...result.value, versionId: versionIds[index] };
        }
        return null;
      })
      .filter(Boolean);

    if (versions.length > 0) {
      this.appTitle.textContent = versions[0].itemName || 'App Versions';
      this.appSubtitle.textContent = `${versions[0].bundleId || this.currentBundleId} • ${versions.length} version${versions.length > 1 ? 's' : ''}`;
      this.renderVersionCards(versions);
      this.versionsSection.hidden = false;
    } else {
      this.versionsList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📦</div><p>No versions found</p></div>';
      this.versionsSection.hidden = true;
    }
  }

  async fetchVersionMetadata(versionId) {
    const params = new URLSearchParams();
    if (this.currentAppId) params.set('appId', this.currentAppId);
    if (this.currentBundleId) params.set('bundleId', this.currentBundleId);
    params.set('versionId', versionId);

    const response = await fetch(`${this.apiUrl('/api/version-metadata')}?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) {
      // For metadata errors, we'll just skip this version instead of prompting
      // since we're loading multiple versions at once
      throw new Error(data.error || 'Failed to load metadata');
    }
    return data;
  }

  renderVersionCards(versions) {
    this.versionsList.innerHTML = versions.map((version, index) => {
      const fileSizeMB = (version.fileSize / (1024 * 1024)).toFixed(2);
      const releaseDate = version.releaseDateDisplay || (version.releaseDate
        ? new Date(version.releaseDate).toLocaleDateString()
        : 'Unknown');

      return `
        <div class="version-card" data-version-id="${version.versionId}" data-index="${index}">
          <div class="version-header">
            <div class="version-basic">
              <div><strong>Version:</strong> ${version.displayVersion}</div>
              <div><strong>Build:</strong> ${version.buildNumber}</div>
              <div><strong>Size:</strong> ${fileSizeMB} MB</div>
              <div><strong>Released:</strong> ${releaseDate}</div>
            </div>
            <span class="expand-icon">▼</span>
          </div>
          <div class="version-details">
            <dl>
              <dt>Version ID:</dt>
              <dd>
                <span class="copy-code" data-copy="${version.versionId}" title="Click to copy Version ID">
                  <span>${version.versionId}</span>
                </span>
              </dd>
              <dt>Bundle ID:</dt><dd>${version.bundleId}</dd>
              <dt>Developer:</dt><dd>${version.artistName}</dd>
              <dt>Genre:</dt><dd>${version.genre}</dd>
              <dt>Age Rating:</dt><dd>${version.ageRating}</dd>
              <dt>Copyright:</dt><dd>${version.copyright}</dd>
            </dl>
            <div class="version-actions">
              <button type="button" class="download-version-btn" data-version-id="${version.versionId}">Download IPA</button>
              <button type="button" class="save-server-btn secondary" data-version-id="${version.versionId}" title="Save directly on the machine running the server, skip the browser download entirely">💾 Save on server</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    this.versionsList.querySelectorAll('.version-card').forEach(card => {
      const header = card.querySelector('.version-header');
      header.addEventListener('click', () => {
        card.classList.toggle('expanded');
      });

      const downloadBtn = card.querySelector('.download-version-btn');
      
      downloadBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.downloadVersion(card.dataset.versionId, false);
      });

      const saveServerBtn = card.querySelector('.save-server-btn');

      saveServerBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.downloadVersionToServer(card.dataset.versionId, false);
      });
    });

    this.versionsList.querySelectorAll('.copy-code').forEach(code => {
      code.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = code.dataset.copy;
        navigator.clipboard.writeText(text).then(() => {
          this.showToast(`Copied: ${text}`);
        }).catch(() => {
          this.showToast('Failed to copy', true);
        });
      });
    });
  }

  async downloadVersion(versionId, purchaseIfNeeded) {
    return this.startDownloadJob(versionId, purchaseIfNeeded, false);
  }

  // Downloads straight to a folder on the machine running the server
  // (~/Downloads/IPATool), never sent over HTTP to the browser at all. For
  // browsers that can't reliably receive a file download - Mobile Safari on
  // iOS 6 appears to be one of these, even with the hidden-iframe handoff
  // used by the normal download path - this is the only download path that
  // actually results in a usable file.
  async downloadVersionToServer(versionId, purchaseIfNeeded) {
    return this.startDownloadJob(versionId, purchaseIfNeeded, true);
  }

  async startDownloadJob(versionId, purchaseIfNeeded, saveToServerFolder) {
    const payload = {
      externalVersionId: versionId
    };
    if (this.currentAppId) payload.appId = this.currentAppId;
    if (this.currentBundleId) payload.bundleId = this.currentBundleId;
    if (this.currentPlatform) payload.platform = this.currentPlatform;
    if (purchaseIfNeeded) payload.purchaseIfNeeded = true;
    if (saveToServerFolder) payload.saveToServerFolder = true;

    try {
      this.showToast(saveToServerFolder ? 'Starting server-side download...' : 'Starting download...');
      this.showDownloadProgress('Preparing download...');

      // Previously this did the whole Apple download + zip patch inside one
      // fetch() and buffered the entire result as a Blob before saving -
      // meaning zero progress feedback for however long that took (often
      // minutes), a connection that had to stay open the whole time, and
      // the full IPA held in browser memory at once. Now the server does
      // the work in a background job we poll for real byte progress, and
      // the finished file is handed to the browser as a plain download
      // (hidden iframe navigation) instead of a buffered Blob - or, if
      // saveToServerFolder is set, left in a folder on the server and never
      // sent over HTTP at all.
      const startResponse = await fetch(this.apiUrl('/api/download-jobs'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const startData = await startResponse.json();
      if (!startResponse.ok || !startData.jobId) {
        throw new Error(startData.error || 'Download failed');
      }

      await this.pollDownloadJob(startData.jobId, saveToServerFolder);
    } catch (error) {
      this.hideDownloadProgress();
      this.showToast(error.message || 'Download failed', true);
    }
  }

  pollDownloadJob(jobId, saveToServerFolder) {
    return new Promise((resolve) => {
      let filename = 'app.ipa';
      const poll = async () => {
        let job;
        try {
          const response = await fetch(this.apiUrl(`/api/download-jobs/${jobId}`));
          if (response.status === 404) {
            this.hideDownloadProgress();
            this.showToast('Download failed', true);
            resolve();
            return;
          }
          job = await response.json();
        } catch (error) {
          this.hideDownloadProgress();
          this.showToast('Download failed', true);
          resolve();
          return;
        }

        if (job.filename) filename = job.filename;

        if (job.status === 'error') {
          this.hideDownloadProgress();
          this.showToast(job.error || 'Download failed', true);
          resolve();
          return;
        }

        if (job.status === 'ready') {
          if (saveToServerFolder) {
            this.hideDownloadProgress();
            this.showToast(`Saved on server: ${job.serverPath || filename}`);
            resolve();
            return;
          }
          const fileUrl = this.apiUrl(`/api/download-jobs/${jobId}/file`);
          this.updateDownloadProgress('Saving file...', filename);
          this.fetchFileViaHiddenIframe(fileUrl);
          this.showManualDownloadLink(fileUrl, filename);
          setTimeout(() => {
            this.hideDownloadProgress();
            this.showToast(`Downloading: ${filename}`);
          }, 800);
          resolve();
          return;
        }

        if (job.phase === 'patching' || job.phase === 'finalizing') {
          // The raw download already finished (100%); the server is now
          // rewriting the whole package on its own CPU to add metadata and
          // inject the SINF signature. This is genuinely slow for big apps
          // on weak hardware and used to be totally invisible here - it
          // just looked stuck at 100% with no explanation.
          let label = job.phase === 'patching' ? 'Patching package...' : 'Finalizing (adding signature)...';
          if (job.itemsTotal) {
            label += ` ${job.itemsDone} / ${job.itemsTotal} files`;
          }
          this.updateDownloadProgress(label, filename);
        } else if (job.bytesTotal) {
          const percent = Math.floor((job.bytesDone / job.bytesTotal) * 100);
          const done = (job.bytesDone / 1024 / 1024).toFixed(1);
          const total = (job.bytesTotal / 1024 / 1024).toFixed(1);
          this.updateDownloadProgress(`${percent}% (${done} MB / ${total} MB)`, filename);
        } else if (job.bytesDone) {
          this.updateDownloadProgress(`Downloading... ${(job.bytesDone / 1024 / 1024).toFixed(1)} MB`, filename);
        } else {
          this.updateDownloadProgress('Preparing download...', filename);
        }

        setTimeout(poll, 1500);
      };
      poll();
    });
  }

  fetchFileViaHiddenIframe(url) {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = url;
    document.body.appendChild(iframe);
    setTimeout(() => {
      iframe.remove();
    }, 60000);
  }

  // Some WebKit-based iOS browsers (observed: Orion, likely due to its
  // built-in tracker/ad blocking flagging the hidden-iframe navigation
  // pattern above as suspicious) fail to actually save the file even though
  // the request succeeds - Safari handles the same trick fine. A real,
  // visible link the user taps themselves is a much more reliable fallback,
  // since genuine user-initiated navigation isn't what those blockers
  // target.
  showManualDownloadLink(url, filename) {
    const existing = document.querySelector('#manual-download-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'manual-download-banner';
    banner.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1e293b;border:1px solid rgba(148,163,184,0.3);border-radius:12px;padding:0.85rem 1rem;box-shadow:0 10px 30px rgba(0,0,0,0.4);z-index:9998;width:calc(100vw - 2.5rem);max-width:420px;font-size:0.9rem;color:#f8fafc;box-sizing:border-box;';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;gap:0.75rem;margin-bottom:0.6rem;';

    const label = document.createElement('div');
    label.style.cssText = 'color:rgba(226,232,240,0.8);line-height:1.3;';
    label.textContent = "If the download didn't start automatically:";

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'flex-shrink:0;width:28px;height:28px;line-height:26px;text-align:center;background:rgba(148,163,184,0.15);border:none;border-radius:50%;color:rgba(226,232,240,0.8);cursor:pointer;font-size:0.9rem;padding:0;';
    closeBtn.addEventListener('click', () => banner.remove());

    header.appendChild(label);
    header.appendChild(closeBtn);

    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.cssText = 'display:block;color:#60a5fa;font-weight:600;text-decoration:none;word-break:break-all;line-height:1.4;';
    link.textContent = `⬇️ Tap to download ${filename}`;

    banner.appendChild(header);
    banner.appendChild(link);
    document.body.appendChild(banner);

    // Don't let it linger forever if it's never dismissed manually.
    setTimeout(() => banner.remove(), 5 * 60 * 1000);
  }

  showDownloadProgress(message, filename = '') {
    if (!this.downloadProgress) return;
    if (this.downloadProgressText) {
      this.downloadProgressText.textContent = message;
    }
    if (this.downloadProgressFilename) {
      this.downloadProgressFilename.textContent = filename;
      this.downloadProgressFilename.hidden = !filename;
    }
    this.downloadProgress.hidden = false;
  }

  updateDownloadProgress(message, filename = '') {
    if (this.downloadProgressText) {
      this.downloadProgressText.textContent = message;
    }
    if (this.downloadProgressFilename && filename) {
      this.downloadProgressFilename.textContent = filename;
      this.downloadProgressFilename.hidden = false;
    }
  }

  hideDownloadProgress() {
    if (this.downloadProgress) {
      this.downloadProgress.hidden = true;
    }
  }

  serializeForm(form) {
    const result = {};
    if (!form) return result;
    const formData = new FormData(form);
    for (const [key, value] of formData.entries()) {
      if (value === '') continue;
      if (result[key]) {
        if (Array.isArray(result[key])) {
          result[key].push(value);
        } else {
          result[key] = [result[key], value];
        }
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  showToast(message, isError = false) {
    if (!this.toast) return;
    this.toast.textContent = message;
    
    // Remove all toast type classes
    this.toast.classList.remove('success', 'error', 'info');
    
    // Add appropriate class
    if (isError) {
      this.toast.classList.add('error');
    } else if (message.toLowerCase().includes('copied')) {
      this.toast.classList.add('info');
    } else {
      this.toast.classList.add('success');
    }
    
    this.toast.style.removeProperty('background');
    this.toast.hidden = false;
    
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast.hidden = true;
    }, 2500);
  }

  showAuthCodeModal(message) {
    if (!this.authModal) {
      this.toggleAuthCode(true);
      if (this.authCodeMessage) {
        this.authCodeMessage.hidden = false;
        this.authCodeMessage.textContent = message;
      }
      return;
    }

    if (this.authModalMessage) {
      this.authModalMessage.textContent = message || 'Enter the verification code to continue.';
    }
    if (this.authModalInput) {
      this.authModalInput.value = '';
    }
    if (this.authModalError) {
      this.authModalError.hidden = true;
    }
    this.authModal.hidden = false;
    this.authModalInput?.focus();
  }

  hideAuthCodeModal() {
    if (this.authModal) {
      this.authModal.hidden = true;
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const ui = new IPAToolUI();
  ui.init();
});
