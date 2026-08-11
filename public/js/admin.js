/**
 * AdminPortalController
 * Handles Secure Server-Side Passcode Authentication and Recording Management.
 * ZERO hardcoded passcodes or client-side bypass checks exist in this code!
 */
class AdminPortalController {
  constructor() {
    this.token = sessionStorage.getItem('admin_token') || null;
    this.baseUrl = window.location.protocol === 'file:' ? 'http://localhost:3000' : '';
    this.recordings = [];
  }

  /**
   * Attempt login with user entered passcode
   */
  async login(passcode) {
    try {
      const response = await fetch(`${this.baseUrl}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode })
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Authentication failed.');
      }

      this.token = data.token;
      sessionStorage.setItem('admin_token', this.token);
      return { success: true };
    } catch (err) {
      console.error('[Admin Login Error]', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Check if current session token is still valid on server
   */
  async verifySession() {
    if (!this.token) return false;

    try {
      const response = await fetch(`${this.baseUrl}/api/admin/verify`, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      if (response.ok) {
        const data = await response.json();
        return data.authenticated === true;
      }
    } catch (err) {
      console.error('[Admin Verification Error]', err);
    }

    this.logout();
    return false;
  }

  /**
   * Logout admin
   */
  async logout() {
    if (this.token) {
      try {
        await fetch(`${this.baseUrl}/api/admin/logout`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}` }
        });
      } catch (e) {}
    }
    this.token = null;
    sessionStorage.removeItem('admin_token');
  }

  /**
   * Fetch all recordings from server
   */
  async fetchRecordings() {
    if (!this.token) throw new Error('Not authenticated');

    const response = await fetch(`${this.baseUrl}/api/admin/recordings`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });

    if (!response.ok) {
      if (response.status === 401) {
        this.logout();
        throw new Error('Session expired. Please log in again.');
      }
      throw new Error('Failed to fetch recordings');
    }

    const data = await response.json();
    this.recordings = data.recordings || [];
    return this.recordings;
  }

  /**
   * Delete a recording
   */
  async deleteRecording(id) {
    if (!this.token) throw new Error('Not authenticated');

    const response = await fetch(`${this.baseUrl}/api/admin/recordings/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.token}` }
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.message || 'Failed to delete recording.');
    }

    return true;
  }

  /**
   * Download recording file with authorization header
   */
  async downloadFile(id, channel = 0) {
    if (!this.token) throw new Error('Not authenticated');

    let endpoint = `${this.baseUrl}/api/admin/recordings/${id}/file?dl=1`;
    if (channel === 1 || channel === 2) {
      endpoint = `${this.baseUrl}/api/admin/recordings/${id}/channel/${channel}?dl=1`;
    }

    const response = await fetch(endpoint, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });

    if (!response.ok) {
      throw new Error('Download failed. File may not exist.');
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    // Get filename from header if present
    const disposition = response.headers.get('Content-Disposition');
    let filename = `recording-${id}.wav`;
    if (disposition && disposition.indexOf('filename=') !== -1) {
      filename = disposition.split('filename=')[1].replace(/["']/g, '');
    }

    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  }

  /**
   * Helper to format bytes to human readable string
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Helper to format seconds to MM:SS
   */
  formatDuration(seconds) {
    const sec = Math.round(seconds || 0);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
}

window.AdminPortalController = AdminPortalController;

// Automatically initialize Admin UI when loaded on admin.html page
document.addEventListener('DOMContentLoaded', () => {
  const loginSection = document.getElementById('admin-login-section');
  const dashboardSection = document.getElementById('admin-dashboard-section');
  const userNav = document.getElementById('admin-user-nav');
  const loginForm = document.getElementById('admin-login-form');
  const passcode = document.getElementById('admin-passcode');
  const loginErrorMsg = document.getElementById('login-error-msg');
  const logoutBtn = document.getElementById('admin-logout-btn');
  const refreshBtn = document.getElementById('refresh-recordings-btn');
  const recordingsTableBody = document.getElementById('recordings-table-body');
  const emptyState = document.getElementById('admin-empty-state');

  if (!loginSection || !dashboardSection) return; // Not on admin.html page

  const controller = new AdminPortalController();
  const activeBlobUrls = new Map();

  function setInlineAudioSource(recId, blob) {
    if (activeBlobUrls.has(recId)) {
      URL.revokeObjectURL(activeBlobUrls.get(recId));
    }
    const blobUrl = URL.createObjectURL(blob);
    activeBlobUrls.set(recId, blobUrl);

    const audioEl = document.getElementById(`audio-player-${recId}`);
    if (audioEl) {
      audioEl.src = blobUrl;
      audioEl.play().catch(e => console.error('Play inline error:', e));
    }
  }

  async function checkSession() {
    const isValid = await controller.verifySession();
    if (isValid) {
      showDashboard();
    } else {
      showLogin();
    }
  }

  function showLogin() {
    loginSection.classList.remove('hidden');
    dashboardSection.classList.add('hidden');
    userNav.classList.add('hidden');
  }

  async function showDashboard() {
    loginSection.classList.add('hidden');
    dashboardSection.classList.remove('hidden');
    userNav.classList.remove('hidden');
    await loadRecordings();
  }

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (loginErrorMsg) loginErrorMsg.classList.add('hidden');
      const code = passcode ? passcode.value.trim() : '';
      if (!code) return;

      const res = await controller.login(code);
      if (res.success) {
        if (passcode) passcode.value = '';
        showDashboard();
        showToast('Admin authenticated successfully', 'success');
      } else if (loginErrorMsg) {
        loginErrorMsg.textContent = res.error || 'Incorrect passcode';
        loginErrorMsg.classList.remove('hidden');
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await controller.logout();
      showLogin();
      showToast('Logged out', 'success');
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadRecordings);
  }

  async function loadRecordings() {
    try {
      const recordings = await controller.fetchRecordings();
      recordingsTableBody.innerHTML = '';

      if (recordings.length === 0) {
        emptyState.style.display = 'block';
        emptyState.classList.remove('hidden');
        recordingsTableBody.parentElement.classList.add('hidden');
        return;
      }

      emptyState.style.display = 'none';
      emptyState.classList.add('hidden');
      recordingsTableBody.parentElement.classList.remove('hidden');

      recordings.forEach((rec) => {
        const formattedDate = new Date(rec.createdAt).toLocaleString();
        const durationStr = controller.formatDuration(rec.duration);
        const sizeStr = controller.formatBytes(rec.fileSize);

        // Data Row
        const tr = document.createElement('tr');
        tr.className = 'rec-item-row';
        tr.innerHTML = `
          <td>${formattedDate}</td>
          <td><span class="table-badge">${rec.roomId}</span></td>
          <td style="color:#a5b4fc; font-weight:600;">${rec.hostName}</td>
          <td style="color:#6ee7b7; font-weight:600;">${rec.guestName}</td>
          <td>${durationStr}</td>
          <td>${sizeStr}</td>
          <td>
            <div class="action-btn-group">
              <button class="btn-action-primary play-rec-btn" data-id="${rec.id}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                Listen / Play
              </button>
              <div class="download-dropdown">
                <button class="btn-action-outline dl-main-btn" data-id="${rec.id}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  Download WAV ▾
                </button>
                <div class="download-menu" id="dl-menu-${rec.id}" style="display: none !important;">
                  <button class="dl-item download-stereo-btn" data-id="${rec.id}">🎵 Full Stereo WAV</button>
                  <button class="dl-item download-left-btn" data-id="${rec.id}">🎙 Host Track (Ch 1)</button>
                  <button class="dl-item download-right-btn" data-id="${rec.id}">🎧 Guest Track (Ch 2)</button>
                </div>
              </div>
              <button class="btn-action-danger delete-rec-btn" data-id="${rec.id}" title="Delete Recording">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </div>
          </td>
        `;
        recordingsTableBody.appendChild(tr);

        // Drawer Player Row (Inline directly beneath this recording)
        const drawerTr = document.createElement('tr');
        drawerTr.className = 'player-drawer-row hidden';
        drawerTr.style.display = 'none';
        drawerTr.id = `player-drawer-${rec.id}`;
        drawerTr.innerHTML = `
          <td colspan="7" class="drawer-container-td">
            <div class="inline-admin-player">
              <div class="inline-player-header">
                <div class="inline-player-info">
                  <span class="player-live-badge">NOW PLAYING</span>
                  <strong class="player-title">${rec.hostName} & ${rec.guestName} (${rec.roomId})</strong>
                  <span class="player-subtext">PCM WAV 16-Bit | Size: ${sizeStr} | Duration: ${durationStr}</span>
                </div>
                
                <div class="channel-selector-group">
                  <span class="ch-label">Audio Track:</span>
                  <button class="ch-btn active" data-id="${rec.id}" data-ch="0">🎵 Stereo Both</button>
                  <button class="ch-btn" data-id="${rec.id}" data-ch="1">🎙 Host (Ch 1)</button>
                  <button class="ch-btn" data-id="${rec.id}" data-ch="2">🎧 Guest (Ch 2)</button>
                  <button class="close-player-btn" data-id="${rec.id}" title="Close Player">✕ Close</button>
                </div>
              </div>
              
              <div class="custom-player-bar" id="custom-player-bar-${rec.id}">
                <button class="custom-play-btn" id="play-btn-${rec.id}" data-id="${rec.id}" title="Play / Pause">
                  <svg class="icon-play" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                  <svg class="icon-pause hidden" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                </button>

                <div class="player-time-display" id="time-display-${rec.id}">
                  <span class="current-time" id="cur-time-${rec.id}">00:00</span> / <span class="total-duration" id="dur-time-${rec.id}">${durationStr}</span>
                </div>

                <div class="progress-seeker-wrapper">
                  <div class="progress-track-bg"></div>
                  <div class="progress-buffer-fill" id="buffer-fill-${rec.id}"></div>
                  <div class="progress-active-fill" id="active-fill-${rec.id}"></div>
                  <input type="range" class="custom-seek-input" id="seek-input-${rec.id}" data-id="${rec.id}" min="0" max="${rec.duration || 100}" value="0" step="0.1">
                </div>

                <div class="volume-control-group">
                  <button class="custom-vol-btn" id="vol-btn-${rec.id}" data-id="${rec.id}" title="Mute / Unmute">
                    <svg class="icon-vol-on" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
                    </svg>
                    <svg class="icon-vol-off hidden" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <line x1="1" y1="1" x2="23" y2="23"/>
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    </svg>
                  </button>
                  <input type="range" class="custom-vol-input" id="vol-input-${rec.id}" data-id="${rec.id}" min="0" max="1" value="1" step="0.05">
                </div>

                <audio id="audio-player-${rec.id}" preload="metadata" style="display:none;"></audio>
              </div>
            </div>
          </td>
        `;
        recordingsTableBody.appendChild(drawerTr);
        bindCustomPlayerControls(rec.id, rec.duration);
      });

      // Bind Play button handlers
      document.querySelectorAll('.play-rec-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          playInlineRecording(btn.dataset.id, 0);
        });
      });

      // Bind Download menu toggle handlers
      document.querySelectorAll('.dl-main-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const menu = document.getElementById(`dl-menu-${btn.dataset.id}`);
          document.querySelectorAll('.download-menu').forEach(m => {
            if (m !== menu) {
              m.style.display = 'none';
              m.classList.remove('show');
            }
          });
          if (menu) {
            const isShown = menu.style.display === 'block';
            menu.style.display = isShown ? 'none' : 'block';
            menu.classList.toggle('show', !isShown);
          }
        });
      });

      // Close dropdown menus when clicking elsewhere
      document.addEventListener('click', () => {
        document.querySelectorAll('.download-menu').forEach(m => {
          m.style.display = 'none';
          m.classList.remove('show');
        });
      });

      // Download Action Handlers
      document.querySelectorAll('.download-stereo-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          document.querySelectorAll('.download-menu').forEach(m => {
            m.style.display = 'none';
            m.classList.remove('show');
          });
          controller.downloadFile(btn.dataset.id, 0);
        });
      });
      document.querySelectorAll('.download-left-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          document.querySelectorAll('.download-menu').forEach(m => {
            m.style.display = 'none';
            m.classList.remove('show');
          });
          controller.downloadFile(btn.dataset.id, 1);
        });
      });
      document.querySelectorAll('.download-right-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          document.querySelectorAll('.download-menu').forEach(m => {
            m.style.display = 'none';
            m.classList.remove('show');
          });
          controller.downloadFile(btn.dataset.id, 2);
        });
      });

      // Delete Handler
      document.querySelectorAll('.delete-rec-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteRecording(btn.dataset.id);
        });
      });

      // Inline Close player buttons
      document.querySelectorAll('.close-player-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          closeInlinePlayer(btn.dataset.id);
        });
      });

      // Channel selector buttons inside inline player
      document.querySelectorAll('.ch-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const recId = btn.dataset.id;
          const ch = parseInt(btn.dataset.ch);

          // Toggle active class inside this drawer
          const drawer = document.getElementById(`player-drawer-${recId}`);
          if (drawer) {
            drawer.querySelectorAll('.ch-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
          }

          playInlineRecording(recId, ch);
        });
      });

    } catch (err) {
      console.error('Error loading recordings:', err);
      showToast(err.message || 'Failed to load recordings', 'error');
    }
  }

  function bindCustomPlayerControls(recId, fallbackDuration) {
    const audioEl = document.getElementById(`audio-player-${recId}`);
    const playBtn = document.getElementById(`play-btn-${recId}`);
    const curTimeEl = document.getElementById(`cur-time-${recId}`);
    const durTimeEl = document.getElementById(`dur-time-${recId}`);
    const bufferFill = document.getElementById(`buffer-fill-${recId}`);
    const activeFill = document.getElementById(`active-fill-${recId}`);
    const seekInput = document.getElementById(`seek-input-${recId}`);
    const volBtn = document.getElementById(`vol-btn-${recId}`);
    const volInput = document.getElementById(`vol-input-${recId}`);

    if (!audioEl || !playBtn || !seekInput) return;

    const iconPlay = playBtn.querySelector('.icon-play');
    const iconPause = playBtn.querySelector('.icon-pause');
    const iconVolOn = volBtn.querySelector('.icon-vol-on');
    const iconVolOff = volBtn.querySelector('.icon-vol-off');

    let isUserSeeking = false;

    function setPlayState(isPlaying) {
      if (isPlaying) {
        if (iconPlay) { iconPlay.classList.add('hidden'); iconPlay.style.display = 'none'; }
        if (iconPause) { iconPause.classList.remove('hidden'); iconPause.style.display = 'block'; }
      } else {
        if (iconPlay) { iconPlay.classList.remove('hidden'); iconPlay.style.display = 'block'; }
        if (iconPause) { iconPause.classList.add('hidden'); iconPause.style.display = 'none'; }
      }
    }

    function setMuteState(isMuted) {
      if (isMuted) {
        if (iconVolOn) { iconVolOn.classList.add('hidden'); iconVolOn.style.display = 'none'; }
        if (iconVolOff) { iconVolOff.classList.remove('hidden'); iconVolOff.style.display = 'block'; }
      } else {
        if (iconVolOn) { iconVolOn.classList.remove('hidden'); iconVolOn.style.display = 'block'; }
        if (iconVolOff) { iconVolOff.classList.add('hidden'); iconVolOff.style.display = 'none'; }
      }
    }

    // Initialize default icon states
    setPlayState(false);
    setMuteState(false);

    function updateDurationDisplay() {
      const dur = (audioEl.duration && !isNaN(audioEl.duration) && isFinite(audioEl.duration) && audioEl.duration > 0)
        ? audioEl.duration
        : fallbackDuration;
      if (dur) {
        seekInput.max = dur;
        if (durTimeEl) durTimeEl.textContent = controller.formatDuration(dur);
      }
    }

    // Playback state updates
    audioEl.addEventListener('play', () => { setPlayState(true); });
    audioEl.addEventListener('pause', () => { setPlayState(false); });

    audioEl.addEventListener('ended', () => {
      setPlayState(false);
      if (seekInput) seekInput.value = 0;
      if (activeFill) activeFill.style.width = '0%';
      if (curTimeEl) curTimeEl.textContent = '00:00';
    });

    audioEl.addEventListener('loadedmetadata', updateDurationDisplay);
    audioEl.addEventListener('durationchange', updateDurationDisplay);

    audioEl.addEventListener('timeupdate', () => {
      if (isUserSeeking) return;
      const dur = (audioEl.duration && !isNaN(audioEl.duration) && isFinite(audioEl.duration) && audioEl.duration > 0)
        ? audioEl.duration
        : fallbackDuration || 1;
      const cur = audioEl.currentTime || 0;

      if (curTimeEl) curTimeEl.textContent = controller.formatDuration(cur);
      if (durTimeEl) durTimeEl.textContent = controller.formatDuration(dur);
      if (seekInput) {
        seekInput.max = dur;
        seekInput.value = cur;
      }

      const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
      if (activeFill) activeFill.style.width = `${pct}%`;
    });

    audioEl.addEventListener('progress', () => {
      const dur = (audioEl.duration && !isNaN(audioEl.duration) && isFinite(audioEl.duration) && audioEl.duration > 0)
        ? audioEl.duration
        : fallbackDuration || 1;
      if (audioEl.buffered.length > 0) {
        const bufEnd = audioEl.buffered.end(audioEl.buffered.length - 1);
        const bufPct = Math.min(100, Math.max(0, (bufEnd / dur) * 100));
        if (bufferFill) bufferFill.style.width = `${bufPct}%`;
      }
    });

    // Play / Pause toggle click
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (audioEl.paused) {
        audioEl.play().catch(err => console.error('Play error:', err));
      } else {
        audioEl.pause();
      }
    });

    // Seek bar interaction
    seekInput.addEventListener('mousedown', () => { isUserSeeking = true; });
    seekInput.addEventListener('touchstart', () => { isUserSeeking = true; });

    seekInput.addEventListener('input', () => {
      const val = parseFloat(seekInput.value);
      const dur = parseFloat(seekInput.max) || 1;
      if (curTimeEl) curTimeEl.textContent = controller.formatDuration(val);
      const pct = Math.min(100, Math.max(0, (val / dur) * 100));
      if (activeFill) activeFill.style.width = `${pct}%`;
    });

    seekInput.addEventListener('change', () => {
      isUserSeeking = false;
      audioEl.currentTime = parseFloat(seekInput.value);
    });

    // Volume & Mute control
    volInput.addEventListener('input', () => {
      const vol = parseFloat(volInput.value);
      audioEl.volume = vol;
      audioEl.muted = (vol === 0);
      setMuteState(audioEl.muted);
    });

    volBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      audioEl.muted = !audioEl.muted;
      setMuteState(audioEl.muted);
      if (audioEl.muted) {
        volInput.value = 0;
      } else {
        volInput.value = audioEl.volume > 0 ? audioEl.volume : 1;
        audioEl.volume = parseFloat(volInput.value);
      }
    });
  }

  function playInlineRecording(recId, channel = 0) {
    const targetDrawer = document.getElementById(`player-drawer-${recId}`);
    const isTargetAlreadyOpen = targetDrawer && targetDrawer.style.display === 'table-row' && channel === 0;

    // 1. Close all download dropdown menus
    document.querySelectorAll('.download-menu').forEach(m => {
      m.style.display = 'none';
      m.classList.remove('show');
    });

    // 2. Pause and hide ALL player drawers across the entire page
    document.querySelectorAll('.player-drawer-row').forEach(row => {
      row.style.display = 'none';
      row.classList.add('hidden');
      const audio = row.querySelector('audio');
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
    });

    // 3. Toggle behavior: If user clicked Listen/Play on an already active stereo player, close it
    if (isTargetAlreadyOpen) {
      return;
    }

    // 4. Open ONLY the selected recording's player drawer
    if (targetDrawer) {
      targetDrawer.style.display = 'table-row';
      targetDrawer.classList.remove('hidden');
    }

    // 5. Instant high-performance audio streaming
    const audioEl = document.getElementById(`audio-player-${recId}`);
    const seekInput = document.getElementById(`seek-input-${recId}`);
    const activeFill = document.getElementById(`active-fill-${recId}`);
    const bufferFill = document.getElementById(`buffer-fill-${recId}`);
    const curTimeEl = document.getElementById(`cur-time-${recId}`);

    if (audioEl) {
      let mediaUrl = `${controller.baseUrl}/api/admin/recordings/${recId}/file?token=${encodeURIComponent(controller.token)}`;
      if (channel === 1 || channel === 2) {
        mediaUrl = `${controller.baseUrl}/api/admin/recordings/${recId}/channel/${channel}?token=${encodeURIComponent(controller.token)}`;
      }

      audioEl.src = mediaUrl;
      if (seekInput) seekInput.value = 0;
      if (activeFill) activeFill.style.width = '0%';
      if (bufferFill) bufferFill.style.width = '0%';
      if (curTimeEl) curTimeEl.textContent = '00:00';

      audioEl.load();
      audioEl.play().catch(err => console.error('[Inline Audio Play Error]', err));
    }
  }

  function closeInlinePlayer(recId) {
    const drawerRow = document.getElementById(`player-drawer-${recId}`);
    if (drawerRow) {
      drawerRow.style.display = 'none';
      drawerRow.classList.add('hidden');
      const audio = drawerRow.querySelector('audio');
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
    }
  }

  async function deleteRecording(id) {
    if (!confirm('Are you sure you want to permanently delete this WAV call recording?')) return;

    try {
      await controller.deleteRecording(id);
      showToast('Recording deleted', 'success');
      await loadRecordings();
    } catch (err) {
      showToast(err.message || 'Failed to delete recording', 'error');
    }
  }

  function showToast(message, type = 'info') {
    const toastContainer = document.getElementById('toast-container');
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => { toast.remove(); }, 4000);
  }

  checkSession();
});
