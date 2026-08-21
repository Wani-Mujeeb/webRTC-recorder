const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const cors = require('cors');
const { Transform } = require('stream');

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
    let trimmed = line.trim();
    if (trimmed.startsWith('export ')) {
      trimmed = trimmed.substring(7).trim();
    }
    if (trimmed && !trimmed.startsWith('#')) {
      const firstEquals = trimmed.indexOf('=');
      if (firstEquals !== -1) {
        const key = trimmed.substring(0, firstEquals).trim();
        let value = trimmed.substring(firstEquals + 1).trim();
        // Remove surrounding single or double quotes
        value = value.replace(/^["']|["']$/g, '');
        if (key && !process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  });
}

const PORT = parseInt(process.env.PORT, 10) || 3000;
// Default admin passcode - configurable via environment variable
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || 'admin123';
if (!process.env.ADMIN_PASSCODE || process.env.ADMIN_PASSCODE === 'admin123') {
  console.warn('⚠️  [Security Warning] Using default ADMIN_PASSCODE ("admin123"). Set ADMIN_PASSCODE in .env for production.');
}

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

// In-memory Rate Limiting for Admin Login (max 5 failed attempts / min per IP)
const loginAttempts = new Map(); // ip -> { count: number, firstAttempt: number, blockedUntil: number }

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed: true };

  if (entry.blockedUntil && now < entry.blockedUntil) {
    const remainingSec = Math.ceil((entry.blockedUntil - now) / 1000);
    return { allowed: false, remainingSec };
  }

  // Reset window if 60 seconds elapsed
  if (now - entry.firstAttempt > 60000) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }

  if (entry.count >= 5) {
    entry.blockedUntil = now + 60000; // block for 1 minute
    return { allowed: false, remainingSec: 60 };
  }

  return { allowed: true };
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now, blockedUntil: 0 });
  } else {
    entry.count++;
  }
}

function resetLoginRateLimit(ip) {
  loginAttempts.delete(ip);
}

// Cleanup expired admin tokens and rate-limit maps every hour
setInterval(() => {
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  for (const [token, createdAt] of activeAdminTokens.entries()) {
    if (now - createdAt > ONE_DAY) {
      activeAdminTokens.delete(token);
    }
  }
  for (const [ip, entry] of loginAttempts.entries()) {
    if (now - entry.firstAttempt > 300000 && now > (entry.blockedUntil || 0)) {
      loginAttempts.delete(ip);
    }
  }
}, 60 * 60 * 1000);

// Serialized async lock for metadata file writing to prevent race conditions
let metadataWriteQueue = Promise.resolve();

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

// Helper to write metadata atomically via serialized queue
async function saveRecordingsMetadata(recordings) {
  metadataWriteQueue = metadataWriteQueue.then(async () => {
    try {
      const tempFile = `${METADATA_FILE}.tmp.${crypto.randomUUID()}`;
      fs.writeFileSync(tempFile, JSON.stringify(recordings, null, 2), 'utf8');
      try {
        fs.renameSync(tempFile, METADATA_FILE);
      } catch (renameErr) {
        // Fallback for Windows EPERM file locking
        fs.copyFileSync(tempFile, METADATA_FILE);
        try { fs.unlinkSync(tempFile); } catch (e) {}
      }
    } catch (err) {
      console.error('Error writing metadata file:', err);
    }
  });
  return metadataWriteQueue;
}

