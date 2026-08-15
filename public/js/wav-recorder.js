/**
 * DualChannelWavRecorder
 * Captures Local Microphone (Left Channel / Ch 1) and Remote WebRTC Audio (Right Channel / Ch 2)
 * Encodes directly into an Uncompressed 16-Bit PCM Stereo WAV file format.
 */
class DualChannelWavRecorder {
  constructor() {
    this.audioCtx = null;
    this.ownsAudioCtx = false;
    this.localSource = null;
    this.remoteSource = null;
    this.mergerNode = null;
    this.workletNode = null;
    this.processorNode = null;
    
    this.isRecording = false;
    this.leftChannelBuffers = [];
    this.rightChannelBuffers = [];
    this.recordingLength = 0; // Total sample frames recorded
    this.startTime = null;
    this.sampleRate = 48000;

    // Background streaming properties
    this.streamId = null;
    this.chunkIndex = 0;
    this.sentSampleOffset = 0;
    this.streamTimer = null;
    this.streamOptions = null;
    this.isStreamActive = false;
  }

  /**
   * Start recording both streams into separate stereo channels
   * @param {MediaStream} localStream - Local Audio Stream
   * @param {MediaStream} remoteStream - Remote Audio Stream
   * @param {boolean} isHost - True if this client is the Host caller
   * @param {AudioContext} [sharedAudioCtx] - Shared Audio Context instance
   * @param {Object} [streamOptions] - Options for parallel stream uploading
   */
  async start(localStream, remoteStream, isHost = true, sharedAudioCtx = null, streamOptions = null) {
    if (this.isRecording) return;

    // Initialize or reuse Web Audio Context
    if (sharedAudioCtx) {
      this.audioCtx = sharedAudioCtx;
      this.ownsAudioCtx = false;
    } else {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtx({ sampleRate: 48000, latencyHint: 'interactive' });
      this.ownsAudioCtx = true;
    }

    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
    this.sampleRate = this.audioCtx.sampleRate;

    if (localStream && localStream.getAudioTracks().length > 0) {
      this.localSource = this.audioCtx.createMediaStreamSource(localStream);
    }

    if (remoteStream && remoteStream.getAudioTracks().length > 0) {
      this.remoteSource = this.audioCtx.createMediaStreamSource(remoteStream);
    }

    this.leftChannelBuffers = [];
    this.rightChannelBuffers = [];
    this.recordingLength = 0;
    this.startTime = Date.now();

    // Setup parallel streaming if streamOptions provided
    this.streamOptions = streamOptions;
    if (streamOptions && streamOptions.roomId) {
      this.streamId = 'str-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
      this.chunkIndex = 0;
      this.sentSampleOffset = 0;
      this.isStreamActive = true;

      // Asynchronously stream audio chunks every 1 second in background for near real-time upload
      this.streamTimer = setInterval(() => {
        this._streamNextChunk(false).catch(e => console.warn('[WAV Stream Chunk Error]', e));
      }, 1000);
    }

    // Try AudioWorklet first for off-main-thread processing, fallback to ScriptProcessor
    let workletSuccess = false;
    if (this.audioCtx.audioWorklet) {
      try {
        const workletCode = `
          class DualChannelProcessor extends AudioWorkletProcessor {
            process(inputs) {
              const in0 = inputs[0];
              const in1 = inputs[1];

              const ch0 = (in0 && in0.length > 0) ? in0[0] : null;
              const ch1 = (in1 && in1.length > 0) ? in1[0] : null;

              const len = ch0 ? ch0.length : (ch1 ? ch1.length : 128);

              const left = new Float32Array(len);
              const right = new Float32Array(len);

              if (ch0) left.set(ch0);
              if (ch1) right.set(ch1);

              // Anti-pop NaN / Infinity filtering
              for (let i = 0; i < len; i++) {
                if (isNaN(left[i]) || !isFinite(left[i])) left[i] = 0;
                if (isNaN(right[i]) || !isFinite(right[i])) right[i] = 0;
              }

              // Atomically transfer memory ownership (Zero Memory Race Conditions)
              this.port.postMessage(
                { left: left, right: right },
                [left.buffer, right.buffer]
              );
              return true;
            }
          }
          registerProcessor('dual-channel-processor', DualChannelProcessor);
        `;
        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const workletUrl = URL.createObjectURL(blob);
        await this.audioCtx.audioWorklet.addModule(workletUrl);
        URL.revokeObjectURL(workletUrl);

        this.workletNode = new AudioWorkletNode(this.audioCtx, 'dual-channel-processor', {
          numberOfInputs: 2,
          numberOfOutputs: 1,
          outputChannelCount: [2]
        });

        this.workletNode.port.onmessage = (e) => {
          if (!this.isRecording) return;
          const { left, right } = e.data;
          this.leftChannelBuffers.push(left);
          this.rightChannelBuffers.push(right);
          this.recordingLength += left.length;
        };

        // Direct multi-input connection (Host -> Left Input 0, Guest -> Right Input 1)
        const hostInputIdx = 0;
        const guestInputIdx = 1;

        if (this.localSource) {
          const localInputTarget = isHost ? hostInputIdx : guestInputIdx;
          this.localSource.connect(this.workletNode, 0, localInputTarget);
        }

        if (this.remoteSource) {
          const remoteInputTarget = isHost ? guestInputIdx : hostInputIdx;
          this.remoteSource.connect(this.workletNode, 0, remoteInputTarget);
        }

        const silentGain = this.audioCtx.createGain();
        silentGain.gain.value = 0;
        this.workletNode.connect(silentGain);
        silentGain.connect(this.audioCtx.destination);
        workletSuccess = true;
      } catch (err) {
        console.warn('[WAV Recorder] AudioWorklet setup failed, using optimized ScriptProcessor:', err);
      }
    }

    if (!workletSuccess) {
      this.mergerNode = this.audioCtx.createChannelMerger(2);
      const localChannelIndex = isHost ? 0 : 1;
      const remoteChannelIndex = isHost ? 1 : 0;

      if (this.localSource) {
        this.localSource.connect(this.mergerNode, 0, localChannelIndex);
      }
      if (this.remoteSource) {
        this.remoteSource.connect(this.mergerNode, 0, remoteChannelIndex);
      }

      const bufferSize = 4096;
      this.processorNode = this.audioCtx.createScriptProcessor(bufferSize, 2, 2);
      this.processorNode.onaudioprocess = (e) => {
        if (!this.isRecording) return;
        const inputBuffer = e.inputBuffer;
        const leftSamples = inputBuffer.getChannelData(0);
        const rightSamples = inputBuffer.getChannelData(1);
        this.leftChannelBuffers.push(new Float32Array(leftSamples));
        this.rightChannelBuffers.push(new Float32Array(rightSamples));
        this.recordingLength += leftSamples.length;
      };
      this.mergerNode.connect(this.processorNode);
      const silentGain = this.audioCtx.createGain();
      silentGain.gain.value = 0;
      this.processorNode.connect(silentGain);
      silentGain.connect(this.audioCtx.destination);
    }

    this.isRecording = true;
    console.log(`[WAV Recorder] Recording started at ${this.sampleRate}Hz (Stereo PCM WAV, Worklet: ${workletSuccess}, Streaming: ${this.isStreamActive})`);
  }

