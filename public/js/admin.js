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
    this.currentAudioPlayer = null;
    this.currentPanner = null;
    this.audioCtx = null;
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

    let endpoint = `${this.baseUrl}/api/admin/recordings/${id}/file`;
    if (channel === 1 || channel === 2) {
      endpoint = `${this.baseUrl}/api/admin/recordings/${id}/channel/${channel}`;
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
  const playerCard = document.getElementById('admin-audio-player-card');
  const audioElement = document.getElementById('admin-audio-element');
  const playerTitle = document.getElementById('player-title');
  const playerSubtext = document.getElementById('player-subtext');

  if (!loginSection || !dashboardSection) return; // Not on admin.html page

  const controller = new AdminPortalController();
  let selectedRecordingId = null;
  let currentAudioObjectUrl = null;

  function setPlayerAudioSource(blob) {
    if (currentAudioObjectUrl) {
      URL.revokeObjectURL(currentAudioObjectUrl);
    }
    currentAudioObjectUrl = URL.createObjectURL(blob);
    audioElement.src = currentAudioObjectUrl;
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

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginErrorMsg.classList.add('hidden');
    const code = passcode.value.trim();
    if (!code) return;

    const res = await controller.login(code);
    if (res.success) {
      passcode.value = '';
      showDashboard();
      showToast('Admin authenticated successfully', 'success');
    } else {
      loginErrorMsg.textContent = res.error || 'Incorrect passcode';
      loginErrorMsg.classList.remove('hidden');
    }
  });

  logoutBtn.addEventListener('click', async () => {
    await controller.logout();
    showLogin();
    showToast('Logged out', 'success');
  });

  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadRecordings);
  }

  async function loadRecordings() {
    try {
      const recordings = await controller.fetchRecordings();
      recordingsTableBody.innerHTML = '';

      if (recordings.length === 0) {
        emptyState.classList.remove('hidden');
        recordingsTableBody.parentElement.classList.add('hidden');
        playerCard.classList.add('hidden');
        return;
      }

      emptyState.classList.add('hidden');
      recordingsTableBody.parentElement.classList.remove('hidden');

      recordings.forEach((rec) => {
        const tr = document.createElement('tr');
        const formattedDate = new Date(rec.createdAt).toLocaleString();
        const durationStr = controller.formatDuration(rec.duration);
        const sizeStr = controller.formatBytes(rec.fileSize);

        tr.innerHTML = `
          <td>${formattedDate}</td>
          <td><span class="table-badge">${rec.roomId}</span></td>
          <td style="color:#a5b4fc; font-weight:600;">${rec.hostName}</td>
          <td style="color:#6ee7b7; font-weight:600;">${rec.guestName}</td>
          <td>${durationStr}</td>
          <td>${sizeStr}</td>
          <td>
            <div style="display:flex; gap:0.4rem; flex-wrap:wrap;">
              <button class="btn-action-icon play-rec-btn" data-id="${rec.id}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                Play
              </button>
              <button class="btn-action-icon download-stereo-btn" data-id="${rec.id}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Stereo
              </button>
              <button class="btn-action-icon download-left-btn" data-id="${rec.id}" title="Download Host Audio Track Only">
                Ch 1 (Host)
              </button>
              <button class="btn-action-icon download-right-btn" data-id="${rec.id}" title="Download Guest Audio Track Only">
                Ch 2 (Guest)
              </button>
              <button class="btn-action-icon danger delete-rec-btn" data-id="${rec.id}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </div>
          </td>
        `;

        recordingsTableBody.appendChild(tr);
      });

      // Bind dynamic row actions
      document.querySelectorAll('.play-rec-btn').forEach(btn => {
        btn.addEventListener('click', () => playRecording(btn.dataset.id));
      });
      document.querySelectorAll('.download-stereo-btn').forEach(btn => {
        btn.addEventListener('click', () => controller.downloadFile(btn.dataset.id, 0));
      });
      document.querySelectorAll('.download-left-btn').forEach(btn => {
        btn.addEventListener('click', () => controller.downloadFile(btn.dataset.id, 1));
      });
      document.querySelectorAll('.download-right-btn').forEach(btn => {
        btn.addEventListener('click', () => controller.downloadFile(btn.dataset.id, 2));
      });
      document.querySelectorAll('.delete-rec-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteRecording(btn.dataset.id));
      });

    } catch (err) {
      console.error('Error loading recordings:', err);
      showToast(err.message || 'Failed to load recordings', 'error');
    }
  }

  async function playRecording(id) {
    selectedRecordingId = id;
    const rec = controller.recordings.find(r => r.id === id);
    if (!rec) return;

    playerTitle.textContent = `${rec.hostName} vs ${rec.guestName} (${rec.roomId})`;
    playerSubtext.textContent = `Uncompressed 16-Bit PCM WAV | Size: ${controller.formatBytes(rec.fileSize)} | Duration: ${controller.formatDuration(rec.duration)}`;

    document.querySelectorAll('.ch-btn').forEach(b => b.classList.remove('active'));
    const defaultBtn = document.querySelector('.ch-btn[data-ch="0"]');
    if (defaultBtn) defaultBtn.classList.add('active');

    try {
      const response = await fetch(`${controller.baseUrl}/api/admin/recordings/${id}/file`, {
        headers: { 'Authorization': `Bearer ${controller.token}` }
      });
      const blob = await response.blob();
      setPlayerAudioSource(blob);
      playerCard.classList.remove('hidden');
      audioElement.play();
    } catch (err) {
      showToast('Error loading audio stream', 'error');
    }
  }

  document.querySelectorAll('.ch-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.ch-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const ch = parseInt(btn.dataset.ch);
      if (!selectedRecordingId) return;

      try {
        let endpoint = `${controller.baseUrl}/api/admin/recordings/${selectedRecordingId}/file`;
        if (ch === 1 || ch === 2) {
          endpoint = `${controller.baseUrl}/api/admin/recordings/${selectedRecordingId}/channel/${ch}`;
        }

        const response = await fetch(endpoint, {
          headers: { 'Authorization': `Bearer ${controller.token}` }
        });
        const blob = await response.blob();
        setPlayerAudioSource(blob);
        audioElement.play();
      } catch (err) {
        showToast('Error switching audio channel', 'error');
      }
    });
  });

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
