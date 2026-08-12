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

    // Create 2-Channel Merger
    // Channel 0 (Left) -> Host Audio
    // Channel 1 (Right) -> Guest Audio
    this.mergerNode = this.audioCtx.createChannelMerger(2);

    const localChannelIndex = isHost ? 0 : 1;  // Host mic -> Ch 0, Guest mic -> Ch 1
    const remoteChannelIndex = isHost ? 1 : 0; // Host remote -> Ch 1, Guest remote -> Ch 0

    if (localStream && localStream.getAudioTracks().length > 0) {
      this.localSource = this.audioCtx.createMediaStreamSource(localStream);
      this.localSource.connect(this.mergerNode, 0, localChannelIndex);
    }

    if (remoteStream && remoteStream.getAudioTracks().length > 0) {
      this.remoteSource = this.audioCtx.createMediaStreamSource(remoteStream);
      this.remoteSource.connect(this.mergerNode, 0, remoteChannelIndex);
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

      // Asynchronously stream audio chunks every 4 seconds in background
      this.streamTimer = setInterval(() => {
        this._streamNextChunk().catch(e => console.warn('[WAV Stream Chunk Error]', e));
      }, 4000);
    }

    // Try AudioWorklet first for off-main-thread processing, fallback to ScriptProcessor
    let workletSuccess = false;
    if (this.audioCtx.audioWorklet) {
      try {
        const workletCode = `
          class DualChannelProcessor extends AudioWorkletProcessor {
            process(inputs, outputs) {
              const input = inputs[0];
              if (input && input.length > 0) {
                const ch0 = input[0];
                const ch1 = input[1];
                const len = ch0 ? ch0.length : 128;
                const left = ch0 || new Float32Array(len);
                const right = ch1 || new Float32Array(len);
                this.port.postMessage({
                  left: left,
                  right: right
                });
              }
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
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2]
        });

        this.workletNode.port.onmessage = (e) => {
          if (!this.isRecording) return;
          const { left, right } = e.data;
          this.leftChannelBuffers.push(new Float32Array(left));
          this.rightChannelBuffers.push(new Float32Array(right));
          this.recordingLength += left.length;
        };

        this.mergerNode.connect(this.workletNode);
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
   * @returns {Promise<{blob: Blob, duration: number, sampleRate: number, fileSize: number, serverRecording: Object|null}>}
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
      await this._streamNextChunk().catch(e => console.warn('[Final Chunk Stream Error]', e));
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

    console.log(`[WAV Recorder] Recording stopped. Duration: ${duration.toFixed(2)}s. Compiling WAV file...`);

    let serverRecording = null;
    if (this.isStreamActive && this.streamId) {
      try {
        const serverUrl = window.location.protocol === 'file:' ? 'http://localhost:3000' : '';
        const res = await fetch(`${serverUrl}/api/recordings/stream-finalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
          console.log('[WAV Streamer] Call ended & stream finalized instantly in background!');
        }
      } catch (err) {
        console.warn('[WAV Streamer] Stream finalization failed, fallback to full upload:', err);
      }
    }

    // Flatten left and right Float32 buffers into single continuous arrays
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
   * Non-blocking background chunk streaming
   */
  async _streamNextChunk() {
    if (!this.isStreamActive || !this.streamId) return;

    const currentTotal = this.recordingLength;
    const unsentFrames = currentTotal - this.sentSampleOffset;

    // Send chunk if we have at least 0.25 seconds of unsent audio (12,000 frames)
    if (unsentFrames < 12000) return;

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
      // Left channel sample
      let sLeft = Math.max(-1, Math.min(1, leftChannel[i]));
      sLeft = sLeft < 0 ? sLeft * 0x8000 : sLeft * 0x7FFF;
      view.setInt16(offset, sLeft, true);
      offset += 2;

      // Right channel sample
      let sRight = Math.max(-1, Math.min(1, rightChannel[i] || 0));
      sRight = sRight < 0 ? sRight * 0x8000 : sRight * 0x7FFF;
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
      // Left channel sample
      let sLeft = Math.max(-1, Math.min(1, leftChannel[i]));
      sLeft = sLeft < 0 ? sLeft * 0x8000 : sLeft * 0x7FFF;
      view.setInt16(offset, sLeft, true);
      offset += 2;

      // Right channel sample
      let sRight = Math.max(-1, Math.min(1, rightChannel[i]));
      sRight = sRight < 0 ? sRight * 0x8000 : sRight * 0x7FFF;
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
