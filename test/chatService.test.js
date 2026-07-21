const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createConversation, sendMessage, listMessages } = require('../src/chatService');

test('chat service stores encrypted messages and decrypts them correctly', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'psycure-chat-'));
  process.env.PSYCURE_CHAT_STORAGE_DIR = tempDir;
  process.env.CHAT_MASTER_KEY = 'test-master-key-32-bytes-long!!';

  const conversation = createConversation({
    sessionId: 'session-123',
    patientId: 'patient-1',
    therapistId: 'therapist-1',
    patientAlias: 'Alice',
    therapistAlias: 'Dr. Bob',
  });

  assert.equal(conversation.sessionId, 'session-123');
  assert.equal(conversation.participants.patientId, 'patient-1');

  const savedMessage = sendMessage({
    sessionId: 'session-123',
    senderRole: 'patient',
    senderId: 'patient-1',
    content: 'Hello, I am feeling better today.',
  });

  const messages = listMessages('session-123');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].senderRole, 'patient');
  assert.equal(messages[0].content, 'Hello, I am feeling better today.');

  const storedFile = path.join(tempDir, 'session-123.json');
  const rawData = fs.readFileSync(storedFile, 'utf8');
  assert.ok(rawData.includes('encryptedContent'));
  assert.ok(!rawData.includes('Hello, I am feeling better today.'));
});
