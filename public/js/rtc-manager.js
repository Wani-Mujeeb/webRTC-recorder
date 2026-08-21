/**
 * RTCManager
 * Handles Socket.io signaling and WebRTC Peer-to-Peer audio connection.
 */
class RTCManager {
  constructor(options = {}) {
    this.socket = null;
    this.peerConnection = null;
    this.localStream = null;
    this.remoteStream = null;
    
    this.roomId = null;
    this.username = null;
    this.isHost = false;
    this.targetSocketId = null;
    this.iceCandidateQueue = [];
    this._hasNotifiedRemoteTrack = false;

    // Callbacks
    this.onRemoteStreamAdded = options.onRemoteStreamAdded || null;
    this.onUserJoined = options.onUserJoined || null;
    this.onUserLeft = options.onUserLeft || null;
    this.onCallEnded = options.onCallEnded || null;
    this.onConnectionStateChange = options.onConnectionStateChange || null;

    // Standard Google STUN configuration
    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };
  }

  /**
   * Connect to Socket.IO signaling server and request local audio stream
   */
  async initialize(username, roomId, isHost = false) {
    this.username = username;
    this.roomId = roomId;
    this.isHost = isHost;
    this._hasNotifiedRemoteTrack = false;

    // 1. Get Local Microphone Audio Stream
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        },
        video: false
      });
    } catch (err) {
      console.error('Error accessing microphone:', err);
      throw new Error('Microphone permission denied or device not found.');
    }

    // 2. Connect to Socket.IO (auto-detect server URL if opened via file://)
    const serverUrl = window.location.protocol === 'file:' ? 'http://localhost:3000' : undefined;
    if (typeof io === 'undefined') {
      throw new Error('Socket.IO client library not loaded. Please open your app URL in browser.');
    }
    this.socket = serverUrl ? io(serverUrl) : io();

    // 3. Socket event bindings
    this.socket.on('connect', () => {
      console.log(`[Socket] Connected to server as ${this.username}`);
      this.socket.emit('join-room', {
        roomId: this.roomId,
        username: this.username,
        isHost: this.isHost
      });
    });

    // When another user joins the room after us
    this.socket.on('user-connected', async ({ socketId, username, isHost }) => {
      console.log(`[RTC] User connected: ${username} (${socketId})`);
      this.targetSocketId = socketId;
      if (this.onUserJoined) this.onUserJoined({ socketId, username, isHost });

      // The existing occupant in the room initiates the WebRTC offer to guarantee connection
      await this._createPeerConnection(socketId);
      try {
        const offer = await this.peerConnection.createOffer({
          offerToReceiveAudio: true
        });
        offer.sdp = this._optimizeOpusSDP(offer.sdp);
        await this.peerConnection.setLocalDescription(offer);

        this.socket.emit('signal-offer', {
          targetSocketId: socketId,
          offer: offer,
          callerName: this.username
        });
      } catch (e) {
        console.error('[RTC] Failed to create offer:', e);
      }
    });

    // When joining a room that already has active users
    this.socket.on('room-users', async (existingUsers) => {
      console.log(`[RTC] Existing room users received:`, existingUsers);
      if (existingUsers && existingUsers.length > 0) {
        const peer = existingUsers[0];
        this.targetSocketId = peer.socketId;
        if (this.onUserJoined) this.onUserJoined(peer);

        // If I am marked host or designated first, initiate offer
        if (!this.peerConnection) {
          await this._createPeerConnection(peer.socketId);
          if (this.isHost) {
            try {
              const offer = await this.peerConnection.createOffer({ offerToReceiveAudio: true });
              offer.sdp = this._optimizeOpusSDP(offer.sdp);
              await this.peerConnection.setLocalDescription(offer);
              this.socket.emit('signal-offer', {
                targetSocketId: peer.socketId,
                offer: offer,
                callerName: this.username
              });
            } catch (e) {
              console.error('[RTC] Failed to create offer on room-users:', e);
            }
          }
        }
      }
    });

    this.socket.on('signal-offer', async ({ senderSocketId, offer, callerName }) => {
      console.log(`[RTC] Received offer from ${callerName} (${senderSocketId})`);
      this.targetSocketId = senderSocketId;
      
      await this._createPeerConnection(senderSocketId);
      try {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        await this._flushIceCandidateQueue();

        const answer = await this.peerConnection.createAnswer();
        answer.sdp = this._optimizeOpusSDP(answer.sdp);
        await this.peerConnection.setLocalDescription(answer);

        this.socket.emit('signal-answer', {
          targetSocketId: senderSocketId,
          answer: answer
        });
      } catch (err) {
        console.error('[RTC] Error answering offer:', err);
      }
    });

    this.socket.on('signal-answer', async ({ senderSocketId, answer }) => {
      console.log(`[RTC] Received answer from ${senderSocketId}`);
      if (this.peerConnection) {
        try {
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
          await this._flushIceCandidateQueue();
        } catch (err) {
          console.error('[RTC] Error setting remote description for answer:', err);
        }
      }
    });

    this.socket.on('signal-ice-candidate', async ({ senderSocketId, candidate }) => {
      if (candidate) {
        if (this.peerConnection && this.peerConnection.remoteDescription && this.peerConnection.remoteDescription.type) {
          try {
            await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (err) {
            console.error('[RTC] Error adding ICE candidate:', err);
          }
        } else {
          this.iceCandidateQueue.push(candidate);
        }
      }
    });

    this.socket.on('user-disconnected', ({ socketId, username }) => {
      console.log(`[RTC] Peer disconnected: ${username}`);
      this._hasNotifiedRemoteTrack = false;
      if (this.onUserLeft) this.onUserLeft({ socketId, username, isExplicitHangup: false });
    });

    this.socket.on('call-ended-by-peer', ({ socketId, username }) => {
      console.log(`[RTC] Peer ended call explicitly: ${username}`);
      this._hasNotifiedRemoteTrack = false;
      this._closePeerConnection();
      if (this.onCallEnded) this.onCallEnded({ socketId, username, isExplicitHangup: true });
    });
  }

  /**
   * Internal helper to flush queued ICE candidates once remote description is ready
   */
  async _flushIceCandidateQueue() {
    if (this.peerConnection && this.peerConnection.remoteDescription && this.iceCandidateQueue.length > 0) {
      console.log(`[RTC] Flushing ${this.iceCandidateQueue.length} queued ICE candidates...`);
      while (this.iceCandidateQueue.length > 0) {
        const candidate = this.iceCandidateQueue.shift();
        if (candidate) {
          try {
            await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (err) {
            console.error('[RTC] Error adding queued ICE candidate:', err);
          }
        }
      }
    }
  }

  /**
   * Internal helper to create RTCPeerConnection
   */
  async _createPeerConnection(targetSocketId) {
    this._closePeerConnection();

    this.peerConnection = new RTCPeerConnection(this.rtcConfig);
    this.remoteStream = new MediaStream();
    this._hasNotifiedRemoteTrack = false;

    // Add local mic tracks to peer connection
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        this.peerConnection.addTrack(track, this.localStream);
      });
    }

    // Handle incoming remote audio tracks with deduplication
    this.peerConnection.ontrack = (event) => {
      console.log('[RTC] Remote track received:', event.track.kind);
      if (event.streams && event.streams[0]) {
        event.streams[0].getTracks().forEach(track => {
          if (!this.remoteStream.getTracks().some(t => t.id === track.id)) {
            this.remoteStream.addTrack(track);
          }
        });
      } else if (event.track) {
        if (!this.remoteStream.getTracks().some(t => t.id === event.track.id)) {
          this.remoteStream.addTrack(event.track);
        }
      }

      if (this.onRemoteStreamAdded && !this._hasNotifiedRemoteTrack) {
        this._hasNotifiedRemoteTrack = true;
        this.onRemoteStreamAdded(this.remoteStream);
      }
    };

    // Send ICE candidates to signaling server
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.socket) {
        this.socket.emit('signal-ice-candidate', {
          targetSocketId: targetSocketId,
          candidate: event.candidate
        });
      }
    };

    // Connection state monitor & auto-reconnect recovery
    this.peerConnection.onconnectionstatechange = async () => {
      if (this.peerConnection) {
        const state = this.peerConnection.connectionState;
        console.log('[RTC] Connection State:', state);
        if (state === 'failed') {
          console.warn('[RTC] Connection failed. Initiating ICE restart...');
          try {
            this.peerConnection.restartIce();
            const offer = await this.peerConnection.createOffer({ iceRestart: true });
            offer.sdp = this._optimizeOpusSDP(offer.sdp);
            await this.peerConnection.setLocalDescription(offer);
            if (this.socket && targetSocketId) {
              this.socket.emit('signal-offer', {
                targetSocketId: targetSocketId,
                offer: offer,
                callerName: this.username
              });
            }
          } catch (restartErr) {
            console.error('[RTC] Error during ICE restart:', restartErr);
          }
        }
        if (this.onConnectionStateChange) {
          this.onConnectionStateChange(state);
        }
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      if (this.peerConnection) {
        console.log('[RTC] ICE Connection State:', this.peerConnection.iceConnectionState);
      }
    };
  }

  /**
   * Toggle local microphone mute
   */
  toggleMute() {
    if (this.localStream) {
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        const isMuted = !audioTrack.enabled;
        if (this.socket) {
          this.socket.emit('audio-toggle', { isMuted });
        }
        return isMuted;
      }
    }
    return false;
  }

  /**
   * End current call and notify peer
   */
  leaveCall() {
    if (this.socket) {
      try {
        this.socket.emit('end-call');
        this.socket.disconnect();
        this.socket.removeAllListeners();
      } catch (e) {}
      this.socket = null;
    }
    this._closePeerConnection();

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
  }

  _closePeerConnection() {
    this.iceCandidateQueue = [];
    this._hasNotifiedRemoteTrack = false;
    if (this.peerConnection) {
      this.peerConnection.onicecandidate = null;
      this.peerConnection.ontrack = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.oniceconnectionstatechange = null;
      try { this.peerConnection.close(); } catch (e) {}
      this.peerConnection = null;
    }
    if (this.remoteStream) {
      this.remoteStream.getTracks().forEach(track => track.stop());
      this.remoteStream = null;
    }
  }

  /**
   * Optimize WebRTC Opus SDP for resilient, smooth broadcast-quality 48kHz audio
   * Configures 20ms frame pacing, inband FEC, DTX disabled, and optimal bitrate
   */
  _optimizeOpusSDP(sdp) {
    if (!sdp) return sdp;
    let lines = sdp.split('\r\n');
    let opusPayloadType = null;
    let rtpmapIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('a=rtpmap:') && lines[i].toLowerCase().includes('opus/48000')) {
        const match = lines[i].match(/a=rtpmap:(\d+)\s+opus\/48000/i);
        if (match) {
          opusPayloadType = match[1];
          rtpmapIndex = i;
        }
      }
    }

    if (opusPayloadType) {
      let fmtpFound = false;
      const cleanParams = [
        'minptime=20',
        'ptime=20',
        'maxptime=40',
        'useinbandfec=1',
        'usedtx=0',
        'maxaveragebitrate=128000',
        'cbr=0',
        'stereo=1',
        'sprop-stereo=1',
        'maxplaybackrate=48000',
        'sprop-maxcapturerate=48000'
      ];

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith(`a=fmtp:${opusPayloadType}`)) {
          fmtpFound = true;
          lines[i] = `a=fmtp:${opusPayloadType} ${cleanParams.join(';')}`;
        }
      }
      if (!fmtpFound && rtpmapIndex !== -1) {
        lines.splice(rtpmapIndex + 1, 0, `a=fmtp:${opusPayloadType} ${cleanParams.join(';')}`);
      }
    }
    return lines.join('\r\n');
  }
}

window.RTCManager = RTCManager;