// Security Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Middleware
app.use(cors({
  exposedHeaders: ['Content-Disposition', 'Content-Length', 'Accept-Ranges', 'Content-Range']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Dedicated Admin Portal Route
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Configure Multer for WAV file uploads with strict validation
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, RECORDINGS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + crypto.randomBytes(6).toString('hex');
    cb(null, `call-rec-${uniqueSuffix}.wav`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max limit
  fileFilter: (req, file, cb) => {
    const validMimeTypes = [
      'audio/wav', 'audio/wave', 'audio/x-wav', 'audio/x-pn-wav',
      'audio/vnd.wave', 'audio/pcm', 'audio/raw'
    ];
    const isWavExt = file.originalname && file.originalname.toLowerCase().endsWith('.wav');
    if (validMimeTypes.includes(file.mimetype) || (file.mimetype === 'application/octet-stream' && isWavExt) || isWavExt) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file format. Only audio WAV files are allowed.'));
    }
  }
});

// Admin authentication middleware (supports Authorization Header or x-admin-token)
function requireAdminAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : req.headers['x-admin-token'];

  // Support query token fallback for direct browser media streams if needed
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
    if (this.remainder.length >= this.channelOffset + 2) {
      const monoBuf = Buffer.allocUnsafe(2);
      monoBuf.writeInt16LE(this.remainder.readInt16LE(this.channelOffset), 0);
      this.push(monoBuf);
    }
    callback();
  }
}

// -------------------------------------------------------------
// PUBLIC & RECORDING API ENDPOINTS
// -------------------------------------------------------------

