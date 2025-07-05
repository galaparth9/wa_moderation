const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const { MongoClient } = require('mongodb');
const OpenAI = require('openai');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const config = {
    openai: {
        apiKey: process.env.OPENAI_API_KEY,
    },
    mongodb: {
        uri: process.env.MONGODB_URI || 'mongodb://localhost:27017',
        dbName: 'whatsapp_moderation'
    },
    bot: {
        maxWarnings: 5,
        contextMessages: 30,
        warningCooldown: 60,
        maxDecryptionRetries: 3,
        decryptionRetryDelay: 2000,
    }
};

class WhatsAppModerationBot {
    constructor() {
        this.sock = null;
        this.db = null;
        this.client = null;
        this.openai = new OpenAI({ apiKey: config.openai.apiKey });
        this.groupMessages = new Map();
        this.lastWarningTime = new Map();
        this.decryptionRetries = new Map(); // Track retry attempts per message
        this.processedMessages = new Set(); // Prevent duplicate processing
    }

    async initialize() {
        try {
            await this.connectToMongoDB();
            await this.initializeWhatsApp();
            console.log('Bot initialized successfully!');
        } catch (error) {
            console.error('Failed to initialize bot:', error);
            process.exit(1);
        }
    }

    async connectToMongoDB() {
        try {
            this.client = new MongoClient(config.mongodb.uri);
            await this.client.connect();
            this.db = this.client.db(config.mongodb.dbName);

            await this.db.createCollection('warnings').catch(() => { });
            await this.db.createCollection('group_messages').catch(() => { });

            console.log('Connected to MongoDB');
        } catch (error) {
            console.error('MongoDB connection failed:', error);
            throw error;
        }
    }

    async initializeWhatsApp() {
        try {
            const { state, saveCreds } = await useMultiFileAuthState('auth_info');

            this.sock = makeWASocket({
                auth: state,
                defaultQueryTimeoutMs: 0,
                printQRInTerminal: false,
                browser: ['WhatsApp Moderation Bot', 'Chrome', '1.0.0'],
                // Add retry configuration
                retryRequestDelayMs: 250,
                maxMsgRetryCount: 3,
                // Enable message history sync
                syncFullHistory: true,
                // Improve message reception
                shouldSyncHistoryMessage: () => true,
                // Enable receipt acknowledgment
                markOnlineOnConnect: true,
                // Handle different message types
                generateHighQualityLinkPreview: true,
                // Better connection handling
                connectTimeoutMs: 60000,
                // Message handling options
                patchMessageBeforeSending: (message) => {
                    // Log outgoing messages for debugging
                    console.log('📤 Sending message:', Object.keys(message));
                    return message;
                }
            });

            this.sock.ev.on('connection.update', this.handleConnectionUpdate.bind(this));
            this.sock.ev.on('creds.update', saveCreds);
            this.sock.ev.on('messages.upsert', this.handleMessagesWithRetry.bind(this));
            this.sock.ev.on('group-participants.update', this.handleGroupParticipantsUpdate.bind(this));

            // Add more event listeners for better message handling
            this.sock.ev.on('messages.update', this.handleMessageUpdates.bind(this));
            this.sock.ev.on('presence.update', this.handlePresenceUpdate.bind(this));

            // Handle incoming calls
            this.sock.ev.on('CB:call', this.handleIncomingCall.bind(this));

            // Handle message receipts
            this.sock.ev.on('message-receipt.update', this.handleMessageReceipts.bind(this));

        } catch (error) {
            console.error('Error initializing WhatsApp:', error);
            throw error;
        }
    }

    async handleIncomingCall(node) {
        // Handle incoming calls to prevent interruption
        const callId = node.attrs.id;
        const from = node.attrs.from;

        try {
            await this.sock.rejectCall(callId, from);
            console.log(`Rejected incoming call from ${from}`);
        } catch (error) {
            console.error('Error rejecting call:', error);
        }
    }

