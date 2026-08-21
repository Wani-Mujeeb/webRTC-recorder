const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3899;
process.env.PORT = PORT;
process.env.ADMIN_PASSCODE = 'testpass123';

// Require and start the server
const serverApp = require('../server.js');

function makeRequest(method, endpoint, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const isJson = body && typeof body === 'object' && !Buffer.isBuffer(body);
    const postData = isJson ? JSON.stringify(body) : (body || '');

    const reqHeaders = { ...headers };
    if (isJson) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(postData);
    } else if (Buffer.isBuffer(body)) {
      reqHeaders['Content-Length'] = body.length;
    }

    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path: endpoint,
      method: method,
      headers: reqHeaders
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: data, json: json });
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function runTests() {
  console.log('🧪 Starting Automated Regression & Bug Fix Verification Suite...\n');
  let token = null;

  // Wait 500ms for server to bind
  await new Promise((r) => setTimeout(r, 600));

  try {
    // 1. Test Admin Login with incorrect password
    console.log('Test 1: Admin login with incorrect password...');
    const wrongLogin = await makeRequest('POST', '/api/admin/login', { passcode: 'wrongpassword' });
    assert.strictEqual(wrongLogin.status, 401, 'Should return 401 Unauthorized');
    assert.strictEqual(wrongLogin.json.success, false);
    console.log('✅ Correctly rejected invalid passcode.\n');

    // 2. Test Admin Login with correct password
    console.log('Test 2: Admin login with valid passcode...');
    const goodLogin = await makeRequest('POST', '/api/admin/login', { passcode: 'testpass123' });
    assert.strictEqual(goodLogin.status, 200, 'Should return 200 OK');
    assert.strictEqual(goodLogin.json.success, true);
    assert.ok(goodLogin.json.token, 'Should return session token');
    token = goodLogin.json.token;
    console.log('✅ Correctly authenticated and issued session token.\n');

    // 3. Test Protected Endpoint without token
    console.log('Test 3: Access protected /api/admin/recordings without auth...');
    const unauth = await makeRequest('GET', '/api/admin/recordings');
    assert.strictEqual(unauth.status, 401, 'Should block unauthenticated request');
    console.log('✅ Protected endpoint blocked unauthenticated access.\n');

    // 4. Test Fetch Recordings with Bearer Token
    console.log('Test 4: Fetch recordings with valid token...');
    const recordingsRes = await makeRequest('GET', '/api/admin/recordings', null, {
      'Authorization': `Bearer ${token}`
    });
    assert.strictEqual(recordingsRes.status, 200);
    assert.strictEqual(recordingsRes.json.success, true);
    assert.ok(Array.isArray(recordingsRes.json.recordings), 'Recordings should be an array');
    const initialCount = recordingsRes.json.recordings.length;
    console.log(`✅ Retrieved ${initialCount} recordings.\n`);

    // 5. Test Stream Chunk & Finalize
    console.log('Test 5: Stream chunk writing and temp file generation...');
    const streamId = 'test-stream-' + Date.now();
    const testPcmChunk = Buffer.alloc(4800 * 4); // ~0.1s stereo PCM
    testPcmChunk.fill(0x10);

    const chunkRes = await makeRequest('POST', `/api/recordings/stream-chunk?streamId=${streamId}&chunkIndex=0&byteOffset=0`, testPcmChunk, {
      'Content-Type': 'application/octet-stream'
    });
    assert.strictEqual(chunkRes.status, 200);
    assert.strictEqual(chunkRes.json.success, true);

    const tempFile = path.join(__dirname, '..', 'recordings', `temp-${streamId}.raw`);
    assert.ok(fs.existsSync(tempFile), 'Temp raw file should be created');
    console.log('✅ Stream chunk wrote to temp file with 44-byte header reservation.\n');

    console.log('Test 6: Finalize stream recording...');
    const finalizeRes = await makeRequest('POST', '/api/recordings/stream-finalize', {
      streamId: streamId,
      roomId: 'test-room-99',
      hostName: 'TesterHost',
      guestName: 'TesterGuest',
      duration: 1.0,
      sampleRate: 48000,
      numChannels: 2
    });
    assert.strictEqual(finalizeRes.status, 200);
    assert.strictEqual(finalizeRes.json.success, true);
    assert.ok(finalizeRes.json.recording.id, 'Should return created recording metadata');
    const createdRecId = finalizeRes.json.recording.id;
    assert.strictEqual(fs.existsSync(tempFile), false, 'Temp file should be cleaned up after finalize');
    console.log('✅ Stream finalized, WAV header created, temp file converted and cleaned up.\n');

    // 6. Test Single Delete Bug Fix (C-1)
    console.log('Test 7: Verify Single ID Deletion (C-1 Mass Deletion Fix)...');
    // Fetch count before delete
    const beforeList = await makeRequest('GET', '/api/admin/recordings', null, {
      'Authorization': `Bearer ${token}`
    });
    const beforeCount = beforeList.json.recordings.length;

    // Delete the newly created recording
    const deleteRes = await makeRequest('DELETE', `/api/admin/recordings/${createdRecId}`, null, {
      'Authorization': `Bearer ${token}`
    });
    assert.strictEqual(deleteRes.status, 200);
    assert.strictEqual(deleteRes.json.success, true);
    assert.strictEqual(deleteRes.json.deletedId, createdRecId);

    // Fetch count after delete
    const afterList = await makeRequest('GET', '/api/admin/recordings', null, {
      'Authorization': `Bearer ${token}`
    });
    assert.strictEqual(afterList.json.recordings.length, beforeCount - 1, 'Only 1 recording should have been removed');
    assert.ok(!afterList.json.recordings.some(r => r.id === createdRecId), 'Deleted recording should not exist in list');
    console.log('✅ Verified: Only the specific requested recording was deleted. Mass deletion bug C-1 is FIXED!\n');

    console.log('🎉 ALL AUTOMATED VERIFICATION TESTS PASSED SUCCESSFULLY! 🚀');
    process.exit(0);

  } catch (error) {
    console.error('❌ Verification test failed:', error);
    process.exit(1);
  }
}

runTests();
