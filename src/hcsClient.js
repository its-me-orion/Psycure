const {
  Client,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  PrivateKey,
  TopicId,
} = require("@hashgraph/sdk");

const DEFAULT_MIRROR_NODE = "https://testnet.mirrornode.hedera.com";

function getEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function buildHederaClient() {
  const operatorId = getEnv("OPERATOR_ACCOUNT_ID");
  const operatorKey = PrivateKey.fromStringED25519(getEnv("OPERATOR_PRIVATE_KEY"));
  const client = Client.forTestnet();
  client.setOperator(operatorId, operatorKey);
  return client;
}

async function ensureTopicId(client) {
  if (process.env.HEDERA_TOPIC_ID) {
    return TopicId.fromString(process.env.HEDERA_TOPIC_ID);
  }

  const tx = await new TopicCreateTransaction().execute(client);
  const receipt = await tx.getReceipt(client);

  if (!receipt.topicId) {
    throw new Error("Failed to create HCS topic");
  }

  return receipt.topicId;
}

async function submitTopicMessage(client, topicId, payload) {
  const message = JSON.stringify(payload);
  const submitTx = await new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(message)
    .execute(client);

  const submitReceipt = await submitTx.getReceipt(client);

  return {
    message,
    topicId: topicId.toString(),
    sequenceNumber: submitReceipt.topicSequenceNumber?.toString() || "",
    transactionId: submitTx.transactionId?.toString() || "",
  };
}

async function fetchSessionConfirmations(topicId, sessionId) {
  const mirrorBase = process.env.HEDERA_MIRROR_NODE_URL || DEFAULT_MIRROR_NODE;
  const url = `${mirrorBase}/api/v1/topics/${topicId}/messages?order=desc&limit=100`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to fetch topic messages (${response.status})`);
  }

  const data = await response.json();
  const messages = (data.messages || [])
    .map((message) => {
      const decoded = Buffer.from(message.message, "base64").toString("utf8");
      try {
        return {
          sequence_number: message.sequence_number,
          consensus_timestamp: message.consensus_timestamp,
          payload: JSON.parse(decoded),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const patientConfirmation = messages.find(
    (msg) =>
      msg.payload?.type === "SESSION_CONFIRMED" &&
      msg.payload?.sessionId === sessionId &&
      msg.payload?.role === "patient"
  );

  const therapistConfirmation = messages.find(
    (msg) =>
      msg.payload?.type === "SESSION_CONFIRMED" &&
      msg.payload?.sessionId === sessionId &&
      msg.payload?.role === "therapist"
  );

  return {
    patientConfirmation,
    therapistConfirmation,
  };
}

module.exports = {
  buildHederaClient,
  ensureTopicId,
  submitTopicMessage,
  fetchSessionConfirmations,
};