  /**
   * Stop recording and compile uncompressed WAV file Blob
   * @returns {Promise<{blob: Blob|null, duration: number, sampleRate: number, fileSize: number, serverRecording: Object|null}>}
   */
  async stop() {
    if (!this.isRecording) return null;

    this.isRecording = false;
    const duration = (Date.now() - this.startTime) / 1000;

    if (this.streamTimer) {
      clearInterval(this.streamTimer);
      this.streamTimer = null;
    }

    // Flush any remaining audio chunk before finalizing stream
    if (this.isStreamActive && this.streamId) {
      await this._streamNextChunk(true).catch(e => console.warn('[Final Chunk Stream Error]', e));
    }

    // Disconnect audio nodes
    if (this.workletNode) {
      this.workletNode.disconnect();
      if (this.workletNode.port) this.workletNode.port.onmessage = null;
      this.workletNode = null;
    }
    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode.onaudioprocess = null;
      this.processorNode = null;
    }
    if (this.localSource) {
      this.localSource.disconnect();
      this.localSource = null;
    }
    if (this.remoteSource) {
      this.remoteSource.disconnect();
      this.remoteSource = null;
    }
    if (this.mergerNode) {
      this.mergerNode.disconnect();
      this.mergerNode = null;
    }
    if (this.audioCtx && this.ownsAudioCtx) {
      await this.audioCtx.close();
      this.audioCtx = null;
    }

    console.log(`[WAV Recorder] Recording stopped. Duration: ${duration.toFixed(2)}s.`);

