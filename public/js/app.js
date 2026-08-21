/**
 * App Controller
 * Glues UI, WebRTC Manager, Dual-Channel WAV Recorder, and Visualizers together.
 */
document.addEventListener('DOMContentLoaded', () => {
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

  // Secret admin trigger
  const navAdminBtn = document.getElementById('nav-admin-btn');
  const brandTitleTrigger = document.getElementById('brand-title-trigger');
  const secretAdminTrigger = document.getElementById('secret-admin-trigger');

  // State
  let rtcManager = null;
  let wavRecorder = null;
  let isEndingCall = false;
  
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
      isEndingCall = false;

      // Initialize WebRTC Manager
      rtcManager = new window.RTCManager({
        onRemoteStreamAdded: (remoteStream) => {
          console.log('[App] Remote stream received, attaching audio element & visualizer...');
          let remoteAudioEl = document.getElementById('remote-audio-element');
          if (!remoteAudioEl) {
            remoteAudioEl = document.createElement('audio');
            remoteAudioEl.id = 'remote-audio-element';
            remoteAudioEl.autoplay = true;
            remoteAudioEl.playsInline = true;
            document.body.appendChild(remoteAudioEl);
          }
          remoteAudioEl.srcObject = remoteStream;
          remoteAudioEl.muted = false;
          remoteAudioEl.volume = 1.0;

          const playPromise = remoteAudioEl.play();
          if (playPromise !== undefined) {
            playPromise.catch(err => {
              console.warn('[App] Remote audio play deferred for user interaction:', err);
              const unlockAudio = () => {
                remoteAudioEl.play().catch(e => console.error('Play error on unlock:', e));
                document.removeEventListener('click', unlockAudio);
                document.removeEventListener('touchstart', unlockAudio);
              };
              document.addEventListener('click', unlockAudio);
              document.addEventListener('touchstart', unlockAudio);
            });
          }

          setupVisualizers(rtcManager.localStream, remoteStream);

          // If recorder is already active, attach remote stream dynamically
          if (wavRecorder && wavRecorder.isRecording) {
            wavRecorder.attachRemoteStream(remoteStream);
          } else if (isHost && (!wavRecorder || !wavRecorder.isRecording)) {
            // Start dual-channel recording when peer connects
            wavRecorder = new window.DualChannelWavRecorder();
            wavRecorder.start(rtcManager.localStream, remoteStream, true, visualizerAudioCtx, {
              roomId: activeRoomId,
              hostName: localUsername,
              guestName: remoteUsername
            });
            recStatusText.textContent = 'RECORDING ACTIVE (WAV 16-bit PCM)';
            showToast('Peer joined - Dual-channel recording started', 'success');
          } else {
            recStatusText.textContent = 'CALL IN PROGRESS (Recorded by Host)';
          }
        },
        onUserJoined: ({ username }) => {
          remoteUsername = username;
          remoteNameDisplay.textContent = username;
          if (wavRecorder && wavRecorder.streamOptions) {
            wavRecorder.streamOptions.hostName = isHost ? localUsername : username;
            wavRecorder.streamOptions.guestName = isHost ? username : localUsername;
          }
          showToast(`${username} joined the call`, 'success');
        },
        onUserLeft: ({ username, isExplicitHangup }) => {
          remoteNameDisplay.textContent = 'Peer disconnected';
          showToast(`${username} disconnected`, 'info');
          if (isExplicitHangup) {
            endCallAndSaveRecording();
          }
        },
        onCallEnded: () => {
          showToast('Call ended by peer', 'info');
          endCallAndSaveRecording();
        }
      });

      await rtcManager.initialize(localUsername, activeRoomId, isHost);

      // Switch view to call screen
      lobbyView.classList.add('hidden');
      callView.classList.remove('hidden');

      // Update canvas dimensions in next animation frame once layout has calculated
      requestAnimationFrame(updateCanvasDimensions);

      // Start call duration timer
      startTimer();

      // Setup local visualizer; recording will start automatically once peer connects
      recStatusText.textContent = 'WAITING FOR PEER TO JOIN...';
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
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(shareLinkInput.value)
        .then(() => showToast('Call link copied to clipboard!', 'success'))
        .catch(() => fallbackCopy());
    } else {
      fallbackCopy();
    }
  });

  function fallbackCopy() {
    try {
      shareLinkInput.select();
      document.execCommand('copy');
      showToast('Call link copied to clipboard!', 'success');
    } catch (err) {
      showToast('Please copy the URL manually', 'info');
    }
  }

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
    if (isEndingCall) return;
    isEndingCall = true;

    stopTimer();

    // 1. Finalize and save recording on server first while AudioContext is still alive
    if (wavRecorder && wavRecorder.isRecording) {
      try {
        await wavRecorder.stop();
      } catch (err) {
        console.warn('[WAV Stop Error]', err);
      }
      wavRecorder = null;
    }

    // 2. Disconnect WebRTC connection
    if (rtcManager) {
      rtcManager.leaveCall();
      rtcManager = null;
    }

    // 3. Clean up visualizers and audio context
    stopVisualizers();

    // Reset view state to home lobby without forcing hard page reloads
    callView.classList.add('hidden');
    lobbyView.classList.remove('hidden');
    remoteNameDisplay.textContent = 'Waiting for peer...';
    recStatusText.textContent = 'RECORDING IDLE';
    btnMuteToggle.classList.remove('muted');
    iconMicOn.classList.remove('hidden');
    iconMicOff.classList.add('hidden');

    if (vuFillLeft) vuFillLeft.style.width = '0%';
    if (vuFillRight) vuFillRight.style.width = '0%';

    window.history.replaceState({}, document.title, window.location.pathname);
  }

  // -------------------------------------------------------------
  // DUAL AUDIO VISUALIZER (OSCILLOSCOPE & VU METER)
  // -------------------------------------------------------------
  function updateCanvasDimensions() {
    [canvasLeft, canvasRight].forEach(canvas => {
      if (canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
        if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
          canvas.width = canvas.clientWidth;
          canvas.height = canvas.clientHeight;
        }
      }
    });
  }

  window.addEventListener('resize', updateCanvasDimensions);

  async function setupVisualizers(localStream, remoteStream) {
    if (!visualizerAudioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      visualizerAudioCtx = new AudioCtx({ sampleRate: 48000, latencyHint: 'interactive' });
    }
    if (visualizerAudioCtx.state === 'suspended') {
      try { await visualizerAudioCtx.resume(); } catch (e) {}
    }

    updateCanvasDimensions();

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

    if (!animFrameId) {
      drawVisualizers();
    }
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
    if (!canvas || !vuElement) return;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteTimeDomainData(dataArray);

    const ctx = canvas.getContext('2d');
    const width = canvas.width || canvas.clientWidth || 300;
    const height = canvas.height || canvas.clientHeight || 80;

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
      try { visualizerAudioCtx.close(); } catch (e) {}
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

  if (brandTitleTrigger) {
    brandTitleTrigger.addEventListener('dblclick', triggerAdminAccess);
  }

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

  if (navAdminBtn) {
    navAdminBtn.addEventListener('click', triggerAdminAccess);
  }

  function showToast(message, type = 'info') {
    const toastContainer = document.getElementById('toast-container');
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 4000);
  }
});
