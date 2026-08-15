const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Load environment variables from .env file if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, 'utf8');
  envConfig.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const firstEquals = trimmed.indexOf('=');
      if (firstEquals !== -1) {
        const key = trimmed.substring(0, firstEquals).trim();
        const value = trimmed.substring(firstEquals + 1).trim().replace(/^["']|["']$/g, '');
        if (key && !process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  });
}

const PORT = process.env.PORT || 3000;
// Default admin passcode - configurable via environment variable
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || 'admin123';

// Direct paths
const DATA_DIR = path.join(__dirname, 'data');
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const METADATA_FILE = path.join(DATA_DIR, 'recordings.json');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}
if (!fs.existsSync(METADATA_FILE)) {
  fs.writeFileSync(METADATA_FILE, JSON.stringify([], null, 2));
}

// In-memory active session tokens for admin auth (with 24h expiration timestamp)
const activeAdminTokens = new Map(); // token -> timestamp

// Cleanup expired admin tokens every hour
setInterval(() => {
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  for (const [token, createdAt] of activeAdminTokens.entries()) {
    if (now - createdAt > ONE_DAY) {
      activeAdminTokens.delete(token);
    }
  }
}, 60 * 60 * 1000);

// Helper to read metadata
function getRecordingsMetadata() {
  try {
    if (!fs.existsSync(METADATA_FILE)) {
      return [];
    }
    const data = fs.readFileSync(METADATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading metadata file:', err);
    return [];
  }
}

// Helper to write metadata atomically
function saveRecordingsMetadata(recordings) {
  try {
    const tempFile = `${METADATA_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify(recordings, null, 2));
    fs.renameSync(tempFile, METADATA_FILE);
  } catch (err) {
    console.error('Error writing metadata file:', err);
  }
}

// Middleware
app.use(cors({
  exposedHeaders: ['Content-Disposition', 'Content-Length', 'Accept-Ranges', 'Content-Range']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Dedicated Admin Portal Route
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Configure Multer for WAV file uploads with strict MIME filtering
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, RECORDINGS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `call-rec-${uniqueSuffix}.wav`);
  }
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max limit
  fileFilter: (req, file, cb) => {
    const validMimeTypes = [
      'audio/wav', 'audio/wave', 'audio/x-wav', 'audio/x-pn-wav',
      'audio/vnd.wave', 'application/octet-stream', 'audio/pcm', 'audio/raw', ''
    ];
    const isWavExt = !file.originalname || file.originalname.toLowerCase().endsWith('.wav');
    if (validMimeTypes.includes(file.mimetype) || isWavExt) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file format. Only audio WAV files are allowed.'));
    }
  }
});

// Admin authentication middleware (supports Header, x-admin-token, or query parameter)
function requireAdminAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : req.headers['x-admin-token'];

  if (!token && req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token || !activeAdminTokens.has(token)) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: Admin authentication required.'
    });
  }
  next();
}

// Stream Transform for Extracting Mono Left (1) or Right (2) PCM Channel
const { Transform } = require('stream');

class MonoChannelTransform extends Transform {
  constructor(channel) { // 1 = Left (Host), 2 = Right (Guest)
    super();
    this.channelOffset = (channel - 1) * 2;
    this.remainder = Buffer.alloc(0);
  }

  _transform(chunk, encoding, callback) {
    let buf = chunk;
    if (this.remainder.length > 0) {
      buf = Buffer.concat([this.remainder, chunk]);
      this.remainder = Buffer.alloc(0);
    }

    const numStereoFrames = Math.floor(buf.length / 4);
    const remainderBytes = buf.length % 4;
    if (remainderBytes > 0) {
      this.remainder = buf.subarray(buf.length - remainderBytes);
    }

    if (numStereoFrames > 0) {
      const monoBuf = Buffer.allocUnsafe(numStereoFrames * 2);
      for (let i = 0; i < numStereoFrames; i++) {
        const srcIdx = i * 4 + this.channelOffset;
        monoBuf.writeInt16LE(buf.readInt16LE(srcIdx), i * 2);
      }
      this.push(monoBuf);
    }
    callback();
  }

  _flush(callback) {
    if (this.remainder.length >= 2) {
      const monoBuf = Buffer.allocUnsafe(2);
      monoBuf.writeInt16LE(this.remainder.readInt16LE(0), 0);
      this.push(monoBuf);
    }
    callback();
  }
}

// -------------------------------------------------------------
// PUBLIC & RECORDING API ENDPOINTS
// -------------------------------------------------------------

// Helper to generate clear, meaningful filenames based on callers, date, time, and room ID
function generateMeaningfulFilename(hostName, guestName, roomId) {
  const safeHost = String(hostName || 'Host').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeGuest = String(guestName || 'Guest').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeRoom = String(roomId || 'Room').trim().replace(/[^a-zA-Z0-9_-]/g, '_');

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  const timestamp = `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
  return `Call_${safeHost}_vs_${safeGuest}_${timestamp}_${safeRoom}.wav`;
}

// Upload dual-channel uncompressed WAV recording
app.post('/api/recordings/upload', (req, res) => {
  upload.single('audio')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message || 'File upload failed.' });
    }
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No audio file uploaded.' });
      }

      const { roomId, hostName, guestName, duration, sampleRate, numChannels } = req.body;
      const recordingId = crypto.randomUUID();

      // Rename uploaded file to meaningful name
      const finalFilename = generateMeaningfulFilename(hostName, guestName, roomId);
      const finalFilePath = path.join(RECORDINGS_DIR, finalFilename);
      try {
        fs.renameSync(req.file.path, finalFilePath);
      } catch (e) {
        console.warn('Could not rename uploaded file, retaining original:', e);
      }

      const actualFilePath = fs.existsSync(finalFilePath) ? finalFilePath : req.file.path;
      const actualFilename = fs.existsSync(finalFilePath) ? finalFilename : req.file.filename;
      
      const recordingEntry = {
        id: recordingId,
        filename: actualFilename,
        originalName: actualFilename,
        filePath: actualFilePath,
        fileSize: req.file.size,
        roomId: roomId || 'Unknown Room',
        hostName: hostName || 'Host',
        guestName: guestName || 'Guest',
        duration: parseFloat(duration) || 0,
        sampleRate: parseInt(sampleRate) || 44100,
        numChannels: parseInt(numChannels) || 2,
        format: 'WAVE uncompressed PCM 16-bit',
        channelInfo: {
          left: 'Host / Local Caller',
          right: 'Guest / Remote Caller'
        },
        createdAt: new Date().toISOString()
      };

      const recordings = getRecordingsMetadata();
      recordings.unshift(recordingEntry);
      saveRecordingsMetadata(recordings);

      console.log(`[Upload Success] Saved dual-channel WAV recording ${actualFilename} (${(req.file.size / 1024 / 1024).toFixed(2)} MB)`);

      res.json({
        success: true,
        message: 'Recording saved successfully.',
        recording: recordingEntry
      });
    } catch (error) {
      console.error('Error handling upload:', error);
      res.status(500).json({ success: false, message: 'Server error during recording upload.' });
    }
  });
});

