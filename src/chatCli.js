#!/usr/bin/env node
require('dotenv').config();
const { createConversation, sendMessage, listMessages } = require('./chatService');

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      parsed[args[i].slice(2)] = args[i + 1];
      i += 1;
    }
  }
  return parsed;
}

function getRequiredArg(parsedArgs, key) {
  const value = parsedArgs[key];
  if (!value) {
    throw new Error(`Missing required argument: --${key}`);
  }
  return value;
}

async function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  if (!command || command === 'help') {
    console.log('Usage:\n  node src/chatCli.js init-session --session-id S1 --patient-id p1 --therapist-id t1 --patient-alias Alice --therapist-alias Dr.Bob\n  node src/chatCli.js send --session-id S1 --sender-role patient --sender-id p1 --message "Hello"');
    return;
  }

  if (command === 'init-session') {
    createConversation({
      sessionId: getRequiredArg(args, 'session-id'),
      patientId: getRequiredArg(args, 'patient-id'),
      therapistId: getRequiredArg(args, 'therapist-id'),
      patientAlias: getRequiredArg(args, 'patient-alias'),
      therapistAlias: getRequiredArg(args, 'therapist-alias'),
    });
    console.log('Conversation initialized');
    return;
  }

  if (command === 'send') {
    const message = sendMessage({
      sessionId: getRequiredArg(args, 'session-id'),
      senderRole: getRequiredArg(args, 'sender-role'),
      senderId: getRequiredArg(args, 'sender-id'),
      content: getRequiredArg(args, 'message'),
    });
    console.log(JSON.stringify(message, null, 2));
    return;
  }

  if (command === 'list') {
    console.log(JSON.stringify(listMessages(getRequiredArg(args, 'session-id')), null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