    handleConnectionUpdate(update) {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n🔗 Scan the QR code below to connect WhatsApp:');
            qrcode.generate(qr, { small: true });
            console.log('\nOpen WhatsApp on your phone and scan the QR code above.\n');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
                : true;

            if (shouldReconnect) {
                console.log('Connection closed. Reconnecting...');
                // Clear retry maps on reconnection
                this.decryptionRetries.clear();
                this.processedMessages.clear();

                setTimeout(() => {
                    this.initializeWhatsApp();
                }, 3000);
            } else {
                console.log('Connection closed. Please restart the bot and scan the QR code again.');
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connected successfully!');
            // Clear retry maps on successful connection
            this.decryptionRetries.clear();
            this.processedMessages.clear();
        } else if (connection === 'connecting') {
            console.log('🔄 Connecting to WhatsApp...');
        }
    }

    // New method to handle messages with retry logic for decryption errors
    async handleMessagesWithRetry(m) {
        console.log(`📨 Received ${m.messages.length} messages, type: ${m.type}`);

        for (const msg of m.messages) {
            const messageId = msg.key.id;
            const groupId = msg.key.remoteJid;
            const senderId = msg.key.participant || msg.key.remoteJid;

            console.log('📧 Processing message:', {
                id: messageId,
                from: senderId?.split('@')[0],
                group: groupId?.split('@')[0],
                fromMe: msg.key.fromMe,
                hasMessage: !!msg.message,
                messageKeys: msg.message ? Object.keys(msg.message) : []
            });

            // Skip if already processed
            if (this.processedMessages.has(messageId)) {
                console.log('⏭️ Message already processed, skipping');
                continue;
            }

            try {
                await this.handleMessages({ messages: [msg] });
                // Mark as processed on success
                this.processedMessages.add(messageId);

            } catch (error) {
                console.error('❌ Error processing message:', {
                    messageId,
                    error: error.message,
                    isDecryptionError: error.message.includes('No SenderKeyRecord found') ||
                        error.message.includes('decryption') ||
                        error.message.includes('decrypt')
                });

                if (error.message.includes('No SenderKeyRecord found') ||
                    error.message.includes('decryption') ||
                    error.message.includes('decrypt')) {

                    await this.handleDecryptionError(msg, error);
                } else {
                    console.error('Non-decryption error handling message:', error);
                }
            }
        }
    }

    async handleDecryptionError(msg, error) {
        const messageId = msg.key.id;
        const groupId = msg.key.remoteJid;
        const senderId = msg.key.participant || msg.key.remoteJid;

        // Track retry attempts
        const retryKey = `${messageId}_${senderId}`;
        const currentRetries = this.decryptionRetries.get(retryKey) || 0;

        if (currentRetries < config.bot.maxDecryptionRetries) {
            console.log(`Decryption failed for message ${messageId}, attempt ${currentRetries + 1}/${config.bot.maxDecryptionRetries}`);

            // Update retry count
            this.decryptionRetries.set(retryKey, currentRetries + 1);

            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, config.bot.decryptionRetryDelay));

            // Try to request sender key distribution
            await this.requestSenderKeyDistribution(groupId, senderId);

