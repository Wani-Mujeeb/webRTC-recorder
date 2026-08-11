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
app.use(cors());
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
    const validMimeTypes = ['audio/wav', 'audio/wave', 'audio/x-wav', 'audio/x-pn-wav'];
    const isWavExt = file.originalname && file.originalname.toLowerCase().endsWith('.wav');
    if (validMimeTypes.includes(file.mimetype) || isWavExt) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file format. Only uncompressed WAV audio files are allowed.'));
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
      
      const recordingEntry = {
        id: recordingId,
        filename: req.file.filename,
        originalName: req.file.originalname || req.file.filename,
        filePath: req.file.path,
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

      console.log(`[Upload Success] Saved dual-channel WAV recording ${req.file.filename} (${(req.file.size / 1024 / 1024).toFixed(2)} MB)`);

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

// Download/Stream raw stereo WAV file (Protected)
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

  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Content-Disposition', `inline; filename="${rec.filename}"`);
  fs.createReadStream(filePath).pipe(res);
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

    const channelName = targetChannel === 1 ? 'Host-Left' : 'Guest-Right';
    const downloadFilename = rec.filename.replace('.wav', `-${channelName}.wav`);

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);

    // Stream mono header and transformed PCM stream memory-efficiently
    res.write(monoWavHeader);

    const fileStream = fs.createReadStream(filePath, {
      start: dataOffset,
      end: dataOffset + dataSize - 1,
      highWaterMark: 64 * 1024
    });

    const channelTransform = new MonoChannelTransform(targetChannel);

    fileStream.pipe(channelTransform).pipe(res);

  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (e) {}
    }
    console.error('Error streaming split channel WAV:', err);
    res.status(500).send('Error extracting audio channel stream.');
  }
});

// Delete recording (Protected)
app.delete('/api/admin/recordings/:id', requireAdminAuth, (req, res) => {
  const { id } = req.params;
  let recordings = getRecordingsMetadata();
  const rec = recordings.find(r => r.id === id);

  if (!rec) {
    return res.status(404).json({ success: false, message: 'Recording not found.' });
  }

  // Delete file from disk
  const filePath = path.join(RECORDINGS_DIR, rec.filename);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error('Failed to delete file from disk:', err);
    }
  }

  // Remove from metadata
  recordings = recordings.filter(r => r.id !== id);
  saveRecordingsMetadata(recordings);

  res.json({ success: true, message: 'Recording deleted successfully.' });
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