// Upload real-time audio chunk in background during active call
app.post('/api/recordings/stream-chunk', express.raw({ type: ['application/octet-stream', 'audio/wav', 'audio/pcm'], limit: '20mb' }), (req, res) => {
  try {
    const streamId = req.query.streamId || req.headers['x-stream-id'];
    const chunkIndex = parseInt(req.query.chunkIndex || req.headers['x-chunk-index'] || '0', 10);
    const rawByteOffset = req.query.byteOffset || req.headers['x-chunk-offset'];
    const byteOffset = rawByteOffset !== undefined ? parseInt(rawByteOffset, 10) : -1;

    if (!streamId || !req.body || req.body.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid chunk data or missing streamId.' });
    }

    const safeStreamId = streamId.replace(/[^a-zA-Z0-9-]/g, '');
    const tempFilePath = path.join(RECORDINGS_DIR, `temp-${safeStreamId}.raw`);

    // Reserve 44 bytes at beginning of temp file for instant 0ms header writing on finalization
    if (!fs.existsSync(tempFilePath)) {
      const dummyHeader = Buffer.alloc(44);
      fs.writeFileSync(tempFilePath, dummyHeader);
    }

    if (byteOffset >= 0) {
      // Write chunk to exact frame offset in PCM raw audio stream
      const fd = fs.openSync(tempFilePath, 'r+');
      fs.writeSync(fd, req.body, 0, req.body.length, 44 + byteOffset);
      fs.closeSync(fd);
    } else {
      fs.appendFileSync(tempFilePath, req.body);
    }

    res.json({
      success: true,
      message: `Chunk ${chunkIndex} received.`,
      bytesReceived: req.body.length
    });
  } catch (err) {
    console.error('Error saving stream chunk:', err);
    res.status(500).json({ success: false, message: 'Failed to write stream chunk.' });
  }
});

