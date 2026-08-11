/**
 * App Controller
 * Glues UI, WebRTC Manager, Dual-Channel WAV Recorder, Visualizers, and Admin Portal together.
 */
document.addEventListener('DOMContentLoaded', () => {
  const apiBaseUrl = window.location.protocol === 'file:' ? 'http://localhost:3000' : '';
  
  // UI Elements
  const lobbyView = document.getElementById('lobby-view');
  const callView = document.getElementById('call-view');
  const joinForm = document.getElementById('join-form');
  const usernameInput = document.getElementById('username-input');
  const roomInput = document.getElementById('room-input');
  
  const recStatusText = document.getElementById('rec-status-text');
  const callTimerDisplay = document.getElementById('call-timer-display');
  const shareLinkInput = document.getElementById('share-link-input');
  const copyLinkBtn = document.getElementById('copy-link-btn');

  const localNameDisplay = document.getElementById('local-name-display');
  const remoteNameDisplay = document.getElementById('remote-name-display');

  const btnMuteToggle = document.getElementById('btn-mute-toggle');
  const iconMicOn = document.getElementById('icon-mic-on');
  const iconMicOff = document.getElementById('icon-mic-off');
  const btnHangup = document.getElementById('btn-hangup');

  // Canvas & VU Meters
  const canvasLeft = document.getElementById('canvas-left');
  const canvasRight = document.getElementById('canvas-right');
  const vuFillLeft = document.getElementById('vu-fill-left');
  const vuFillRight = document.getElementById('vu-fill-right');

  // Admin Modals
  const navAdminBtn = document.getElementById('nav-admin-btn');
  const adminLoginModal = document.getElementById('admin-login-modal');
  const adminLoginForm = document.getElementById('admin-login-form');
  const adminPasscode = document.getElementById('admin-passcode');
  const loginErrorMsg = document.getElementById('login-error-msg');
  const adminDashboardModal = document.getElementById('admin-dashboard-modal');
  const adminLogoutBtn = document.getElementById('admin-logout-btn');
  const recordingsTableBody = document.getElementById('recordings-table-body');
  const adminEmptyState = document.getElementById('admin-empty-state');
  const adminAudioPlayerCard = document.getElementById('admin-audio-player-card');
  const adminAudioElement = document.getElementById('admin-audio-element');
  const playerTitle = document.getElementById('player-title');
  const playerSubtext = document.getElementById('player-subtext');

  // Controllers
  const adminController = new window.AdminPortalController();
  let rtcManager = null;
  let wavRecorder = null;
  
  let timerInterval = null;
  let secondsElapsed = 0;
  let isHost = true;
  let activeRoomId = '';
  let localUsername = '';
  let remoteUsername = 'Guest';

  // Visualizer Animation Contexts
  let animFrameId = null;
  let leftAnalyser = null;
  let rightAnalyser = null;
  let visualizerAudioCtx = null;

  // -------------------------------------------------------------
  // INITIALIZATION & URL ROOM PARSING
  // -------------------------------------------------------------
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');

  if (roomParam) {
    roomInput.value = roomParam;
    isHost = false; // Joined via link
  } else {
    // Generate room ID for host
    const autoRoom = 'call-' + Math.random().toString(36).substring(2, 8);
    roomInput.value = autoRoom;
    isHost = true;
  }

  // -------------------------------------------------------------
  // JOIN CALL SUBMISSION
  // -------------------------------------------------------------
  joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    localUsername = usernameInput.value.trim();
    activeRoomId = roomInput.value.trim();

    if (!localUsername || !activeRoomId) {
      showToast('Please enter both name and room ID', 'error');
      return;
    }

    // Set share link
    const roomUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(activeRoomId)}`;
    shareLinkInput.value = roomUrl;

    localNameDisplay.textContent = `${localUsername} (${isHost ? 'Host' : 'Guest'})`;

    try {
      // Initialize WebRTC Manager
      rtcManager = new window.RTCManager({
        onRemoteStreamAdded: (remoteStream) => {
          console.log('[App] Remote stream received, attaching audio element & visualizer...');
          const remoteAudioEl = document.getElementById('remote-audio-element');
          if (remoteAudioEl) {
            remoteAudioEl.srcObject = remoteStream;
            remoteAudioEl.play().catch(e => console.error('[App] Play remote audio error:', e));
          }

          setupVisualizers(rtcManager.localStream, remoteStream);

          // Auto-start recording as soon as both streams are present
          if (!wavRecorder || !wavRecorder.isRecording) {
            wavRecorder = new window.DualChannelWavRecorder();
            wavRecorder.start(rtcManager.localStream, remoteStream, isHost);
            recStatusText.textContent = 'RECORDING ACTIVE (WAV 16-bit PCM)';
            showToast('Dual-channel WAV recording started automatically', 'success');
          }
        },
        onUserJoined: ({ username }) => {
          remoteUsername = username;
          remoteNameDisplay.textContent = username;
          showToast(`${username} joined the call`, 'success');
        },
        onUserLeft: ({ username }) => {
          remoteNameDisplay.textContent = 'Peer disconnected';
          showToast(`${username} left the call`, 'error');
        },
        onCallEnded: () => {
          showToast('Call ended by peer', 'error');
          endCallAndSaveRecording();
        }
      });

      await rtcManager.initialize(localUsername, activeRoomId, isHost);

      // Switch view to call screen
      lobbyView.classList.add('hidden');
      callView.classList.remove('hidden');

      // Start call duration timer
      startTimer();

      // If initial local stream is ready, set up local visualizer
      if (rtcManager.localStream) {
        setupVisualizers(rtcManager.localStream, null);
      }

    } catch (err) {
      console.error('Failed to start call:', err);
      showToast(err.message || 'Microphone access denied', 'error');
    }
  });

  // -------------------------------------------------------------
  // COPY SHARE LINK
  // -------------------------------------------------------------
  copyLinkBtn.addEventListener('click', () => {
    shareLinkInput.select();
    navigator.clipboard.writeText(shareLinkInput.value);
    showToast('Call link copied to clipboard!', 'success');
  });

  // -------------------------------------------------------------
  // MUTE TOGGLE
  // -------------------------------------------------------------
  btnMuteToggle.addEventListener('click', () => {
    if (rtcManager) {
      const isMuted = rtcManager.toggleMute();
      btnMuteToggle.classList.toggle('muted', isMuted);
      iconMicOn.classList.toggle('hidden', isMuted);
      iconMicOff.classList.toggle('hidden', !isMuted);
      showToast(isMuted ? 'Microphone Muted' : 'Microphone Unmuted', 'success');
    }
  });

  // -------------------------------------------------------------
  // HANG UP & SAVE RECORDING
  // -------------------------------------------------------------
  btnHangup.addEventListener('click', () => {
    endCallAndSaveRecording();
  });

  async function endCallAndSaveRecording() {
    stopTimer();
    stopVisualizers();

    let wavData = null;
    if (wavRecorder && wavRecorder.isRecording) {
      recStatusText.textContent = 'SAVING UNCOMPRESSED WAV...';
      wavData = await wavRecorder.stop();
    }

    if (rtcManager) {
      rtcManager.leaveCall();
      rtcManager = null;
    }

    if (wavData && wavData.blob) {
      // Upload recording to server
      const formData = new FormData();
      formData.append('audio', wavData.blob, `call-${activeRoomId}.wav`);
      formData.append('roomId', activeRoomId);
      formData.append('hostName', isHost ? localUsername : remoteUsername);
      formData.append('guestName', isHost ? remoteUsername : localUsername);
      formData.append('duration', wavData.duration);
      formData.append('sampleRate', wavData.sampleRate);
      formData.append('numChannels', 2);

      showToast('Uploading uncompressed stereo WAV to server...', 'success');

      try {
        const response = await fetch(`${apiBaseUrl}/api/recordings/upload`, {
          method: 'POST',
          body: formData
        });
        const resJson = await response.json();

        if (resJson.success) {
          showToast('Call recording saved securely on server!', 'success');
        } else {
          showToast('Failed to save recording on server', 'error');
        }
      } catch (err) {
        console.error('Error uploading recording:', err);
        showToast('Error uploading audio recording', 'error');
      }
    }

    // Return to Lobby
    callView.classList.add('hidden');
    lobbyView.classList.remove('hidden');
    remoteNameDisplay.textContent = 'Waiting for peer...';
  }

  // -------------------------------------------------------------
  // DUAL AUDIO VISUALIZER (OSCILLOSCOPE & VU METER)
  // -------------------------------------------------------------
  async function setupVisualizers(localStream, remoteStream) {
    if (!visualizerAudioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      visualizerAudioCtx = new AudioCtx();
    }
    if (visualizerAudioCtx.state === 'suspended') {
      await visualizerAudioCtx.resume();
    }

    if (localStream && !leftAnalyser) {
      const localSource = visualizerAudioCtx.createMediaStreamSource(localStream);
      leftAnalyser = visualizerAudioCtx.createAnalyser();
      leftAnalyser.fftSize = 256;
      localSource.connect(leftAnalyser);
    }

    if (remoteStream && !rightAnalyser) {
      const remoteSource = visualizerAudioCtx.createMediaStreamSource(remoteStream);
      rightAnalyser = visualizerAudioCtx.createAnalyser();
      rightAnalyser.fftSize = 256;
      remoteSource.connect(rightAnalyser);
    }

    drawVisualizers();
  }

  function drawVisualizers() {
    animFrameId = requestAnimationFrame(drawVisualizers);

    // Left Channel Visualizer (Local Mic)
    if (leftAnalyser) {
      renderWaveformAndVU(leftAnalyser, canvasLeft, vuFillLeft, '#6366f1');
    }

    // Right Channel Visualizer (Remote Peer)
    if (rightAnalyser) {
      renderWaveformAndVU(rightAnalyser, canvasRight, vuFillRight, '#10b981');
    }
  }

  function renderWaveformAndVU(analyser, canvas, vuElement, color) {
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteTimeDomainData(dataArray);

    const ctx = canvas.getContext('2d');
    const width = canvas.width = canvas.clientWidth;
    const height = canvas.height = canvas.clientHeight;

    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.beginPath();

    const sliceWidth = width * 1.0 / bufferLength;
    let x = 0;
    let sumSquares = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0;
      const y = v * height / 2;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x += sliceWidth;

      const norm = (dataArray[i] - 128) / 128;
      sumSquares += norm * norm;
    }

    ctx.stroke();

    // VU meter level calculation (RMS)
    const rms = Math.sqrt(sumSquares / bufferLength);
    const vuPercent = Math.min(100, Math.round(rms * 250));
    vuElement.style.width = `${vuPercent}%`;
  }

  function stopVisualizers() {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
    leftAnalyser = null;
    rightAnalyser = null;
    if (visualizerAudioCtx) {
      visualizerAudioCtx.close();
      visualizerAudioCtx = null;
    }
  }

  // -------------------------------------------------------------
  // CALL TIMER
  // -------------------------------------------------------------
  function startTimer() {
    secondsElapsed = 0;
    callTimerDisplay.textContent = '00:00';
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      secondsElapsed++;
      const m = Math.floor(secondsElapsed / 60).toString().padStart(2, '0');
      const s = (secondsElapsed % 60).toString().padStart(2, '0');
      callTimerDisplay.textContent = `${m}:${s}`;
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
  }

  // -------------------------------------------------------------
  // SECRET ADMIN PORTAL TRIGGERS (Double-click logo / Footer Lock / Ctrl+Shift+A)
  // -------------------------------------------------------------
  function triggerAdminAccess() {
    window.location.href = '/admin';
  }

  const brandTitleTrigger = document.getElementById('brand-title-trigger');
  if (brandTitleTrigger) {
    brandTitleTrigger.addEventListener('dblclick', triggerAdminAccess);
  }

  const secretAdminTrigger = document.getElementById('secret-admin-trigger');
  if (secretAdminTrigger) {
    secretAdminTrigger.addEventListener('click', triggerAdminAccess);
  }

  // Secret keyboard shortcut: Ctrl + Shift + A  or  Alt + A
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'a') || (e.altKey && e.key.toLowerCase() === 'a')) {
      e.preventDefault();
      triggerAdminAccess();
    }
  });

  navAdminBtn.addEventListener('click', triggerAdminAccess);

  // Admin login submission (Passcode validated strictly on server)
  adminLoginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginErrorMsg.classList.add('hidden');

    const passcode = adminPasscode.value.trim();
    if (!passcode) return;

    const res = await adminController.login(passcode);
    if (res.success) {
      adminPasscode.value = '';
      closeModal(adminLoginModal);
      openAdminDashboard();
      showToast('Admin authenticated successfully', 'success');
    } else {
      loginErrorMsg.textContent = res.error || 'Incorrect passcode';
      loginErrorMsg.classList.remove('hidden');
    }
  });

  adminLogoutBtn.addEventListener('click', async () => {
    await adminController.logout();
    closeModal(adminDashboardModal);
    showToast('Admin logged out', 'success');
  });

  async function openAdminDashboard() {
    openModal(adminDashboardModal);
    await loadRecordingsList();
  }

  async function loadRecordingsList() {
    try {
      const recordings = await adminController.fetchRecordings();
      recordingsTableBody.innerHTML = '';

      if (recordings.length === 0) {
        adminEmptyState.classList.remove('hidden');
        recordingsTableBody.parentElement.classList.add('hidden');
        adminAudioPlayerCard.classList.add('hidden');
        return;
      }

      adminEmptyState.classList.add('hidden');
      recordingsTableBody.parentElement.classList.remove('hidden');

      recordings.forEach((rec) => {
        const tr = document.createElement('tr');
        const formattedDate = new Date(rec.createdAt).toLocaleString();
        const durationStr = adminController.formatDuration(rec.duration);
        const sizeStr = adminController.formatBytes(rec.fileSize);

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

      // Bind dynamic row button actions
      document.querySelectorAll('.play-rec-btn').forEach(btn => {
        btn.addEventListener('click', () => playRecording(btn.dataset.id));
      });
      document.querySelectorAll('.download-stereo-btn').forEach(btn => {
        btn.addEventListener('click', () => adminController.downloadFile(btn.dataset.id, 0));
      });
      document.querySelectorAll('.download-left-btn').forEach(btn => {
        btn.addEventListener('click', () => adminController.downloadFile(btn.dataset.id, 1));
      });
      document.querySelectorAll('.download-right-btn').forEach(btn => {
        btn.addEventListener('click', () => adminController.downloadFile(btn.dataset.id, 2));
      });
      document.querySelectorAll('.delete-rec-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteRecording(btn.dataset.id));
      });

    } catch (err) {
      console.error('Error loading recordings:', err);
      showToast(err.message || 'Failed to load recordings', 'error');
    }
  }

  let selectedRecordingId = null;
  let currentAudioObjectUrl = null;

  function setPlayerAudioSource(blob) {
    if (currentAudioObjectUrl) {
      URL.revokeObjectURL(currentAudioObjectUrl);
    }
    currentAudioObjectUrl = URL.createObjectURL(blob);
    adminAudioElement.src = currentAudioObjectUrl;
  }

  async function playRecording(id) {
    selectedRecordingId = id;
    const rec = adminController.recordings.find(r => r.id === id);
    if (!rec) return;

    playerTitle.textContent = `${rec.hostName} vs ${rec.guestName} (${rec.roomId})`;
    playerSubtext.textContent = `Uncompressed 16-Bit PCM WAV | Size: ${adminController.formatBytes(rec.fileSize)} | Duration: ${adminController.formatDuration(rec.duration)}`;

    // Reset active channel buttons to Stereo Both
    document.querySelectorAll('.ch-btn').forEach(b => b.classList.remove('active'));
    const defaultChBtn = document.querySelector('.ch-btn[data-ch="0"]');
    if (defaultChBtn) defaultChBtn.classList.add('active');

    // Direct authorized audio fetch stream
    try {
      const response = await fetch(`${apiBaseUrl}/api/admin/recordings/${id}/file`, {
        headers: { 'Authorization': `Bearer ${adminController.token}` }
      });
      const blob = await response.blob();
      setPlayerAudioSource(blob);
      adminAudioPlayerCard.classList.remove('hidden');
      adminAudioElement.play();
    } catch (err) {
      showToast('Error loading audio stream', 'error');
    }
  }

  // Audio Channel Selection (Stereo vs Solo Host vs Solo Guest)
  document.querySelectorAll('.ch-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.ch-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const ch = parseInt(btn.dataset.ch);
      if (!selectedRecordingId) return;

      try {
        let endpoint = `${apiBaseUrl}/api/admin/recordings/${selectedRecordingId}/file`;
        if (ch === 1 || ch === 2) {
          endpoint = `${apiBaseUrl}/api/admin/recordings/${selectedRecordingId}/channel/${ch}`;
        }

        const response = await fetch(endpoint, {
          headers: { 'Authorization': `Bearer ${adminController.token}` }
        });
        const blob = await response.blob();
        setPlayerAudioSource(blob);
        adminAudioElement.play();
      } catch (err) {
        showToast('Error switching audio channel', 'error');
      }
    });
  });

  async function deleteRecording(id) {
    if (!confirm('Are you sure you want to permanently delete this WAV call recording?')) return;

    try {
      await adminController.deleteRecording(id);
      showToast('Recording deleted', 'success');
      await loadRecordingsList();
    } catch (err) {
      showToast(err.message || 'Failed to delete recording', 'error');
    }
  }

  // -------------------------------------------------------------
  // MODAL & TOAST HELPERS
  // -------------------------------------------------------------
  function openModal(modal) {
    modal.classList.add('active');
  }

  function closeModal(modal) {
    modal.classList.remove('active');
  }

  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.closeModal;
      const modal = document.getElementById(targetId);
      if (modal) closeModal(modal);
    });
  });

  function showToast(message, type = 'info') {
    const toastContainer = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 4000);
  }
});