// Helper to generate clear, unique filenames based on callers, date, time, and room ID
function generateMeaningfulFilename(hostName, guestName, roomId) {
  const safeHost = String(hostName || 'Host').trim().replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
  const safeGuest = String(guestName || 'Guest').trim().replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
  const safeRoom = String(roomId || 'Room').trim().replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  const timestamp = `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
  let baseFilename = `Call_${safeHost}_vs_${safeGuest}_${timestamp}_${safeRoom}.wav`;
  
  // Ensure uniqueness if a file with the exact name already exists
  if (fs.existsSync(path.join(RECORDINGS_DIR, baseFilename))) {
    const randomSuffix = crypto.randomBytes(3).toString('hex');
    baseFilename = `Call_${safeHost}_vs_${safeGuest}_${timestamp}_${safeRoom}_${randomSuffix}.wav`;
  }

  return baseFilename;
}

// Upload dual-channel uncompressed WAV recording
app.post('/api/recordings/upload', (req, res) => {
  upload.single('audio')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message || 'File upload failed.' });
    }
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No audio file uploaded.' });
      }

      const { roomId, hostName, guestName, duration, sampleRate, numChannels, streamId } = req.body;
      const recordingId = crypto.randomUUID();

      // Clean up any background chunk temp file if streamId was passed
      if (streamId) {
        const safeStreamId = String(streamId).replace(/[^a-zA-Z0-9-]/g, '');
        if (safeStreamId) {
          const tempFilePath = path.join(RECORDINGS_DIR, `temp-${safeStreamId}.raw`);
          if (fs.existsSync(tempFilePath)) {
            try {
              fs.unlinkSync(tempFilePath);
              console.log(`[Upload Cleanup] Cleaned up real-time stream temp file: temp-${safeStreamId}.raw`);
            } catch (e) {}
          }
        }
      }

      // Rename uploaded file to meaningful name
      const finalFilename = generateMeaningfulFilename(hostName, guestName, roomId);
      const finalFilePath = path.join(RECORDINGS_DIR, finalFilename);
      let actualFilename = req.file.filename;

      try {
        fs.renameSync(req.file.path, finalFilePath);
        actualFilename = finalFilename;
      } catch (e) {
        console.warn('Could not rename uploaded file, retaining original:', e);
      }

      const relativePath = path.join('recordings', actualFilename).replace(/\\/g, '/');
      
      const recordingEntry = {
        id: recordingId,
        filename: actualFilename,
        originalName: actualFilename,
        filePath: relativePath,
        fileSize: req.file.size,
        roomId: String(roomId || 'Unknown Room').trim().substring(0, 60),
        hostName: String(hostName || 'Host').trim().substring(0, 50),
        guestName: String(guestName || 'Guest').trim().substring(0, 50),
        duration: parseFloat(duration) || 0,
        sampleRate: parseInt(sampleRate, 10) || 48000,
        numChannels: parseInt(numChannels, 10) || 2,
        format: 'WAVE uncompressed PCM 16-bit',
        channelInfo: {
          left: 'Host / Local Caller',
          right: 'Guest / Remote Caller'
        },
        createdAt: new Date().toISOString()
      };

      const recordings = getRecordingsMetadata();
      recordings.unshift(recordingEntry);
      await saveRecordingsMetadata(recordings);

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

    const safeStreamId = String(streamId).replace(/[^a-zA-Z0-9-]/g, '');
    if (!safeStreamId) {
      return res.status(400).json({ success: false, message: 'Invalid stream identifier.' });
    }

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
app.post('/api/recordings/stream-finalize', express.json(), async (req, res) => {
  try {
    const { streamId, roomId, hostName, guestName, duration, sampleRate, numChannels } = req.body;
    if (!streamId) {
      return res.status(400).json({ success: false, message: 'Missing streamId.' });
    }

    const safeStreamId = String(streamId).replace(/[^a-zA-Z0-9-]/g, '');
    if (!safeStreamId) {
      return res.status(400).json({ success: false, message: 'Invalid stream identifier.' });
    }

    const tempFilePath = path.join(RECORDINGS_DIR, `temp-${safeStreamId}.raw`);

    if (!fs.existsSync(tempFilePath)) {
      return res.status(404).json({ success: false, message: 'No stream chunks found for this session.' });
    }

    const rawStat = fs.statSync(tempFilePath);
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

    const completeFinalize = async () => {
      const recordingId = crypto.randomUUID();
      const relativePath = path.join('recordings', finalFilename).replace(/\\/g, '/');

      const recordingEntry = {
        id: recordingId,
        filename: finalFilename,
        originalName: finalFilename,
        filePath: relativePath,
        fileSize: 44 + rawDataSize,
        roomId: String(roomId || 'Unknown Room').trim().substring(0, 60),
        hostName: String(hostName || 'Host').trim().substring(0, 50),
        guestName: String(guestName || 'Guest').trim().substring(0, 50),
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
      await saveRecordingsMetadata(recordings);

      console.log(`[Stream Finalize Success] Instantly finalized WAV recording ${finalFilename} (${((44 + rawDataSize) / 1024 / 1024).toFixed(2)} MB)`);

      res.json({
        success: true,
        message: 'Parallel stream recording finalized successfully.',
        recording: recordingEntry
      });
    };

    // Overwrite header in-place at byte offset 0 (0ms disk copy time)
    try {
      const fd = fs.openSync(tempFilePath, 'r+');
      fs.writeSync(fd, wavHeader, 0, 44, 0);
      fs.closeSync(fd);
      fs.renameSync(tempFilePath, finalFilePath);
      await completeFinalize();
    } catch (inPlaceErr) {
      console.warn('In-place header write failed, fallback to file copy:', inPlaceErr);
      const writeStream = fs.createWriteStream(finalFilePath);
      writeStream.write(wavHeader);
      const readStream = fs.createReadStream(tempFilePath, { start: 44 });
      readStream.pipe(writeStream);
      writeStream.on('finish', async () => {
        try { fs.unlinkSync(tempFilePath); } catch (e) {}
        await completeFinalize();
      });
      writeStream.on('error', (wsErr) => {
        console.error('Error writing fallback stream:', wsErr);
        res.status(500).json({ success: false, message: 'Failed to write final recording.' });
      });
    }

  } catch (err) {
    console.error('Error finalizing stream upload:', err);
    res.status(500).json({ success: false, message: 'Server error during stream finalization.' });
  }
});

// -------------------------------------------------------------
// SECURE ADMIN API ENDPOINTS (PASSCODE PROTECTED SERVER-SIDE)
// -------------------------------------------------------------

// Admin login - Passcode validation strictly on server side with constant-time check & rate limiting
app.post('/api/admin/login', (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  const rateLimitStatus = checkLoginRateLimit(clientIp);

  if (!rateLimitStatus.allowed) {
    return res.status(429).json({
      success: false,
      message: `Too many failed login attempts. Please wait ${rateLimitStatus.remainingSec} seconds.`
    });
  }

  const { passcode } = req.body;
  
  if (!passcode) {
    return res.status(400).json({ success: false, message: 'Passcode is required.' });
  }

  // Constant-time comparison using fixed-size SHA-256 HMACs to eliminate timing side-channels
  const hmacKey = 'callwave-auth-hmac-salt';
  const targetHash = crypto.createHmac('sha256', hmacKey).update(ADMIN_PASSCODE).digest();
  const inputHash = crypto.createHmac('sha256', hmacKey).update(String(passcode)).digest();

  const isMatch = crypto.timingSafeEqual(targetHash, inputHash);

  if (!isMatch) {
    recordFailedLogin(clientIp);
    return res.status(401).json({
      success: false,
      message: 'Incorrect admin passcode.'
    });
  }

  resetLoginRateLimit(clientIp);

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

  const safeFilename = path.basename(rec.filename);
  const filePath = path.join(RECORDINGS_DIR, safeFilename);
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

    if (start >= fileSize || end >= fileSize || start > end) {
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
      'Content-Disposition': `${dispositionType}; filename="${safeFilename}"`
    });
    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'audio/wav',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `${dispositionType}; filename="${safeFilename}"`
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

  const safeFilename = path.basename(rec.filename);
  const filePath = path.join(RECORDINGS_DIR, safeFilename);
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
    let sampleRate = 48000;
    let bitsPerSample = 16;

    let offset = 12;
    while (offset + 8 <= bytesRead) {
      const subchunkId = headerBuf.toString('ascii', offset, offset + 4);
      const subchunkSize = headerBuf.readUInt32LE(offset + 4);

      if (subchunkId === 'fmt ' && offset + 24 <= bytesRead) {
        numChannels = headerBuf.readUInt16LE(offset + 10);
        sampleRate = headerBuf.readUInt32LE(offset + 12);
        bitsPerSample = headerBuf.readUInt16LE(offset + 22);
      } else if (subchunkId === 'data') {
        dataOffset = offset + 8;
        dataSize = subchunkSize;
        break;
      }

      const paddedSize = subchunkSize + (subchunkSize % 2);
      offset += 8 + paddedSize;
    }

    const stat = fs.statSync(filePath);
    if (dataOffset === -1 || numChannels !== 2 || bitsPerSample !== 16) {
      res.setHeader('Content-Type', 'audio/wav');
      return fs.createReadStream(filePath).pipe(res);
    }

    // Clamp dataSize to actual file size on disk
    dataSize = Math.min(dataSize, Math.max(0, stat.size - dataOffset));

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
    const downloadFilename = safeFilename.replace('.wav', `-${channelName}.wav`);

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

      if (start < 44) {
        const headerEnd = Math.min(43, end);
        const headerSlice = monoWavHeader.subarray(start, headerEnd + 1);
        res.write(headerSlice);
      }

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
    if (!res.headersSent) {
      res.status(500).send('Error extracting audio channel stream.');
    }
  }
});

// Delete single recording securely (Protected) - FIX C-1: ONLY deletes the specific recording ID
app.delete('/api/admin/recordings/:id', requireAdminAuth, async (req, res) => {
  const { id } = req.params;
  let recordings = getRecordingsMetadata();
  const targetRec = recordings.find(r => r.id === id);

  if (!targetRec) {
    return res.status(404).json({ success: false, message: 'Recording not found.' });
  }

  // Delete only the physical audio file for this specific recording
  const safeFilename = path.basename(targetRec.filename);
  const audioFilePath = path.join(RECORDINGS_DIR, safeFilename);

  if (fs.existsSync(audioFilePath)) {
    try {
      fs.unlinkSync(audioFilePath);
      console.log(`[Delete Success] Deleted audio file: ${audioFilePath}`);
    } catch (err) {
      console.error(`[Delete Warning] Could not unlink ${audioFilePath}:`, err.message);
    }
  }

  // Remove the single recording from metadata
  recordings = recordings.filter(r => r.id !== id);
  await saveRecordingsMetadata(recordings);

  console.log(`[Delete Success] Deleted recording entry (ID: ${id}, Filename: ${safeFilename})`);

  res.json({
    success: true,
    message: 'Recording deleted successfully.',
    deletedId: id
  });
});

// -------------------------------------------------------------
// WEBRTC SOCKET.IO SIGNALING
// -------------------------------------------------------------

// Active room state tracking: roomId -> Map(socketId -> { socketId, username, isHost, joinedAt })
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`[Socket Connected] ID: ${socket.id}`);

  // Join a call room
  socket.on('join-room', ({ roomId, username, isHost }) => {
    const safeRoomId = String(roomId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 64) || 'default-room';
    const safeUsername = String(username || '').trim().substring(0, 50) || (isHost ? 'Host' : 'Guest');

    socket.join(safeRoomId);
    socket.roomId = safeRoomId;
    socket.username = safeUsername;

    if (!rooms.has(safeRoomId)) {
      rooms.set(safeRoomId, new Map());
    }
    const roomUsers = rooms.get(safeRoomId);

    // If room is empty, first person joining becomes the effective host / designated offerer
    const effectiveIsHost = roomUsers.size === 0 ? true : !!isHost;
    socket.isHost = effectiveIsHost;

    roomUsers.set(socket.id, {
      socketId: socket.id,
      username: socket.username,
      isHost: socket.isHost,
      joinedAt: Date.now()
    });

    console.log(`[Room Join] ${socket.username} (${socket.id}, Host: ${socket.isHost}) joined room: ${safeRoomId}. Total users: ${roomUsers.size}`);

    // Notify other users in the room
    socket.to(safeRoomId).emit('user-connected', {
      socketId: socket.id,
      username: socket.username,
      isHost: socket.isHost
    });

    // Send existing users list to the newly connected user
    const existingUsers = [];
    roomUsers.forEach((userData, id) => {
      if (id !== socket.id) {
        existingUsers.push(userData);
      }
    });
    socket.emit('room-users', existingUsers);
  });

  // Relay WebRTC Offer
  socket.on('signal-offer', ({ targetSocketId, offer, callerName }) => {
    if (!targetSocketId || !offer) return;
    console.log(`[Signal] Offer sent from ${socket.username || socket.id} -> target ${targetSocketId}`);
    io.to(targetSocketId).emit('signal-offer', {
      senderSocketId: socket.id,
      offer,
      callerName: socket.username || callerName || 'Peer'
    });
  });

  // Relay WebRTC Answer
  socket.on('signal-answer', ({ targetSocketId, answer }) => {
    if (!targetSocketId || !answer) return;
    console.log(`[Signal] Answer sent from ${socket.username || socket.id} -> target ${targetSocketId}`);
    io.to(targetSocketId).emit('signal-answer', {
      senderSocketId: socket.id,
      answer
    });
  });

  // Relay WebRTC ICE Candidate
  socket.on('signal-ice-candidate', ({ targetSocketId, candidate }) => {
    if (!targetSocketId || !candidate) return;
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
        isMuted: !!isMuted
      });
    }
  });

  // End Call signal
  socket.on('end-call', () => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('call-ended-by-peer', {
        socketId: socket.id,
        username: socket.username || 'Peer'
      });
    }
  });

  // Handle Disconnect
  socket.on('disconnect', () => {
    console.log(`[Socket Disconnected] ${socket.username || 'Anonymous'} (${socket.id})`);
    if (socket.roomId && rooms.has(socket.roomId)) {
      const roomUsers = rooms.get(socket.roomId);
      roomUsers.delete(socket.id);
      if (roomUsers.size === 0) {
        rooms.delete(socket.roomId);
      } else {
        socket.to(socket.roomId).emit('user-disconnected', {
          socketId: socket.id,
          username: socket.username || 'Peer'
        });
      }
    }
  });
});

// Start HTTP & WebSocket Server with error handling
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use. Please terminate existing process or configure PORT in .env`);
  } else {
    console.error('❌ Server startup error:', err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Call Recorder Server running on http://localhost:${PORT}`);
  console.log(`🔒 Admin Auth: Server-side passcode protection active.`);
  console.log(`🎙️ Dual-Channel Uncompressed WAV recorder ready.`);
  console.log(`=======================================================`);
});