// Finalize parallel audio stream upload instantly with in-place WAV header update
app.post('/api/recordings/stream-finalize', express.json(), (req, res) => {
  try {
    const { streamId, roomId, hostName, guestName, duration, sampleRate, numChannels } = req.body;
    if (!streamId) {
      return res.status(400).json({ success: false, message: 'Missing streamId.' });
    }

    const safeStreamId = streamId.replace(/[^a-zA-Z0-9-]/g, '');
    const tempFilePath = path.join(RECORDINGS_DIR, `temp-${safeStreamId}.raw`);

    if (!fs.existsSync(tempFilePath)) {
      return res.status(404).json({ success: false, message: 'No stream chunks found for this session.' });
    }

    const rawStat = fs.statSync(tempFilePath);
    // Raw PCM data size excluding the 44-byte reserved header space
    const rawDataSize = rawStat.size >= 44 ? rawStat.size - 44 : 0;

    const finalFilename = generateMeaningfulFilename(hostName, guestName, roomId);
    const finalFilePath = path.join(RECORDINGS_DIR, finalFilename);

    const targetSampleRate = parseInt(sampleRate, 10) || 48000;
    const targetChannels = parseInt(numChannels, 10) || 2;
    const bytesPerSample = 2; // 16-bit PCM
    const blockAlign = targetChannels * bytesPerSample; // 4 bytes for stereo
    const byteRate = targetSampleRate * blockAlign;

    // Create 44-Byte RIFF WAV Header
    const wavHeader = Buffer.alloc(44);
    wavHeader.write('RIFF', 0);
    wavHeader.writeUInt32LE(36 + rawDataSize, 4);
    wavHeader.write('WAVE', 8);
    wavHeader.write('fmt ', 12);
    wavHeader.writeUInt32LE(16, 16);             // Subchunk1Size (16 for PCM)
    wavHeader.writeUInt16LE(1, 20);              // AudioFormat (1 = Uncompressed PCM)
    wavHeader.writeUInt16LE(targetChannels, 22); // NumChannels (2)
    wavHeader.writeUInt32LE(targetSampleRate, 24);// SampleRate
    wavHeader.writeUInt32LE(byteRate, 28);       // ByteRate
    wavHeader.writeUInt16LE(blockAlign, 32);     // BlockAlign
    wavHeader.writeUInt16LE(16, 34);             // BitsPerSample (16)
    wavHeader.write('data', 36);
    wavHeader.writeUInt32LE(rawDataSize, 40);

    // Overwrite header in-place at byte offset 0 (0ms disk copy time)
    try {
      const fd = fs.openSync(tempFilePath, 'r+');
      fs.writeSync(fd, wavHeader, 0, 44, 0);
      fs.closeSync(fd);
      fs.renameSync(tempFilePath, finalFilePath);
    } catch (inPlaceErr) {
      console.warn('In-place header write failed, fallback to file copy:', inPlaceErr);
      const writeStream = fs.createWriteStream(finalFilePath);
      writeStream.write(wavHeader);
      const readStream = fs.createReadStream(tempFilePath, { start: 44 });
      readStream.pipe(writeStream);
      readStream.on('finish', () => {
        try { fs.unlinkSync(tempFilePath); } catch (e) {}
      });
    }

    const recordingId = crypto.randomUUID();
    const recordingEntry = {
      id: recordingId,
      filename: finalFilename,
      originalName: finalFilename,
      filePath: finalFilePath,
      fileSize: 44 + rawDataSize,
      roomId: roomId || 'Unknown Room',
      hostName: hostName || 'Host',
      guestName: guestName || 'Guest',
      duration: parseFloat(duration) || (rawDataSize / byteRate) || 0,
      sampleRate: targetSampleRate,
      numChannels: targetChannels,
      format: 'WAVE uncompressed PCM 16-bit',
      channelInfo: {
        left: 'Host / Local Caller',
        right: 'Guest / Remote Caller'
      },
      createdAt: new Date().toISOString()
    };

    const recordings = getRecordingsMetadata();
    recordings.unshift(recordingEntry);
    saveRecordingsMetadata(recordings);

    console.log(`[Stream Finalize Success] Instantly finalized WAV recording ${finalFilename} (${((44 + rawDataSize) / 1024 / 1024).toFixed(2)} MB)`);

    res.json({
      success: true,
      message: 'Parallel stream recording finalized successfully.',
      recording: recordingEntry
    });

  } catch (err) {
    console.error('Error finalizing stream upload:', err);
    res.status(500).json({ success: false, message: 'Server error during stream finalization.' });
  }
});