            // Retry processing the message
            setTimeout(async () => {
                try {
                    await this.handleMessages({ messages: [msg] });
                    this.processedMessages.add(messageId);
                    console.log(`Successfully processed message ${messageId} after retry`);
                } catch (retryError) {
                    if (retryError.message.includes('No SenderKeyRecord found')) {
                        await this.handleDecryptionError(msg, retryError);
                    } else {
                        console.error('Retry failed with different error:', retryError);
                    }
                }
            }, config.bot.decryptionRetryDelay);

        } else {
            console.log(`Max decryption retries reached for message ${messageId}, skipping...`);
            // Clean up retry tracking
            this.decryptionRetries.delete(retryKey);

            // Log the failed message for debugging
            await this.logFailedMessage(groupId, senderId, error.message);
        }
    }

    async handleMessageUpdates(updates) {
        console.log('📝 Message updates received:', updates.length);
        // Handle message updates (delivery receipts, read receipts, etc.)
        for (const update of updates) {
            console.log('Message update:', {
                key: update.key,
                update: update.update
            });
        }
    }

    async handlePresenceUpdate(update) {
        console.log('👤 Presence update:', {
            id: update.id,
            presences: Object.keys(update.presences || {})
        });
    }

    async handleMessageReceipts(receipts) {
        console.log('📧 Message receipts:', receipts.length);
        // Handle message delivery/read receipts
    }

    async requestSenderKeyDistribution(groupId, senderId) {
        try {
            // Send empty message to trigger key exchange
            await this.sock.sendMessage(groupId, {
                text: '',
                ephemeralExpiration: 0
            });

            console.log(`Requested sender key distribution for group ${groupId}`);
        } catch (error) {
            console.error('Failed to request sender key distribution:', error);
        }
    }

    async logFailedMessage(groupId, senderId, errorMessage) {
        try {
            const failedMessageDoc = {
                groupId,
                senderId,
                error: errorMessage,
                timestamp: new Date(),
                type: 'decryption_failure'
            };

            await this.db.collection('failed_messages').insertOne(failedMessageDoc);
        } catch (error) {
            console.error('Error logging failed message:', error);
        }
    }

    async handleGroupParticipantsUpdate(update) {
        const { id: groupId, participants, action } = update;

        try {
            if (action === 'add') {
                for (const participant of participants) {
                    await this.handleUserReAdded(groupId, participant);
                }
            } else if (action === 'remove') {
                console.log(`Users removed from group ${groupId}:`, participants);
                // Clear any pending decryption retries for removed users
                participants.forEach(participant => {
                    const keysToDelete = Array.from(this.decryptionRetries.keys())
                        .filter(key => key.includes(participant));
                    keysToDelete.forEach(key => this.decryptionRetries.delete(key));
                });
            }
        } catch (error) {
            console.error('Error handling group participants update:', error);
        }
    }

    async handleUserReAdded(groupId, userId) {
        try {
            const existingRecord = await this.db.collection('warnings').findOne({
                groupId,
                senderId: userId,
                removed: true
            });

            if (existingRecord) {
                await this.resetUserWarnings(groupId, userId);

                const userNumber = userId.split('@')[0];
                const welcomeMessage = `🔄 *Fresh Start*\n\n` +
                    `Welcome back @${userNumber}! Your warning count has been reset.\n\n` +
                    `Please remember to follow our group guidelines to maintain a respectful environment.`;

                await this.sock.sendMessage(groupId, {
                    text: welcomeMessage,
                    mentions: [userId]
                });

                console.log(`User ${userNumber} re-added to group ${groupId}. Warnings reset.`);
            } else {
                console.log(`New user ${userId.split('@')[0]} added to group ${groupId}`);
            }

        } catch (error) {
            console.error('Error handling user re-addition:', error);
        }
    }

    async resetUserWarnings(groupId, senderId) {
        try {
            await this.db.collection('warnings').updateOne(
                { groupId, senderId },
                {
                    $set: {
                        count: 0,
                        removed: false,
                        resetAt: new Date(),
                        updatedAt: new Date()
                    },
                    $unset: {
                        removedAt: ""
                    }
                }
            );

            console.log(`Warning count reset for user ${senderId} in group ${groupId}`);

        } catch (error) {
            console.error('Error resetting user warnings:', error);
        }
    }

    async handleMessages(m) {
        const msg = m.messages[0];

        // Enhanced logging for debugging
        console.log('📨 Message received:', {
            fromMe: msg.key.fromMe,
            remoteJid: msg.key.remoteJid,
            participant: msg.key.participant,
            messageId: msg.key.id,
            hasMessage: !!msg.message,
            messageType: msg.message ? Object.keys(msg.message)[0] : 'none'
        });

        if (!msg.message || msg.key.fromMe) {
            console.log('⏭️ Skipping message: no content or from self');
            return;
        }

        const isGroup = msg.key.remoteJid.endsWith('@g.us');
        if (!isGroup) {
            console.log('⏭️ Skipping message: not from group');
            return;
        }

        const groupId = msg.key.remoteJid;
        const senderId = msg.key.participant || msg.key.remoteJid;
        const messageText = this.extractMessageText(msg);

        console.log('📝 Processing message:', {
            groupId: groupId.split('@')[0],
            sender: senderId.split('@')[0],
            messageText: messageText ? messageText.substring(0, 50) + '...' : 'null',
            timestamp: msg.messageTimestamp
        });

        if (!messageText) {
            console.log('⏭️ Skipping message: no extractable text');
            return;
        }

        try {
            await this.storeGroupMessage(groupId, senderId, messageText, msg.messageTimestamp);
            const isViolation = await this.analyzeMessage(groupId, senderId, messageText);

            if (isViolation) {
                await this.handleViolation(groupId, senderId, messageText);
            }
        } catch (error) {
            // Re-throw decryption errors to be handled by retry logic
            if (error.message.includes('No SenderKeyRecord found') ||
                error.message.includes('decryption') ||
                error.message.includes('decrypt')) {
                throw error;
            }
            console.error('Error handling message:', error);
        }
    }

    extractMessageText(msg) {
        const message = msg.message;
        let messageText = null;

        // Handle different message types
        if (message.conversation) {
            messageText = message.conversation;
        } else if (message.extendedTextMessage) {
            messageText = message.extendedTextMessage.text;
        } else if (message.imageMessage && message.imageMessage.caption) {
            messageText = message.imageMessage.caption;
        } else if (message.videoMessage && message.videoMessage.caption) {
            messageText = message.videoMessage.caption;
        } else if (message.documentMessage && message.documentMessage.caption) {
            messageText = message.documentMessage.caption;
        } else if (message.audioMessage) {
            messageText = '[Audio Message]';
        } else if (message.stickerMessage) {
            messageText = '[Sticker]';
        } else if (message.locationMessage) {
            messageText = '[Location]';
        } else if (message.contactMessage) {
            messageText = '[Contact]';
        } else if (message.ephemeralMessage) {
            // Handle ephemeral messages
            return this.extractMessageText({ message: message.ephemeralMessage.message });
        } else if (message.viewOnceMessage) {
            // Handle view once messages
            return this.extractMessageText({ message: message.viewOnceMessage.message });
        } else if (message.buttonsMessage) {
            messageText = message.buttonsMessage.contentText || '[Button Message]';
        } else if (message.templateMessage) {
            messageText = message.templateMessage.hydratedTemplate?.hydratedContentText || '[Template Message]';
        } else if (message.listMessage) {
            messageText = message.listMessage.description || '[List Message]';
        } else if (message.reactionMessage) {
            messageText = `[Reaction: ${message.reactionMessage.text}]`;
        }

        console.log('🔍 Message extraction:', {
            messageTypes: Object.keys(message),
            extractedText: messageText ? messageText.substring(0, 100) + '...' : 'null'
        });

        return messageText;
    }

    async storeGroupMessage(groupId, senderId, messageText, timestamp) {
        try {
            const messageDoc = {
                groupId,
                senderId,
                messageText,
                timestamp: new Date(timestamp * 1000),
                createdAt: new Date()
            };

            await this.db.collection('group_messages').insertOne(messageDoc);

            if (!this.groupMessages.has(groupId)) {
                this.groupMessages.set(groupId, []);
            }

            const messages = this.groupMessages.get(groupId);
            messages.push(messageDoc);

            if (messages.length > config.bot.contextMessages) {
                messages.shift();
            }
        } catch (error) {
            console.error('Error storing message:', error);
        }
    }

    async analyzeMessage(groupId, senderId, messageText) {
        try {
            const recentMessages = await this.getRecentMessages(groupId, senderId);
            const contextMessages = recentMessages.map(msg =>
                `${msg.senderId}: ${msg.messageText}`
            ).join('\n');

            const prompt = `
You are a content moderation system for a WhatsApp group. Analyze the following conversation context and the latest message to determine whether it violates any of the following:

1. Abusive language or personal attacks (including slang in English, Hindi, or Hinglish)
2. Expressions of anger, hostility, or aggression in any manner (in any of the three languages)
3. Political content, debates, or politically charged discussions
4. Religious content, discussions,or insult

The messages may be written in English, Hindi, or Hinglish (a mix of both). Understand the **intent, tone, and meaning** behind the words, even if slang, shorthand, or transliteration is used.

Context (last ${recentMessages.length} messages):
${contextMessages}

Latest message to analyze: "${messageText}"

Respond with only **"YES"** if the latest message violates any of the three criteria above, or **"NO"** if it is acceptable.
Make your decision by considering both the content and tone within the full conversation context.
`;

            const response = await this.openai.chat.completions.create({
                model: 'gpt-4.1-mini',
                messages: [
                    {
                        role: 'system',
                        content: 'You are a content moderation assistant. Be strict but fair in your analysis.'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                max_tokens: 10,
                temperature: 0.1
            });

            const result = response.choices[0].message.content.trim().toUpperCase();
            return result === 'YES';

        } catch (error) {
            console.error('Error analyzing message:', error);
            return false;
        }
    }

    async getRecentMessages(groupId, senderId) {
        try {
            const messages = await this.db.collection('group_messages')
                .find({ groupId })
                .sort({ timestamp: -1 })
                .limit(config.bot.contextMessages)
                .toArray();

            return messages.reverse();
        } catch (error) {
            console.error('Error getting recent messages:', error);
            return [];
        }
    }

    async handleViolation(groupId, senderId, messageText) {
        try {
            const lastWarning = this.lastWarningTime.get(senderId);
            const now = Date.now();

            if (lastWarning && (now - lastWarning) < config.bot.warningCooldown) {
                return;
            }

            const warningCount = await this.updateWarningCount(groupId, senderId);
            await this.sendWarning(groupId, senderId, warningCount, messageText);
            this.lastWarningTime.set(senderId, now);

            if (warningCount >= config.bot.maxWarnings) {
                await this.removeUser(groupId, senderId);
            }

        } catch (error) {
            console.error('Error handling violation:', error);
        }
    }

    async updateWarningCount(groupId, senderId) {
        try {
            const existingRecord = await this.db.collection('warnings').findOne({ groupId, senderId });

            if (existingRecord && existingRecord.count === 0) {
                const result = await this.db.collection('warnings').findOneAndUpdate(
                    { groupId, senderId },
                    {
                        $inc: { count: 1 },
                        $set: {
                            lastWarning: new Date(),
                            updatedAt: new Date()
                        }
                    },
                    {
                        returnDocument: 'after'
                    }
                );

                return result && result.value ? result.value.count : 1;
            }

            const result = await this.db.collection('warnings').findOneAndUpdate(
                { groupId, senderId },
                {
                    $inc: { count: 1 },
                    $set: {
                        lastWarning: new Date(),
                        updatedAt: new Date()
                    },
                    $setOnInsert: {
                        createdAt: new Date(),
                        removed: false
                    }
                },
                {
                    upsert: true,
                    returnDocument: 'after'
                }
            );

            if (result && result.value) {
                return result.value.count;
            }

            const doc = await this.db.collection('warnings').findOne({ groupId, senderId });
            return doc ? doc.count : 1;

        } catch (error) {
            console.error('Error updating warning count:', error);
            return 0;
        }
    }

    async sendWarning(groupId, senderId, warningCount, violatingMessage) {
        try {
            const userNumber = senderId.split('@')[0];
            const remainingWarnings = config.bot.maxWarnings - warningCount;

            let warningMessage;

            if (remainingWarnings > 0) {
                warningMessage = `⚠️ *Warning ${warningCount}/${config.bot.maxWarnings}*\n\n` +
                    `@${userNumber}, your message violates our group guidelines.\n\n` +
                    `*Reason:* Inappropriate content detected\n` +
                    `*Remaining warnings:* ${remainingWarnings}\n\n` +
                    `Please maintain respectful communication. Further violations may result in removal from the group.`;
            } else {
                warningMessage = `🚫 *Final Warning*\n\n` +
                    `@${userNumber}, you have reached the maximum number of warnings (${config.bot.maxWarnings}). ` +
                    `You are removed from the group for repeated violations.`;
            }

            await this.sock.sendMessage(groupId, {
                text: warningMessage,
                mentions: [senderId]
            });

            console.log(`Warning sent to ${userNumber} in group ${groupId}. Count: ${warningCount}`);

        } catch (error) {
            console.error('Error sending warning:', error);
        }
    }

    async removeUser(groupId, senderId) {
        try {
            await this.sock.groupParticipantsUpdate(groupId, [senderId], 'remove');

            const userNumber = senderId.split('@')[0];
            const removalMessage = `🚫 *User Removed*\n\n` +
                `User @${userNumber} has been removed from the group for repeated violations of group guidelines.`;

            await this.sock.sendMessage(groupId, {
                text: removalMessage,
                mentions: [senderId]
            });

            console.log(`User ${userNumber} removed from group ${groupId}`);

            await this.db.collection('warnings').updateOne(
                { groupId, senderId },
                {
                    $set: {
                        removed: true,
                        removedAt: new Date()
                    }
                }
            );

        } catch (error) {
            console.error('Error removing user:', error);
        }
    }

    async getWarningStats(groupId, senderId = null) {
        try {
            const query = { groupId };
            if (senderId) {
                query.senderId = senderId;
            }

            const warnings = await this.db.collection('warnings')
                .find(query)
                .toArray();

            return warnings;
        } catch (error) {
            console.error('Error getting warning stats:', error);
            return [];
        }
    }

    async getUserHistory(groupId, senderId) {
        try {
            const userRecord = await this.db.collection('warnings').findOne({
                groupId,
                senderId
            });

            if (!userRecord) {
                return {
                    isNewUser: true,
                    currentWarnings: 0,
                    wasRemoved: false,
                    wasReset: false
                };
            }

            return {
                isNewUser: false,
                currentWarnings: userRecord.count || 0,
                wasRemoved: userRecord.removed || false,
                wasReset: !!userRecord.resetAt,
                lastWarning: userRecord.lastWarning,
                removedAt: userRecord.removedAt,
                resetAt: userRecord.resetAt
            };

        } catch (error) {
            console.error('Error getting user history:', error);
            return {
                isNewUser: true,
                currentWarnings: 0,
                wasRemoved: false,
                wasReset: false
            };
        }
    }

    async cleanup() {
        try {
            // Clear all retry tracking
            this.decryptionRetries.clear();
            this.processedMessages.clear();

            if (this.client) {
                await this.client.close();
            }
            console.log('Bot cleanup completed');
        } catch (error) {
            console.error('Error during cleanup:', error);
        }
    }
}

async function startBot() {
    if (!process.env.OPENAI_API_KEY) {
        console.error('Error: OPENAI_API_KEY environment variable is required');
        process.exit(1);
    }

    const bot = new WhatsAppModerationBot();

    process.on('SIGINT', async () => {
        console.log('\nShutting down bot...');
        await bot.cleanup();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.log('\nShutting down bot...');
        await bot.cleanup();
        process.exit(0);
    });

    await bot.initialize();
}

module.exports = { WhatsAppModerationBot };

if (require.main === module) {
    startBot().catch(console.error);
}