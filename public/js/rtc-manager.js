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

    // Callbacks
    this.onRemoteStreamAdded = options.onRemoteStreamAdded || null;
    this.onUserJoined = options.onUserJoined || null;
    this.onUserLeft = options.onUserLeft || null;
    this.onCallEnded = options.onCallEnded || null;
    this.onConnectionStateChange = options.onConnectionStateChange || null;

    // Standard Multi-region STUN configuration
    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
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

    // 1. Get Local Microphone Audio Stream
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
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
      throw new Error('Socket.IO client library not loaded. Please open http://localhost:3000 in your browser.');
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

    this.socket.on('user-connected', async ({ socketId, username, isHost }) => {
      console.log(`[RTC] User connected: ${username} (${socketId})`);
      this.targetSocketId = socketId;
      if (this.onUserJoined) this.onUserJoined({ socketId, username, isHost });

      // Host initiates the WebRTC offer when a guest connects
      if (this.isHost) {
        await this._createPeerConnection(socketId);
        const offer = await this.peerConnection.createOffer({
          offerToReceiveAudio: true
        });
        await this.peerConnection.setLocalDescription(offer);

        this.socket.emit('signal-offer', {
          targetSocketId: socketId,
          offer: offer,
          callerName: this.username
        });
      }
    });

    this.socket.on('signal-offer', async ({ senderSocketId, offer, callerName }) => {
      console.log(`[RTC] Received offer from ${callerName} (${senderSocketId})`);
      this.targetSocketId = senderSocketId;
      
      await this._createPeerConnection(senderSocketId);
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      await this._flushIceCandidateQueue();

      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);

      this.socket.emit('signal-answer', {
        targetSocketId: senderSocketId,
        answer: answer
      });
    });

    this.socket.on('signal-answer', async ({ senderSocketId, answer }) => {
      console.log(`[RTC] Received answer from ${senderSocketId}`);
      if (this.peerConnection) {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        await this._flushIceCandidateQueue();
      }
    });

    this.socket.on('signal-ice-candidate', async ({ senderSocketId, candidate }) => {
      if (this.peerConnection && candidate) {
        if (this.peerConnection.remoteDescription && this.peerConnection.remoteDescription.type) {
          try {
            await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (err) {
            console.error('Error adding ICE candidate:', err);
          }
        } else {
          console.log('[RTC] Remote description not set yet. Queuing ICE candidate.');
          this.iceCandidateQueue.push(candidate);
        }
      }
    });

    this.socket.on('user-disconnected', ({ socketId, username }) => {
      console.log(`[RTC] Peer disconnected: ${username}`);
      this._closePeerConnection();
      if (this.onUserLeft) this.onUserLeft({ socketId, username });
    });

    this.socket.on('call-ended-by-peer', ({ socketId, username }) => {
      console.log(`[RTC] Peer ended call: ${username}`);
      this._closePeerConnection();
      if (this.onCallEnded) this.onCallEnded({ socketId, username });
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
        try {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error('Error adding queued ICE candidate:', err);
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

    // Add local mic tracks to peer connection
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        this.peerConnection.addTrack(track, this.localStream);
      });
    }

    // Handle incoming remote audio tracks
    this.peerConnection.ontrack = (event) => {
      console.log('[RTC] Remote track received:', event.track.kind);
      if (event.streams && event.streams[0]) {
        event.streams[0].getTracks().forEach(track => {
          this.remoteStream.addTrack(track);
        });
      } else {
        this.remoteStream.addTrack(event.track);
      }

      if (this.onRemoteStreamAdded) {
        this.onRemoteStreamAdded(this.remoteStream);
      }
    };

    // Send ICE candidates to signaling server
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('signal-ice-candidate', {
          targetSocketId: targetSocketId,
          candidate: event.candidate
        });
      }
    };

    // Connection state monitor
    this.peerConnection.onconnectionstatechange = () => {
      console.log('[RTC] Connection State:', this.peerConnection.connectionState);
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(this.peerConnection.connectionState);
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
      this.socket.emit('end-call');
      this.socket.disconnect();
    }
    this._closePeerConnection();

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
  }

  _closePeerConnection() {
    this.iceCandidateQueue = [];
    if (this.peerConnection) {
      this.peerConnection.onicecandidate = null;
      this.peerConnection.ontrack = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }
    if (this.remoteStream) {
      this.remoteStream.getTracks().forEach(track => track.stop());
      this.remoteStream = null;
    }
  }
}

window.RTCManager = RTCManager;