// -------------------------------------------------------------
// SECURE ADMIN API ENDPOINTS (PASSCODE PROTECTED SERVER-SIDE)
// -------------------------------------------------------------

// Admin login - Passcode validation strictly on server side
app.post('/api/admin/login', (req, res) => {
  const { passcode } = req.body;
  
  if (!passcode) {
    return res.status(400).json({ success: false, message: 'Passcode is required.' });
  }

  // Secure timing-safe string comparison to prevent timing attacks
  const targetBuffer = Buffer.from(ADMIN_PASSCODE);
  const inputBuffer = Buffer.from(String(passcode));

  let isMatch = false;
  if (targetBuffer.length === inputBuffer.length) {
    isMatch = crypto.timingSafeEqual(targetBuffer, inputBuffer);
  }

  if (!isMatch) {
    return res.status(401).json({
      success: false,
      message: 'Incorrect admin passcode.'
    });
  }

  // Generate secure random session token
  const sessionToken = crypto.randomBytes(32).toString('hex');
  activeAdminTokens.set(sessionToken, Date.now());

  res.json({
    success: true,
    message: 'Admin authenticated successfully.',
    token: sessionToken
  });
});

// Admin logout
app.post('/api/admin/logout', requireAdminAuth, (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : (req.headers['x-admin-token'] || req.query.token);
  
  if (token) {
    activeAdminTokens.delete(token);
  }
  res.json({ success: true, message: 'Logged out successfully.' });
});

// Verify token validity
app.get('/api/admin/verify', requireAdminAuth, (req, res) => {
  res.json({ success: true, authenticated: true });
});

// Fetch list of all recordings (Protected)
app.get('/api/admin/recordings', requireAdminAuth, (req, res) => {
  const recordings = getRecordingsMetadata();
  res.json({ success: true, recordings });
});

