/**
 * DualChannelWavRecorder
 * Captures Local Microphone (Left Channel / Ch 1) and Remote WebRTC Audio (Right Channel / Ch 2)
 * Encodes directly into an Uncompressed 16-Bit PCM Stereo WAV file format.
 */
class DualChannelWavRecorder {
  constructor() {
    this.audioCtx = null;
    this.localSource = null;
    this.remoteSource = null;
    this.mergerNode = null;
    this.processorNode = null;
    
    this.isRecording = false;
    this.leftChannelBuffers = [];
    this.rightChannelBuffers = [];
    this.recordingLength = 0; // Total sample frames recorded
    this.startTime = null;
    this.sampleRate = 44100;
  }

  /**
   * Start recording both streams into separate stereo channels
   * @param {MediaStream} localStream - Local Audio Stream
   * @param {MediaStream} remoteStream - Remote Audio Stream
   * @param {boolean} isHost - True if this client is the Host caller
   */
  async start(localStream, remoteStream, isHost = true) {
    if (this.isRecording) return;

    // Initialize Web Audio Context
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AudioCtx();
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

    // Create ScriptProcessor for capturing raw PCM buffers (bufferSize: 4096)
    const bufferSize = 4096;
    this.processorNode = this.audioCtx.createScriptProcessor(bufferSize, 2, 2);

    this.leftChannelBuffers = [];
    this.rightChannelBuffers = [];
    this.recordingLength = 0;
    this.startTime = Date.now();

    this.processorNode.onaudioprocess = (e) => {
      if (!this.isRecording) return;

      const inputBuffer = e.inputBuffer;
      const leftSamples = inputBuffer.getChannelData(0);
      const rightSamples = inputBuffer.getChannelData(1);

      // Clone samples so they aren't overwritten in WebAudio ring buffer
      this.leftChannelBuffers.push(new Float32Array(leftSamples));
      this.rightChannelBuffers.push(new Float32Array(rightSamples));
      this.recordingLength += leftSamples.length;
    };

    // Connect node chain (Connect to destination so audio processor fires)
    this.mergerNode.connect(this.processorNode);
    // Connect processor to destination through a gain node set to 0 to prevent echo if needed,
    // or silence node so processor receives audio ticks without double-playing
    const silentGain = this.audioCtx.createGain();
    silentGain.gain.value = 0;
    this.processorNode.connect(silentGain);
    silentGain.connect(this.audioCtx.destination);

    this.isRecording = true;
    console.log(`[WAV Recorder] Recording started at ${this.sampleRate}Hz (Stereo PCM WAV)`);
  }

  /**
   * Stop recording and compile uncompressed WAV file Blob
   * @returns {Promise<{blob: Blob, duration: number, sampleRate: number, fileSize: number}>}
   */
  async stop() {
    if (!this.isRecording) return null;

    this.isRecording = false;
    const duration = (Date.now() - this.startTime) / 1000;

    // Disconnect audio nodes
    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode.onaudioprocess = null;
    }
    if (this.mergerNode) {
      this.mergerNode.disconnect();
    }
    if (this.audioCtx) {
      await this.audioCtx.close();
    }

    console.log(`[WAV Recorder] Recording stopped. Duration: ${duration.toFixed(2)}s. Compiling WAV file...`);

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
      numChannels: 2
    };
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
