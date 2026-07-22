const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function getStorageDir() {
  return process.env.PSYCURE_CHAT_STORAGE_DIR || path.join(process.cwd(), 'data', 'chat');
}

function getMasterKey() {
  const key = process.env.CHAT_MASTER_KEY;
  if (!key) {
    return crypto.createHash('sha256').update('default-dev-chat-key').digest();
  }
  return crypto.createHash('sha256').update(key).digest();
}

function ensureStorage() {
  fs.mkdirSync(getStorageDir(), { recursive: true });
}

function encryptText(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', getMasterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('hex'),
    encryptedContent: encrypted.toString('hex'),
  };
}

function decryptText(payload) {
  const iv = Buffer.from(payload.iv, 'hex');
  const encrypted = Buffer.from(payload.encryptedContent, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', getMasterKey(), iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function getConversationFile(sessionId) {
  ensureStorage();
  return path.join(getStorageDir(), `${sessionId}.json`);
}

function readConversation(sessionId) {
  const filePath = getConversationFile(sessionId);
  if (!fs.existsSync(filePath)) {
    return { sessionId, messages: [] };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    ...parsed,
    messages: (parsed.messages || []).map((message) => ({
      ...message,
      content: decryptText(message.contentPayload),
    })),
  };
}

function writeConversation(sessionId, conversation) {
  const filePath = getConversationFile(sessionId);
  fs.writeFileSync(filePath, JSON.stringify(conversation, null, 2));
}

function createConversation({ sessionId, patientId, therapistId, patientAlias, therapistAlias }) {
  const conversation = readConversation(sessionId);
  if (conversation.createdAt) {
    return conversation;
  }

  const newConversation = {
    sessionId,
    createdAt: new Date().toISOString(),
    participants: {
      patientId,
      therapistId,
      patientAlias,
      therapistAlias,
    },
    messages: [],
  };

  writeConversation(sessionId, newConversation);
  return newConversation;
}

function sendMessage({ sessionId, senderRole, senderId, content }) {
  const conversation = readConversation(sessionId);
  const encrypted = encryptText(content);
  const message = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    senderRole,
    senderId,
    createdAt: new Date().toISOString(),
    contentPayload: encrypted,
  };

  conversation.messages.push(message);
  writeConversation(sessionId, conversation);
  return {
    ...message,
    content,
  };
}

function listMessages(sessionId) {
  const conversation = readConversation(sessionId);
  return conversation.messages; 
}

module.exports = {
  createConversation,
  sendMessage,
  listMessages,
};