// Download/Stream raw stereo WAV file (Protected - Range 206 Streaming)
app.get('/api/admin/recordings/:id/file', requireAdminAuth, (req, res) => {
  const { id } = req.params;
  const recordings = getRecordingsMetadata();
  const rec = recordings.find(r => r.id === id);

  if (!rec) {
    return res.status(404).send('Recording not found.');
  }

  const filePath = path.join(RECORDINGS_DIR, rec.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Audio file missing on server.');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  const isDownload = req.query.dl === '1' || req.query.download === '1';
  const dispositionType = isDownload ? 'attachment' : 'inline';

  if (range && !isDownload) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).send('Requested Range Not Satisfiable');
    }

    const chunkSize = (end - start) + 1;
    const fileStream = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'audio/wav',
      'Content-Disposition': `${dispositionType}; filename="${rec.filename}"`
    });
    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'audio/wav',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `${dispositionType}; filename="${rec.filename}"`
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Download mono channel WAV file (Channel 1=Left / Channel 2=Right) (Streamed Memory-Efficient) (Protected)
app.get('/api/admin/recordings/:id/channel/:ch', requireAdminAuth, (req, res) => {
  const { id, ch } = req.params;
  const targetChannel = parseInt(ch, 10); // 1 = Left (Host), 2 = Right (Guest)

  if (targetChannel !== 1 && targetChannel !== 2) {
    return res.status(400).send('Invalid channel specified. Must be 1 (Left/Host) or 2 (Right/Guest).');
  }

  const recordings = getRecordingsMetadata();
  const rec = recordings.find(r => r.id === id);

  if (!rec) {
    return res.status(404).send('Recording not found.');
  }

  const filePath = path.join(RECORDINGS_DIR, rec.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Audio file missing on server.');
  }

  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const headerBuf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, headerBuf, 0, 4096, 0);
    fs.closeSync(fd);
    fd = null;

    if (bytesRead < 44 || headerBuf.toString('ascii', 0, 4) !== 'RIFF') {
      res.setHeader('Content-Type', 'audio/wav');
      return fs.createReadStream(filePath).pipe(res);
    }

    // Parse subchunks with proper word alignment
    let dataOffset = -1;
    let dataSize = 0;
    let numChannels = 2;
    let sampleRate = 44100;
    let bitsPerSample = 16;

    let offset = 12;
    while (offset + 8 <= bytesRead) {
      const subchunkId = headerBuf.toString('ascii', offset, offset + 4);
      const subchunkSize = headerBuf.readUInt32LE(offset + 4);

      if (subchunkId === 'fmt ') {
        numChannels = headerBuf.readUInt16LE(offset + 10);
        sampleRate = headerBuf.readUInt32LE(offset + 12);
        bitsPerSample = headerBuf.readUInt16LE(offset + 22);
      } else if (subchunkId === 'data') {
        dataOffset = offset + 8;
        dataSize = subchunkSize;
        break;
      }

      // Word alignment: subchunk payload padded to even number of bytes
      const paddedSize = subchunkSize + (subchunkSize % 2);
      offset += 8 + paddedSize;
    }

    if (dataOffset === -1 || numChannels !== 2 || bitsPerSample !== 16) {
      // Fallback: If single channel or non 16-bit, send raw file stream
      res.setHeader('Content-Type', 'audio/wav');
      return fs.createReadStream(filePath).pipe(res);
    }

    // Single Channel WAV Header Construction
    const monoDataSize = Math.floor(dataSize / 2);
    const monoChunkSize = 36 + monoDataSize;
    const byteRate = sampleRate * 2; // 1 channel * 2 bytes

    const monoWavHeader = Buffer.alloc(44);
    monoWavHeader.write('RIFF', 0);
    monoWavHeader.writeUInt32LE(monoChunkSize, 4);
    monoWavHeader.write('WAVE', 8);
    monoWavHeader.write('fmt ', 12);
    monoWavHeader.writeUInt32LE(16, 16); // Subchunk1Size
    monoWavHeader.writeUInt16LE(1, 20);  // AudioFormat (PCM)
    monoWavHeader.writeUInt16LE(1, 22);  // NumChannels = 1
    monoWavHeader.writeUInt32LE(sampleRate, 24);
    monoWavHeader.writeUInt32LE(byteRate, 28);
    monoWavHeader.writeUInt16LE(2, 32);  // BlockAlign
    monoWavHeader.writeUInt16LE(16, 34); // BitsPerSample
    monoWavHeader.write('data', 36);
    monoWavHeader.writeUInt32LE(monoDataSize, 40);

    const totalMonoFileSize = 44 + monoDataSize;
    const channelName = targetChannel === 1 ? 'Host-Left' : 'Guest-Right';
    const downloadFilename = rec.filename.replace('.wav', `-${channelName}.wav`);

    const isDownload = req.query.dl === '1' || req.query.download === '1';
    const dispositionType = isDownload ? 'attachment' : 'inline';
    const range = req.headers.range;

    if (range && !isDownload) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : totalMonoFileSize - 1;

      if (start >= totalMonoFileSize || end >= totalMonoFileSize || start > end) {
        res.setHeader('Content-Range', `bytes */${totalMonoFileSize}`);
        return res.status(416).send('Requested Range Not Satisfiable');
      }

      const chunkSize = (end - start) + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalMonoFileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'audio/wav',
        'Content-Disposition': `${dispositionType}; filename="${downloadFilename}"`
      });

      // Stream header slice if within byte offset 0-43
      if (start < 44) {
        const headerEnd = Math.min(43, end);
        const headerSlice = monoWavHeader.subarray(start, headerEnd + 1);
        res.write(headerSlice);
      }

      // Stream PCM payload slice if range extends past byte 43
      if (end >= 44) {
        const monoDataStart = Math.max(0, start - 44);
        const monoDataEnd = end - 44;
        const alignedMonoStart = monoDataStart - (monoDataStart % 2);
        const startSampleIdx = Math.floor(alignedMonoStart / 2);
        const endSampleIdx = Math.floor(monoDataEnd / 2);

        const stereoStartByte = dataOffset + (startSampleIdx * 4);
        const stereoEndByte = dataOffset + ((endSampleIdx + 1) * 4) - 1;

        const fileStream = fs.createReadStream(filePath, {
          start: stereoStartByte,
          end: Math.min(dataOffset + dataSize - 1, stereoEndByte),
          highWaterMark: 64 * 1024
        });

        const channelTransform = new MonoChannelTransform(targetChannel);
        fileStream.pipe(channelTransform).pipe(res);
      } else {
        res.end();
      }
    } else {
      res.writeHead(200, {
        'Content-Length': totalMonoFileSize,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'audio/wav',
        'Content-Disposition': `${dispositionType}; filename="${downloadFilename}"`
      });

      res.write(monoWavHeader);

      const fileStream = fs.createReadStream(filePath, {
        start: dataOffset,
        end: dataOffset + dataSize - 1,
        highWaterMark: 64 * 1024
      });

      const channelTransform = new MonoChannelTransform(targetChannel);

      fileStream.pipe(channelTransform).pipe(res);
    }
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (e) {}
    }
    console.error('Error streaming split channel WAV:', err);
    res.status(500).send('Error extracting audio channel stream.');
  }
});