    let serverRecording = null;
    if (this.isStreamActive && this.streamId) {
      try {
        const serverUrl = window.location.protocol === 'file:' ? 'http://localhost:3000' : '';
        const res = await fetch(`${serverUrl}/api/recordings/stream-finalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          body: JSON.stringify({
            streamId: this.streamId,
            roomId: this.streamOptions ? this.streamOptions.roomId : 'Room',
            hostName: this.streamOptions ? this.streamOptions.hostName : 'Host',
            guestName: this.streamOptions ? this.streamOptions.guestName : 'Guest',
            duration: duration,
            sampleRate: this.sampleRate,
            numChannels: 2
          })
        });
        const finalizeJson = await res.json();
        if (finalizeJson.success) {
          serverRecording = finalizeJson.recording;
          console.log('[WAV Streamer] Call ended & stream finalized instantly on server!');
          // Fast Return - bypass heavy client-side WAV encoding when server stream finalized successfully!
          return {
            blob: null,
            duration: duration,
            sampleRate: this.sampleRate,
            fileSize: serverRecording ? serverRecording.fileSize : 0,
            numChannels: 2,
            serverRecording: serverRecording
          };
        }
      } catch (err) {
        console.warn('[WAV Streamer] Stream finalization failed, fallback to full upload:', err);
      }
    }

    // Fallback: Flatten left and right Float32 buffers into single continuous arrays
    const leftBuffer = this._flattenBuffers(this.leftChannelBuffers, this.recordingLength);
    const rightBuffer = this._flattenBuffers(this.rightChannelBuffers, this.recordingLength);

    // Encode to 16-bit uncompressed PCM stereo WAV
    const wavBuffer = this._encodeWAV(leftBuffer, rightBuffer, this.sampleRate);
    const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });

    return {
      blob: wavBlob,
      duration: duration,
      sampleRate: this.sampleRate,
      fileSize: wavBlob.size,
      numChannels: 2,
      serverRecording: serverRecording
    };
  }

  /**
   * Dynamically attach remote WebRTC stream to right audio channel
   */
  attachRemoteStream(remoteStream) {
    if (!this.audioCtx || !remoteStream || remoteStream.getAudioTracks().length === 0) return;
    if (this.remoteSource) return;

    try {
      this.remoteSource = this.audioCtx.createMediaStreamSource(remoteStream);
      const guestInputIdx = this.isHost ? 1 : 0;
      if (this.workletNode) {
        this.remoteSource.connect(this.workletNode, 0, guestInputIdx);
      } else if (this.mergerNode) {
        this.remoteSource.connect(this.mergerNode, 0, guestInputIdx);
      }
      console.log('[WAV Recorder] Dynamically attached remote stream to channel 2');
    } catch (err) {
      console.warn('[WAV Recorder] Error attaching remote stream:', err);
    }
  }

  /**
   * Non-blocking background chunk streaming
   * @param {boolean} [force=false] - Force flush all remaining unsent frames
   */
  async _streamNextChunk(force = false) {
    if (!this.isStreamActive || !this.streamId) return;

    const currentTotal = this.recordingLength;
    const unsentFrames = currentTotal - this.sentSampleOffset;

    // Send chunk if force is true or if we have at least ~0.05s of unsent audio (2,400 frames)
    if (!force && unsentFrames < 2400) return;
    if (unsentFrames <= 0) return;

    const startOffset = this.sentSampleOffset;
    this.sentSampleOffset = currentTotal;

    const leftSlice = this._sliceBuffer(this.leftChannelBuffers, startOffset, currentTotal);
    const rightSlice = this._sliceBuffer(this.rightChannelBuffers, startOffset, currentTotal);

    if (!leftSlice || leftSlice.length === 0) return;

    const pcmBuffer = this._encodeRawPCM(leftSlice, rightSlice);
    const currentChunkIdx = this.chunkIndex++;

    try {
      const serverUrl = window.location.protocol === 'file:' ? 'http://localhost:3000' : '';
      await fetch(`${serverUrl}/api/recordings/stream-chunk?streamId=${this.streamId}&chunkIndex=${currentChunkIdx}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        keepalive: true,
        body: pcmBuffer
      });
    } catch (err) {
      console.warn(`[WAV Streamer] Background chunk ${currentChunkIdx} upload failed (will retry/finalize):`, err);
    }
  }

  _sliceBuffer(channelBuffers, startFrame, endFrame) {
    const totalLength = endFrame - startFrame;
    if (totalLength <= 0) return new Float32Array(0);

    const result = new Float32Array(totalLength);
    let currentFrame = 0;
    let writeOffset = 0;

    for (let i = 0; i < channelBuffers.length; i++) {
      const buf = channelBuffers[i];
      const bufStart = currentFrame;
      const bufEnd = currentFrame + buf.length;

      if (bufEnd > startFrame && bufStart < endFrame) {
        const sliceStart = Math.max(0, startFrame - bufStart);
        const sliceEnd = Math.min(buf.length, endFrame - bufStart);
        const sub = buf.subarray(sliceStart, sliceEnd);
        result.set(sub, writeOffset);
        writeOffset += sub.length;
      }
      currentFrame = bufEnd;
      if (currentFrame >= endFrame) break;
    }
    return result;
  }

  _encodeRawPCM(leftChannel, rightChannel) {
    const numChannels = 2;
    const bytesPerSample = 2; // 16-bit PCM = 2 bytes
    const length = leftChannel.length;
    const dataSize = length * numChannels * bytesPerSample;
    const buffer = new ArrayBuffer(dataSize);
    const view = new DataView(buffer);

    let offset = 0;
    for (let i = 0; i < length; i++) {
      let lVal = leftChannel[i];
      let rVal = rightChannel[i] || 0;

      if (isNaN(lVal) || !isFinite(lVal)) lVal = 0;
      if (isNaN(rVal) || !isFinite(rVal)) rVal = 0;

      // Left channel sample (-1.0 to 1.0 -> -32768 to 32767)
      let sLeft = Math.max(-1, Math.min(1, lVal));
      sLeft = sLeft < 0 ? Math.floor(sLeft * 0x8000) : Math.floor(sLeft * 0x7FFF);
      view.setInt16(offset, sLeft, true);
      offset += 2;

      // Right channel sample
      let sRight = Math.max(-1, Math.min(1, rVal));
      sRight = sRight < 0 ? Math.floor(sRight * 0x8000) : Math.floor(sRight * 0x7FFF);
      view.setInt16(offset, sRight, true);
      offset += 2;
    }
    return buffer;
  }

  /**
   * Flatten array of Float32Array chunks into a single Float32Array
   */
  _flattenBuffers(channelBuffers, recordingLength) {
    const result = new Float32Array(recordingLength);
    let offset = 0;
    for (let i = 0; i < channelBuffers.length; i++) {
      result.set(channelBuffers[i], offset);
      offset += channelBuffers[i].length;
    }
    return result;
  }

  /**
   * Encode 2-channel Float32 audio data into 16-Bit Uncompressed PCM RIFF WAVE ArrayBuffer
   */
  _encodeWAV(leftChannel, rightChannel, sampleRate) {
    const numChannels = 2;
    const bytesPerSample = 2; // 16-bit PCM = 2 bytes
    const blockAlign = numChannels * bytesPerSample; // 4 bytes
    const length = leftChannel.length;
    const dataSize = length * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // 1. RIFF Header
    this._writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true); // ChunkSize
    this._writeString(view, 8, 'WAVE');

    // 2. fmt Subchunk
    this._writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true);  // AudioFormat (1 = Uncompressed PCM)
    view.setUint16(22, numChannels, true); // 2 Channels (Left: Local, Right: Remote)
    view.setUint32(24, sampleRate, true); // SampleRate
    view.setUint32(28, sampleRate * blockAlign, true); // ByteRate
    view.setUint16(32, blockAlign, true); // BlockAlign
    view.setUint16(34, 16, true); // BitsPerSample

    // 3. data Subchunk
    this._writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Interleave left and right Float32 samples and convert to 16-bit PCM Signed Integer (-32768 to 32767)
    let offset = 44;
    for (let i = 0; i < length; i++) {
      let lVal = leftChannel[i];
      let rVal = rightChannel[i] || 0;

      if (isNaN(lVal) || !isFinite(lVal)) lVal = 0;
      if (isNaN(rVal) || !isFinite(rVal)) rVal = 0;

      // Left channel sample
      let sLeft = Math.max(-1, Math.min(1, lVal));
      sLeft = sLeft < 0 ? Math.floor(sLeft * 0x8000) : Math.floor(sLeft * 0x7FFF);
      view.setInt16(offset, sLeft, true);
      offset += 2;

      // Right channel sample
      let sRight = Math.max(-1, Math.min(1, rVal));
      sRight = sRight < 0 ? Math.floor(sRight * 0x8000) : Math.floor(sRight * 0x7FFF);
      view.setInt16(offset, sRight, true);
      offset += 2;
    }

    return buffer;
  }

  _writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }
}

// Export global instance or class
window.DualChannelWavRecorder = DualChannelWavRecorder;
