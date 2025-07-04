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
        maxWarnings: 3,
        contextMessages: 30,
        warningCooldown: 60000,
    }
};

class WhatsAppModerationBot {
    constructor() {
        this.sock = null;
        this.db = null;
        this.client = null;
        this.openai = new OpenAI({ apiKey: config.openai.apiKey });
        this.groupMessages = new Map(); // Store recent messages per group
        this.lastWarningTime = new Map(); // Track last warning time per user
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

            // Create collections if they don't exist
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
            });

            this.sock.ev.on('connection.update', this.handleConnectionUpdate.bind(this));
            this.sock.ev.on('creds.update', saveCreds);
            this.sock.ev.on('messages.upsert', this.handleMessages.bind(this));
            this.sock.ev.on('group-participants.update', this.handleGroupParticipantsUpdate.bind(this));
        } catch (error) {
            console.error('Error initializing WhatsApp:', error);
            throw error;
        }
    }

    handleConnectionUpdate(update) {
        const { connection, lastDisconnect, qr } = update;

        // Handle QR code generation
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
                setTimeout(() => {
                    this.initializeWhatsApp();
                }, 3000); // Wait 3 seconds before reconnecting
            } else {
                console.log('Connection closed. Please restart the bot and scan the QR code again.');
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp connected successfully!');
        } else if (connection === 'connecting') {
            console.log('🔄 Connecting to WhatsApp...');
        }
    }

    async handleGroupParticipantsUpdate(update) {
        const { id: groupId, participants, action } = update;

        try {
            if (action === 'add') {
                // Handle users being added to the group
                for (const participant of participants) {
                    await this.handleUserReAdded(groupId, participant);
                }
            } else if (action === 'remove') {
                // Log when users are removed (for tracking purposes)
                console.log(`Users removed from group ${groupId}:`, participants);
            }
        } catch (error) {
            console.error('Error handling group participants update:', error);
        }
    }

    async handleUserReAdded(groupId, userId) {
        try {
            // Check if this user was previously removed by the bot
            const existingRecord = await this.db.collection('warnings').findOne({
                groupId,
                senderId: userId,
                removed: true
            });

            if (existingRecord) {
                // User was previously removed, reset their warning count
                await this.resetUserWarnings(groupId, userId);

                // Send a welcome back message with clean slate notification
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
                // New user or user who wasn't previously removed by bot
                console.log(`New user ${userId.split('@')[0]} added to group ${groupId}`);
            }

        } catch (error) {
            console.error('Error handling user re-addition:', error);
        }
    }

    async resetUserWarnings(groupId, senderId) {
        try {
            // Reset the warning count and update status
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

        if (!msg.message || msg.key.fromMe) return;

        const isGroup = msg.key.remoteJid.endsWith('@g.us');
        if (!isGroup) return;

        const groupId = msg.key.remoteJid;
        const senderId = msg.key.participant || msg.key.remoteJid;
        const messageText = this.extractMessageText(msg);

        if (!messageText) return;

        try {
            // Store message in group context
            await this.storeGroupMessage(groupId, senderId, messageText, msg.messageTimestamp);

            // Analyze message for violations
            const isViolation = await this.analyzeMessage(groupId, senderId, messageText);

            if (isViolation) {
                await this.handleViolation(groupId, senderId, messageText);
            }
        } catch (error) {
            console.error('Error handling message:', error);
        }
    }

    extractMessageText(msg) {
        const message = msg.message;

        if (message.conversation) {
            return message.conversation;
        }

        if (message.extendedTextMessage) {
            return message.extendedTextMessage.text;
        }

        return null;
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

            // Keep only recent messages in memory for quick access
            if (!this.groupMessages.has(groupId)) {
                this.groupMessages.set(groupId, []);
            }

            const messages = this.groupMessages.get(groupId);
            messages.push(messageDoc);

            // Keep only last 30 messages
            if (messages.length > config.bot.contextMessages) {
                messages.shift();
            }
        } catch (error) {
            console.error('Error storing message:', error);
        }
    }

    async analyzeMessage(groupId, senderId, messageText) {
        try {
            // Get recent messages for context
            const recentMessages = await this.getRecentMessages(groupId, senderId);

            // Prepare context for OpenAI
            const contextMessages = recentMessages.map(msg =>
                `${msg.senderId}: ${msg.messageText}`
            ).join('\n');

            const prompt = `
You are a content moderation system for a WhatsApp group. Analyze the following conversation context and the latest message to determine if it contains:

1. Abusive language or personal attacks
2. Expressions of anger or aggression
3. Political content or political discussions

Context (last ${recentMessages.length} messages):
${contextMessages}

Latest message to analyze: "${messageText}"

Respond with only "YES" if the latest message violates any of the above criteria, or "NO" if it's acceptable.
Consider the context to better understand the intent and tone of the latest message.
            `;

            const response = await this.openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
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
            // Get from database for comprehensive context
            const messages = await this.db.collection('group_messages')
                .find({ groupId })
                .sort({ timestamp: -1 })
                .limit(config.bot.contextMessages)
                .toArray();

            return messages.reverse(); // Chronological order
        } catch (error) {
            console.error('Error getting recent messages:', error);
            return [];
        }
    }

    async handleViolation(groupId, senderId, messageText) {
        try {
            // Check cooldown
            const lastWarning = this.lastWarningTime.get(senderId);
            const now = Date.now();

            if (lastWarning && (now - lastWarning) < config.bot.warningCooldown) {
                return; // Skip warning due to cooldown
            }

            // Update warning count
            const warningCount = await this.updateWarningCount(groupId, senderId);

            // Send warning message
            await this.sendWarning(groupId, senderId, warningCount, messageText);

            // Update last warning time
            this.lastWarningTime.set(senderId, now);

            // Remove user if warnings exceeded
            if (warningCount >= config.bot.maxWarnings) {
                await this.removeUser(groupId, senderId);
            }

        } catch (error) {
            console.error('Error handling violation:', error);
        }
    }

    async updateWarningCount(groupId, senderId) {
        try {
            // First check if user has been reset (count = 0) but has a record
            const existingRecord = await this.db.collection('warnings').findOne({ groupId, senderId });

            if (existingRecord && existingRecord.count === 0) {
                // User has been reset, increment from 0
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

            // Normal flow - increment or create new record
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

            // Handle the case where result.value might be null
            if (result && result.value) {
                return result.value.count;
            }

            // Fallback: If result.value is null, query the document separately
            const doc = await this.db.collection('warnings').findOne({ groupId, senderId });
            return doc ? doc.count : 1; // Return 1 if document was just created

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
                    `You will be removed from the group for repeated violations.`;
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

            // Log removal in database
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

// Start the bot if this file is run directly
if (require.main === module) {
    startBot().catch(console.error);
}