// Delete recording and all recordings associated with that call (Protected)
app.delete('/api/admin/recordings/:id', requireAdminAuth, (req, res) => {
  const { id } = req.params;
  let recordings = getRecordingsMetadata();
  const targetRec = recordings.find(r => r.id === id);

  if (!targetRec) {
    return res.status(404).json({ success: false, message: 'Recording not found.' });
  }

  // Find all recordings associated with this call (by exact ID or matching non-generic roomId)
  const targetRoomId = targetRec.roomId;
  const toDelete = recordings.filter(r => {
    if (r.id === id) return true;
    if (targetRoomId && targetRoomId !== 'Unknown Room' && r.roomId === targetRoomId) return true;
    return false;
  });

  const deleteIds = new Set(toDelete.map(r => r.id));

  // Delete all physical audio files associated with the call
  toDelete.forEach(rec => {
    const filePathsToDelete = [
      rec.filePath,
      path.join(RECORDINGS_DIR, rec.filename)
    ];

    filePathsToDelete.forEach(fp => {
      if (fp && fs.existsSync(fp)) {
        try {
          fs.unlinkSync(fp);
          console.log(`[Delete Success] Deleted audio file: ${fp}`);
        } catch (err) {
          console.error(`[Delete Warning] Could not unlink ${fp}:`, err.message);
        }
      }
    });
  });

  // Also clean up any leftover temp files for this room ID or stream
  try {
    const files = fs.readdirSync(RECORDINGS_DIR);
    files.forEach(f => {
      if (f.startsWith('temp-') && targetRoomId && targetRoomId !== 'Unknown Room' && f.includes(targetRoomId)) {
        try {
          fs.unlinkSync(path.join(RECORDINGS_DIR, f));
        } catch (e) {}
      }
    });
  } catch (e) {}

  // Remove all associated recordings from metadata
  recordings = recordings.filter(r => !deleteIds.has(r.id));
  saveRecordingsMetadata(recordings);

  console.log(`[Delete Success] Deleted ${toDelete.length} recording entry/entries associated with call (Room: ${targetRoomId})`);

  res.json({
    success: true,
    message: `Deleted ${toDelete.length} recording(s) associated with this call.`,
    deletedCount: toDelete.length,
    deletedIds: Array.from(deleteIds)
  });
});

// -------------------------------------------------------------
// WEBRTC SOCKET.IO SIGNALING
// -------------------------------------------------------------

// Active room state tracking
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`[Socket Connected] ID: ${socket.id}`);

  // Join a call room
  socket.on('join-room', ({ roomId, username, isHost }) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = username || (isHost ? 'Host' : 'Guest');
    socket.isHost = !!isHost;

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    const roomUsers = rooms.get(roomId);
    roomUsers.add(socket.id);

    console.log(`[Room Join] ${socket.username} (${socket.id}) joined room: ${roomId}. Total users: ${roomUsers.size}`);

    // Notify other users in the room
    socket.to(roomId).emit('user-connected', {
      socketId: socket.id,
      username: socket.username,
      isHost: socket.isHost
    });

    // Send existing users list to the newly connected user
    const existingUsers = [];
    roomUsers.forEach(id => {
      if (id !== socket.id) {
        const s = io.sockets.sockets.get(id);
        if (s) {
          existingUsers.push({
            socketId: s.id,
            username: s.username,
            isHost: s.isHost
          });
        }
      }
    });
    socket.emit('room-users', existingUsers);
  });

  // Relay WebRTC Offer
  socket.on('signal-offer', ({ targetSocketId, offer, callerName }) => {
    console.log(`[Signal] Offer sent from ${socket.username} (${socket.id}) -> target ${targetSocketId}`);
    io.to(targetSocketId).emit('signal-offer', {
      senderSocketId: socket.id,
      offer,
      callerName: socket.username
    });
  });

  // Relay WebRTC Answer
  socket.on('signal-answer', ({ targetSocketId, answer }) => {
    console.log(`[Signal] Answer sent from ${socket.username} (${socket.id}) -> target ${targetSocketId}`);
    io.to(targetSocketId).emit('signal-answer', {
      senderSocketId: socket.id,
      answer
    });
  });

  // Relay WebRTC ICE Candidate
  socket.on('signal-ice-candidate', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('signal-ice-candidate', {
      senderSocketId: socket.id,
      candidate
    });
  });

  // Mute status broadcast
  socket.on('audio-toggle', ({ isMuted }) => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('peer-audio-toggle', {
        socketId: socket.id,
        isMuted
      });
    }
  });

  // End Call signal
  socket.on('end-call', () => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('call-ended-by-peer', {
        socketId: socket.id,
        username: socket.username
      });
    }
  });

  // Handle Disconnect
  socket.on('disconnect', () => {
    console.log(`[Socket Disconnected] ${socket.username} (${socket.id})`);
    if (socket.roomId && rooms.has(socket.roomId)) {
      const roomUsers = rooms.get(socket.roomId);
      roomUsers.delete(socket.id);
      if (roomUsers.size === 0) {
        rooms.delete(socket.roomId);
      } else {
        socket.to(socket.roomId).emit('user-disconnected', {
          socketId: socket.id,
          username: socket.username
        });
      }
    }
  });
});

// Start HTTP & WebSocket Server
server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Call Recorder Server running on http://localhost:${PORT}`);
  console.log(`🔒 Admin Auth: Server-side passcode protection active.`);
  console.log(`🎙️ Dual-Channel Uncompressed WAV recorder ready.`);
  console.log(`=======================================================`);
});
