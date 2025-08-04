const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState
} = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const { MongoClient } = require('mongodb')
const OpenAI = require('openai')
const qrcode = require('qrcode-terminal')
const fs = require('fs')
const path = require('path')
require('dotenv').config()

const config = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY
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
    decryptionRetryDelay: 2000
  }
}

// Group type configurations with specific moderation rules
const groupTypeConfigs = {
  'company': {
    name: 'Company Official Group',
    description: 'Professional workplace environment',
    rules: [
      'No profanity or inappropriate language',
      'No political discussions',
      'No personal attacks or harassment',
      'Maintain professional tone',
      'No spam or irrelevant content'
    ],
    moderationPrompt: `
You are moderating a COMPANY OFFICIAL GROUP. Be strict about:
1. Any profanity, curse words, or inappropriate language (including slang in English, Hindi, Hinglish)
2. Political content, debates, or politically charged discussions
3. Personal attacks, harassment, or hostile behavior
4. Unprofessional tone or conduct
5. Spam, promotional content, or irrelevant messages
`
  },
  'building': {
    name: 'Building/Society Group',
    description: 'Residential community discussions',
    rules: [
      'Keep discussions community-focused',
      'No personal disputes in public',
      'Respectful communication only',
      'No spam or irrelevant content',
      'No aggressive behavior'
    ],
    moderationPrompt: `
You are moderating a BUILDING/RESIDENTIAL COMMUNITY GROUP. Watch for:
1. Personal disputes that should be handled privately
2. Aggressive or hostile behavior toward neighbors
3. Inappropriate language or personal attacks
4. Spam or irrelevant promotional content
5. Disrespectful tone in community discussions
`
  },
  'sports': {
    name: 'Sports Group',
    description: 'Sports discussions and activities',
    rules: [
      'Keep discussions sports-related',
      'No excessive trash talk',
      'Respect all teams and players',
      'No personal attacks',
      'Good sportsmanship required'
    ],
    moderationPrompt: `
You are moderating a SPORTS GROUP. Monitor for:
1. Excessive trash talk or unsportsmanlike behavior
2. Personal attacks on players, teams, or members
3. Hostile or aggressive language during discussions
4. Off-topic content unrelated to sports
5. Disrespectful behavior toward different team supporters
`
  },
  'friends': {
    name: 'Close Friends Group',
    description: 'Personal friend circle',
    rules: [
      'Respect all friends',
      'No bullying or harassment',
      'Keep it friendly and fun',
      'No excessive negativity',
      'Respect privacy'
    ],
    moderationPrompt: `
You are moderating a CLOSE FRIENDS GROUP. Be lenient but watch for:
1. Bullying, harassment, or persistent negative behavior
2. Personal attacks that cross the line of friendly banter
3. Sharing private information without consent
4. Excessive negativity that affects group mood
5. Behavior that makes others uncomfortable
`
  },
  'educational': {
    name: 'Educational/Study Group',
    description: 'Learning and academic discussions',
    rules: [
      'Keep discussions educational',
      'Respectful academic debates only',
      'No cheating or plagiarism',
      'Help and support fellow learners',
      'No spam or irrelevant content'
    ],
    moderationPrompt: `
You are moderating an EDUCATIONAL/STUDY GROUP. Monitor for:
1. Cheating, plagiarism, or academic dishonesty
2. Disrespectful behavior toward students or educators
3. Off-topic discussions that distract from learning
4. Spam or irrelevant promotional content
5. Discouraging or demotivating comments toward learners
`
  }
}

class WhatsAppModerationBot {
  constructor() {
    this.sock = null
    this.db = null
    this.client = null
    this.openai = new OpenAI({ apiKey: config.openai.apiKey })
    this.groupMessages = new Map()
    this.lastWarningTime = new Map()
    this.decryptionRetries = new Map()
    this.processedMessages = new Set()
    
    // Configuration states for users setting up the bot
    this.setupStates = new Map() // userId -> setupState
    this.pendingConfigs = new Map() // userId -> config object
  }

  async initialize() {
    try {
      await this.connectToMongoDB()
      await this.initializeWhatsApp()
      console.log('Bot initialized successfully!')
    } catch (error) {
      console.error('Failed to initialize bot:', error)
      process.exit(1)
    }
  }

  async connectToMongoDB() {
    try {
      this.client = new MongoClient(config.mongodb.uri)
      await this.client.connect()
      this.db = this.client.db(config.mongodb.dbName)

      // Create collections
      await this.db.createCollection('warnings').catch(() => {})
      await this.db.createCollection('group_messages').catch(() => {})
      await this.db.createCollection('group_configs').catch(() => {})
      await this.db.createCollection('admin_mappings').catch(() => {})

      console.log('Connected to MongoDB')
    } catch (error) {
      console.error('MongoDB connection failed:', error)
      throw error
    }
  }

  async initializeWhatsApp() {
    try {
      const { state, saveCreds } = await useMultiFileAuthState('auth_info')

      this.sock = makeWASocket({
        auth: state,
        defaultQueryTimeoutMs: 0,
        printQRInTerminal: false,
        browser: ['WhatsApp Moderation Bot', 'Chrome', '1.0.0'],
        retryRequestDelayMs: 250,
        maxMsgRetryCount: 3,
        syncFullHistory: true,
        shouldSyncHistoryMessage: () => true,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        connectTimeoutMs: 60000,
        patchMessageBeforeSending: message => {
          console.log('📤 Sending message:', Object.keys(message))
          return message
        }
      })

      this.sock.ev.on('connection.update', this.handleConnectionUpdate.bind(this))
      this.sock.ev.on('creds.update', saveCreds)
      this.sock.ev.on('messages.upsert', this.handleMessagesWithRetry.bind(this))
      this.sock.ev.on('group-participants.update', this.handleGroupParticipantsUpdate.bind(this))
      this.sock.ev.on('messages.update', this.handleMessageUpdates.bind(this))
      this.sock.ev.on('presence.update', this.handlePresenceUpdate.bind(this))
      this.sock.ev.on('CB:call', this.handleIncomingCall.bind(this))
      this.sock.ev.on('message-receipt.update', this.handleMessageReceipts.bind(this))
    } catch (error) {
      console.error('Error initializing WhatsApp:', error)
      throw error
    }
  }

  async handleIncomingCall(node) {
    const callId = node.attrs.id
    const from = node.attrs.from

    try {
      await this.sock.rejectCall(callId, from)
      console.log(`Rejected incoming call from ${from}`)
    } catch (error) {
      console.error('Error rejecting call:', error)
    }
  }

  handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log('\n🔗 Scan the QR code below to connect WhatsApp:')
      qrcode.generate(qr, { small: true })
      console.log('\nOpen WhatsApp on your phone and scan the QR code above.\n')
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true

      if (shouldReconnect) {
        console.log('Connection closed. Reconnecting...')
        this.decryptionRetries.clear()
        this.processedMessages.clear()
        setTimeout(() => {
          this.initializeWhatsApp()
        }, 3000)
      } else {
        console.log('Connection closed. Please restart the bot and scan the QR code again.')
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp connected successfully!')
      this.decryptionRetries.clear()
      this.processedMessages.clear()
    } else if (connection === 'connecting') {
      console.log('🔄 Connecting to WhatsApp...')
    }
  }

  async handleMessagesWithRetry(m) {
    console.log(`📨 Received ${m.messages.length} messages, type: ${m.type}`)

    for (const msg of m.messages) {
      const messageId = msg.key.id
      const senderId = msg.key.participant || msg.key.remoteJid
      const chatId = msg.key.remoteJid

      // Handle private messages for bot configuration
      if (!chatId.endsWith('@g.us')) {
        await this.handlePrivateMessage(msg)
        continue
      }

      console.log('📧 Processing message:', {
        "id": messageId,
        "from": senderId?.split('@')[0],
        "group": chatId?.split('@')[0],
        "fromMe": msg.key.fromMe,
        "hasMessage": !!msg.message,
        "messageKeys": msg.message ? Object.keys(msg.message) : []
      })

      if (this.processedMessages.has(messageId)) {
        console.log('⏭️ Message already processed, skipping')
        continue
      }

      try {
        await this.handleMessages({ messages: [msg] })
        this.processedMessages.add(messageId)
      } catch (error) {
        console.error('❌ Error processing message:', {
          messageId,
          error: error.message,
          isDecryptionError: error.message.includes('No SenderKeyRecord found') ||
                           error.message.includes('decryption') ||
                           error.message.includes('decrypt')
        })

        if (error.message.includes('No SenderKeyRecord found') ||
            error.message.includes('decryption') ||
            error.message.includes('decrypt')) {
          await this.handleDecryptionError(msg, error)
        } else {
          console.error('Non-decryption error handling message:', error)
        }
      }
    }
  }

  async handlePrivateMessage(msg) {
    if (!msg.message || msg.key.fromMe) return

    const senderId = msg.key.remoteJid
    const messageText = this.extractMessageText(msg)
    
    if (!messageText) return

    // Check if user is in setup process
    const currentState = this.setupStates.get(senderId)
    
    if (currentState) {
      await this.handleSetupResponse(senderId, messageText, currentState)
      return
    }

    // Handle greeting messages
    const greetings = ['hi', 'hello', 'hey', 'start', 'help', '/start']
    if (greetings.some(greeting => messageText.toLowerCase().includes(greeting))) {
      await this.sendWelcomeMessage(senderId)
    }
  }

  async sendWelcomeMessage(senderId) {
    const welcomeMessage = `🤖 *Welcome to WhatsApp Moderation Bot!*

I'm an AI-powered moderation bot designed to help maintain healthy group discussions by:

✅ Monitoring messages for policy violations
✅ Sending warnings to users who violate group guidelines  
✅ Taking action against repeat offenders
✅ Providing detailed moderation reports

*What I can moderate:*
• Inappropriate language and profanity
• Political discussions (if not allowed)
• Personal attacks and harassment
• Spam and irrelevant content
• Aggressive or hostile behavior

*Key Features:*
• Customizable rules based on group type
• Flexible warning system
• Admin controls and permissions
• Private or public warning messages
• Automatic user removal (if configured)

Would you like to proceed with setting up the bot for your group? Reply with *"YES"* to continue or *"NO"* to cancel.`

    await this.sock.sendMessage(senderId, { text: welcomeMessage })
    this.setupStates.set(senderId, 'awaiting_consent')
  }

  async handleSetupResponse(senderId, messageText, currentState) {
    const userConfig = this.pendingConfigs.get(senderId) || {}

    switch (currentState) {
      case 'awaiting_consent':
        if (messageText.toLowerCase().includes('yes')) {
          await this.askGroupType(senderId)
        } else {
          await this.sock.sendMessage(senderId, { 
            text: "No problem! Feel free to message me anytime if you'd like to set up the moderation bot. Have a great day! 👋" 
          })
          this.setupStates.delete(senderId)
        }
        break

      case 'awaiting_group_type':
        await this.handleGroupTypeSelection(senderId, messageText, userConfig)
        break

      case 'awaiting_admin_status':
        await this.handleAdminStatusSelection(senderId, messageText, userConfig)
        break

      case 'awaiting_warning_preference':
        await this.handleWarningPreference(senderId, messageText, userConfig)
        break

      case 'awaiting_group_name':
        await this.handleGroupNameInput(senderId, messageText, userConfig)
        break
    }
  }

  async askGroupType(senderId) {
    const groupTypeMessage = `🏷️ *Step 1: Group Type Selection*

Please select the type of group you'll be adding the bot to. This helps me customize the moderation rules appropriately:

*1.* 🏢 Company Official Group
*2.* 🏠 Building/Society Group  
*3.* ⚽ Sports Group
*4.* 👥 Close Friends Group
*5.* 📚 Educational/Study Group

Reply with the *number* (1-5) corresponding to your group type.`

    await this.sock.sendMessage(senderId, { text: groupTypeMessage })
    this.setupStates.set(senderId, 'awaiting_group_type')
  }

  async handleGroupTypeSelection(senderId, messageText, userConfig) {
    const typeMapping = {
      '1': 'company',
      '2': 'building', 
      '3': 'sports',
      '4': 'friends',
      '5': 'educational'
    }

    const selectedType = typeMapping[messageText.trim()]
    
    if (!selectedType) {
      await this.sock.sendMessage(senderId, { 
        text: "Please reply with a valid number (1-5) to select your group type." 
      })
      return
    }

    userConfig.groupType = selectedType
    const config = groupTypeConfigs[selectedType]
    
    const confirmationMessage = `✅ *Selected: ${config.name}*

*Description:* ${config.description}

*Moderation Rules:*
${config.rules.map(rule => `• ${rule}`).join('\n')}

Now, let's configure the bot's permissions...`

    await this.sock.sendMessage(senderId, { text: confirmationMessage })
    this.pendingConfigs.set(senderId, userConfig)
    
    setTimeout(() => this.askAdminStatus(senderId), 2000)
  }

  async askAdminStatus(senderId) {
    const adminMessage = `👤 *Step 2: Bot Permissions*

Will you be adding the bot as an admin or regular member in your group?

*1.* 🛡️ **Admin** - Bot can remove users who exceed warning limits
*2.* 👤 **Regular Member** - Bot can only send warnings (recommended for most groups)

Reply with *1* for Admin or *2* for Regular Member.

*Note:* Only choose Admin if you want the bot to automatically remove users after maximum warnings are reached.`

    await this.sock.sendMessage(senderId, { text: adminMessage })
    this.setupStates.set(senderId, 'awaiting_admin_status')
  }

  async handleAdminStatusSelection(senderId, messageText, userConfig) {
    const choice = messageText.trim()
    
    if (choice === '1') {
      userConfig.botIsAdmin = true
      userConfig.canRemoveUsers = true
    } else if (choice === '2') {
      userConfig.botIsAdmin = false  
      userConfig.canRemoveUsers = false
    } else {
      await this.sock.sendMessage(senderId, { 
        text: "Please reply with *1* for Admin or *2* for Regular Member." 
      })
      return
    }

    const statusMessage = userConfig.botIsAdmin 
      ? "✅ Bot will be added as *Admin* with user removal capabilities."
      : "✅ Bot will be added as *Regular Member* (warnings only)."
    
    await this.sock.sendMessage(senderId, { text: statusMessage })
    this.pendingConfigs.set(senderId, userConfig)
    
    setTimeout(() => this.askWarningPreference(senderId), 1500)
  }

  async askWarningPreference(senderId) {
    const warningMessage = `📢 *Step 3: Warning Delivery Method*

How would you like the bot to send warnings to users who violate group policies?

*1.* 🌍 **Public** - Send warnings in the group chat (visible to all members)
*2.* 🔒 **Private** - Send warnings via private message to the user only

*Public warnings:*
✅ Transparent moderation
✅ Sets example for other members  
✅ Shows active moderation

*Private warnings:*
✅ Maintains user privacy
✅ Reduces group chat clutter
✅ Less confrontational

Reply with *1* for Public or *2* for Private warnings.`

    await this.sock.sendMessage(senderId, { text: warningMessage })
    this.setupStates.set(senderId, 'awaiting_warning_preference')
  }

  async handleWarningPreference(senderId, messageText, userConfig) {
    const choice = messageText.trim()
    
    if (choice === '1') {
      userConfig.warningMethod = 'public'
    } else if (choice === '2') {
      userConfig.warningMethod = 'private'
    } else {
      await this.sock.sendMessage(senderId, { 
        text: "Please reply with *1* for Public or *2* for Private warnings." 
      })
      return
    }

    const methodMessage = userConfig.warningMethod === 'public'
      ? "✅ Warnings will be sent *publicly* in the group chat."
      : "✅ Warnings will be sent *privately* to individual users."
    
    await this.sock.sendMessage(senderId, { text: methodMessage })
    this.pendingConfigs.set(senderId, userConfig)
    
    setTimeout(() => this.askGroupName(senderId), 1500)
  }

  async askGroupName(senderId) {
    const nameMessage = `📝 *Step 4: Group Identification*

Please provide the *exact name* of the WhatsApp group where you'll be adding this bot.

This helps me identify the correct group and apply the configuration automatically when I'm added.

*Important:* Make sure the group name matches exactly (including spaces and special characters).

Reply with your group name:`

    await this.sock.sendMessage(senderId, { text: nameMessage })
    this.setupStates.set(senderId, 'awaiting_group_name')
  }

  async handleGroupNameInput(senderId, messageText, userConfig) {
    userConfig.groupName = messageText.trim()
    userConfig.adminId = senderId
    userConfig.setupDate = new Date()
    
    // Save configuration to database
    await this.saveGroupConfiguration(userConfig)
    
    const config = groupTypeConfigs[userConfig.groupType]
    const summaryMessage = `🎉 *Setup Complete!*

Your bot configuration has been saved successfully. Here's a summary:

*📋 Configuration Summary:*
• **Group Name:** ${userConfig.groupName}
• **Group Type:** ${config.name}
• **Bot Role:** ${userConfig.botIsAdmin ? 'Admin (can remove users)' : 'Regular Member (warnings only)'}
• **Warning Method:** ${userConfig.warningMethod === 'public' ? 'Public (in group)' : 'Private (direct message)'}
• **Max Warnings:** ${config.bot?.maxWarnings || 5}

*🚀 Next Steps:*
1. Add me to your WhatsApp group "${userConfig.groupName}"
2. Make sure you're an admin of that group
3. I'll automatically introduce myself and start monitoring

*⚠️ Important Notes:*
• Only group admins can add me to groups
• If you leave the group, I'll automatically leave too
• You can always contact me privately for support

Ready to moderate! 🛡️`

    await this.sock.sendMessage(senderId, { text: summaryMessage })
    
    // Clean up setup state
    this.setupStates.delete(senderId)
    this.pendingConfigs.delete(senderId)
  }

  async saveGroupConfiguration(config) {
    try {
      await this.db.collection('group_configs').insertOne(config)
      await this.db.collection('admin_mappings').insertOne({
        groupName: config.groupName,
        adminId: config.adminId,
        createdAt: new Date()
      })
      console.log(`Configuration saved for group: ${config.groupName}`)
    } catch (error) {
      console.error('Error saving configuration:', error)
    }
  }

  async handleGroupParticipantsUpdate(update) {
    const { id: groupId, participants, action } = update

    try {
      console.log(`📋 Group participants update: ${action} in ${groupId}`, participants.map(p => p.split('@')[0]))
      
      if (action === 'add') {
        // Check if bot was just added to this group
        const botNumber = this.sock.user?.id?.split(':')[0] + '@s.whatsapp.net'
        console.log(`🤖 Bot number: ${botNumber}`)
        console.log(`👥 Added participants:`, participants)
        
        if (participants.includes(botNumber)) {
          console.log(`🎯 Bot was added to group: ${groupId}`)
          // Add delay to ensure bot has proper access
          setTimeout(async () => {
            await this.handleBotAddedToGroup(groupId)
          }, 3000) // 3 second delay
        } else {
          // Handle regular user additions
          for (const participant of participants) {
            await this.handleUserReAdded(groupId, participant)
          }
        }
      } else if (action === 'remove') {
        await this.handleUserRemoved(groupId, participants)
      }
    } catch (error) {
      console.error('Error handling group participants update:', error)
    }
  }

  async handleBotAddedToGroup(groupId) {
    try {
      console.log(`🔍 Bot added to group: ${groupId}`)
      
      // Try to get group metadata with retries
      let groupInfo = null
      let groupName = null
      
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log(`📞 Attempt ${attempt}: Getting group metadata...`)
          groupInfo = await this.sock.groupMetadata(groupId)
          groupName = groupInfo.subject
          console.log(`✅ Got group info: "${groupName}"`)
          break
        } catch (metadataError) {
          console.log(`❌ Attempt ${attempt} failed:`, metadataError.message)
          if (attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt)) // Progressive delay
          } else {
            // If all attempts fail, send a generic introduction without group name verification
            console.log(`⚠️ Could not get group metadata, sending generic introduction`)
            await this.sendGenericIntroduction(groupId)
            return
          }
        }
      }

      if (!groupInfo || !groupName) {
        console.log(`❌ Could not get group information after 3 attempts`)
        return
      }

      console.log(`🔍 Looking for configuration for group: "${groupName}"`)
      
      // Find configuration for this group with flexible matching
      const config = await this.db.collection('group_configs').findOne({ 
        groupName: { $regex: new RegExp(`^${groupName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
      })
      
      if (!config) {
        console.log(`❌ No configuration found for group: ${groupName}`)
        // No configuration found - send setup reminder
        const noConfigMessage = `⚠️ *Configuration Not Found*

Hello! I'm the WhatsApp Moderation Bot, but I don't have a configuration set up for this group "${groupName}".

Please contact me privately first to configure the bot settings before adding me to groups.

*How to configure:*
1. Message me privately with "hi" or "start"
2. Follow the setup process
3. Add me to the group after configuration

I'll leave this group now. Contact me privately to set up proper configuration! 👋`

        await this.sock.sendMessage(groupId, { text: noConfigMessage })
        
        // Leave the group after a delay
        setTimeout(async () => {
          try {
            await this.sock.groupLeave(groupId)
            console.log(`🚪 Left unconfigured group: ${groupName}`)
          } catch (error) {
            console.error('Error leaving unconfigured group:', error)
          }
        }, 8000)
        return
      }

      console.log(`✅ Found configuration for group: ${groupName}`, {
        groupType: config.groupType,
        adminId: config.adminId,
        warningMethod: config.warningMethod
      })

      // Check if the configured admin is in the group and has admin rights
      const configuredAdmin = groupInfo.participants.find(p => 
        p.id === config.adminId
      )
      
      const isConfiguredAdminPresent = !!configuredAdmin
      const isConfiguredAdminActualAdmin = configuredAdmin?.admin === 'admin' || configuredAdmin?.admin === 'superadmin'

      console.log(`👤 Admin check:`, {
        configuredAdminId: config.adminId.split('@')[0],
        isPresent: isConfiguredAdminPresent,
        isAdmin: isConfiguredAdminActualAdmin,
        adminLevel: configuredAdmin?.admin
      })

      if (!isConfiguredAdminPresent || !isConfiguredAdminActualAdmin) {
        const notAdminMessage = `❌ *Unauthorized Addition*

I can only be added to groups by the admin who configured me, and that person must have admin rights in this group.

*Configured Admin:* ${config.adminId.split('@')[0]}
*Issue:* ${!isConfiguredAdminPresent ? 'Configured admin not in group' : 'Configured admin lacks admin rights'}

Please ensure:
1. The person who configured me is in this group
2. They have admin rights in this group
3. Then add me again

I'll leave this group now. Contact me privately if you need help! 👋`

        await this.sock.sendMessage(groupId, { text: notAdminMessage })
        
        setTimeout(async () => {
          try {
            await this.sock.groupLeave(groupId)
            console.log(`🚪 Left unauthorized group: ${groupName}`)
          } catch (error) {
            console.error('Error leaving unauthorized group:', error)
          }
        }, 8000)
        return
      }

      // Valid addition - send introduction message
      console.log(`🎉 Valid addition to group: ${groupName}`)
      await this.sendGroupIntroduction(groupId, config)
      
      // Save group activation
      await this.db.collection('group_configs').updateOne(
        { _id: config._id },
        { 
          $set: { 
            groupId,
            activatedAt: new Date(),
            isActive: true 
          }
        }
      )

      console.log(`✅ Bot successfully activated in group: ${groupName}`)

    } catch (error) {
      console.error('Error handling bot addition to group:', error)
      
      // Send a fallback message if possible
      try {
        await this.sendGenericIntroduction(groupId)
      } catch (fallbackError) {
        console.error('Could not send fallback introduction:', fallbackError)
      }
    }
  }

  async sendGenericIntroduction(groupId) {
    const genericIntroMessage = `🤖 *Hello Everyone!*

I'm the WhatsApp Moderation Bot! I help maintain respectful group discussions.

*⚠️ Configuration Status:* I'm having trouble accessing this group's specific configuration, but I can still help moderate.

*🛡️ What I Do:*
• Monitor messages for inappropriate content
• Send warnings for policy violations
• Help maintain a positive group environment

*📋 General Guidelines:*
• Keep discussions respectful
• No personal attacks or harassment
• Avoid inappropriate language
• Stay on topic when possible

*🔧 For Full Features:*
Contact me privately to set up proper configuration for this group.

_I'm ready to help moderate! 🛡️_`

    try {
      await this.sock.sendMessage(groupId, { text: genericIntroMessage })
      console.log(`📢 Generic introduction message sent to group`)
    } catch (error) {
      console.error('Error sending generic introduction message:', error)
    }
  }

  async sendGroupIntroduction(groupId, config) {
    const groupTypeConfig = groupTypeConfigs[config.groupType]
    
    const introMessage = `🤖 *Hello Everyone!*

I'm your new *WhatsApp Moderation Bot* and I'm here to help maintain a respectful and positive environment in this ${groupTypeConfig.name.toLowerCase()}.

*🛡️ What I Do:*
• Monitor messages for policy violations
• Send ${config.warningMethod} warnings to users who violate guidelines
• ${config.canRemoveUsers ? 'Remove users who exceed the warning limit' : 'Track warning counts for admin review'}
• Provide moderation reports and statistics

*📋 Group Guidelines:*
${groupTypeConfig.rules.map(rule => `• ${rule}`).join('\n')}

*⚖️ Warning System:*
• Maximum warnings: ${config.maxWarnings || 5}
• Warning method: ${config.warningMethod === 'public' ? 'Public (visible to all)' : 'Private messages'}
• ${config.canRemoveUsers ? 'Automatic removal after max warnings' : 'Admins notified after max warnings'}

*🤝 Let's work together to keep this group awesome!*

_I only respond to policy violations. For questions about the bot, contact the group admin privately._`

    try {
      await this.sock.sendMessage(groupId, { text: introMessage })
      console.log(`📢 Introduction message sent to group`)
    } catch (error) {
      console.error('Error sending introduction message:', error)
    }
  }

  async handleUserRemoved(groupId, removedParticipants) {
    try {
      // Try to get group info, but don't fail if we can't
      let groupName = 'Unknown Group'
      try {
        const groupInfo = await this.sock.groupMetadata(groupId)
        groupName = groupInfo.subject
      } catch (error) {
        console.log('Could not get group metadata for user removal check')
      }

      // Check if the configured admin was removed
      const config = await this.db.collection('group_configs').findOne({ 
        $or: [
          { groupId: groupId, isActive: true },
          { groupName: groupName, isActive: true }
        ]
      })
      
      if (config && removedParticipants.includes(config.adminId)) {
        // Admin who configured the bot has left - bot should leave too
        const departureMessage = `👋 *Leaving Group*

The admin who configured me has left this group. As per my settings, I'll be leaving as well.

*Reason:* Configured admin is no longer in the group
*Contact:* Reach out to me privately to reconfigure for new admin

Thank you for using WhatsApp Moderation Bot! 🤖`

        await this.sock.sendMessage(groupId, { text: departureMessage })
        
        // Mark configuration as inactive
        await this.db.collection('group_configs').updateOne(
          { _id: config._id },
          { 
            $set: { 
              isActive: false,
              deactivatedAt: new Date(),
              deactivationReason: 'admin_left'
            }
          }
        )
        
        // Leave the group after a delay
        setTimeout(async () => {
          try {
            await this.sock.groupLeave(groupId)
            console.log(`Left group ${groupName} because admin left`)
          } catch (error) {
            console.error('Error leaving group after admin departure:', error)
          }
        }, 3000)
      } else {
        // Regular user removal - clean up their data
        console.log(`Users removed from group ${groupId}:`, removedParticipants.map(p => p.split('@')[0]))
        removedParticipants.forEach(participant => {
          const keysToDelete = Array.from(this.decryptionRetries.keys()).filter(
            key => key.includes(participant)
          )
          keysToDelete.forEach(key => this.decryptionRetries.delete(key))
        })
      }
    } catch (error) {
      console.error('Error handling user removal:', error)
    }
  }

  async handleDecryptionError(msg, error) {
    const messageId = msg.key.id
    const groupId = msg.key.remoteJid
    const senderId = msg.key.participant || msg.key.remoteJid

    const retryKey = `${messageId}_${senderId}`
    const currentRetries = this.decryptionRetries.get(retryKey) || 0

    if (currentRetries < config.bot.maxDecryptionRetries) {
      console.log(
        `Decryption failed for message ${messageId}, attempt ${
          currentRetries + 1
        }/${config.bot.maxDecryptionRetries}`
      )

      this.decryptionRetries.set(retryKey, currentRetries + 1)
      await new Promise(resolve =>
        setTimeout(resolve, config.bot.decryptionRetryDelay)
      )
      await this.requestSenderKeyDistribution(groupId, senderId)

      setTimeout(async () => {
        try {
          await this.handleMessages({ messages: [msg] })
          this.processedMessages.add(messageId)
          console.log(`Successfully processed message ${messageId} after retry`)
        } catch (retryError) {
          if (retryError.message.includes('No SenderKeyRecord found')) {
            await this.handleDecryptionError(msg, retryError)
          } else {
            console.error('Retry failed with different error:', retryError)
          }
        }
      }, config.bot.decryptionRetryDelay)
    } else {
      console.log(
        `Max decryption retries reached for message ${messageId}, skipping...`
      )
      this.decryptionRetries.delete(retryKey)
      await this.logFailedMessage(groupId, senderId, error.message)
    }
  }

  async handleMessageUpdates(updates) {
    console.log('📝 Message updates received:', updates.length)
    for (const update of updates) {
      console.log('Message update:', {
        key: update.key,
        update: update.update
      })
    }
  }

  async handlePresenceUpdate(update) {
    console.log('👤 Presence update:', {
      id: update.id,
      presences: Object.keys(update.presences || {})
    })
  }

  async handleMessageReceipts(receipts) {
    console.log('📧 Message receipts:', receipts.length)
  }

  async requestSenderKeyDistribution(groupId, senderId) {
    try {
      await this.sock.sendMessage(groupId, {
        text: '',
        ephemeralExpiration: 0
      })

      console.log(`Requested sender key distribution for group ${groupId}`)
    } catch (error) {
      console.error('Failed to request sender key distribution:', error)
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
      }

      await this.db.collection('failed_messages').insertOne(failedMessageDoc)
    } catch (error) {
      console.error('Error logging failed message:', error)
    }
  }

  async handleUserReAdded(groupId, userId) {
    try {
      const existingRecord = await this.db.collection('warnings').findOne({
        groupId,
        senderId: userId,
        removed: true
      })

      if (existingRecord) {
        await this.resetUserWarnings(groupId, userId)

        const userNumber = userId.split('@')[0]
        const welcomeMessage =
          `🔄 *Fresh Start*\n\n` +
          `Welcome back @${userNumber}! Your warning count has been reset.\n\n` +
          `Please remember to follow our group guidelines to maintain a respectful environment.`

        await this.sock.sendMessage(groupId, {
          text: welcomeMessage,
          mentions: [userId]
        })

        console.log(
          `User ${userNumber} re-added to group ${groupId}. Warnings reset.`
        )
      } else {
        console.log(
          `New user ${userId.split('@')[0]} added to group ${groupId}`
        )
      }
    } catch (error) {
      console.error('Error handling user re-addition:', error)
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
            removedAt: ''
          }
        }
      )

      console.log(
        `Warning count reset for user ${senderId} in group ${groupId}`
      )
    } catch (error) {
      console.error('Error resetting user warnings:', error)
    }
  }

  async handleMessages(m) {
    const msg = m.messages[0]

    console.log('📨 Message received:', {
      fromMe: msg.key.fromMe,
      remoteJid: msg.key.remoteJid,
      participant: msg.key.participant,
      messageId: msg.key.id,
      hasMessage: !!msg.message,
      messageType: msg.message ? Object.keys(msg.message)[0] : 'none'
    })

    if (!msg.message || msg.key.fromMe) {
      console.log('⏭️ Skipping message: no content or from self')
      return
    }

    const isGroup = msg.key.remoteJid.endsWith('@g.us')
    if (!isGroup) {
      console.log('⏭️ Skipping message: not from group')
      return
    }

    const groupId = msg.key.remoteJid
    const senderId = msg.key.participant || msg.key.remoteJid
    const messageText = this.extractMessageText(msg)

    console.log('📝 Processing message:', {
      groupId: groupId.split('@')[0],
      sender: senderId.split('@')[0],
      messageText: messageText ? messageText.substring(0, 50) + '...' : 'null',
      timestamp: msg.messageTimestamp
    })

    if (!messageText) {
      console.log('⏭️ Skipping message: no extractable text')
      return
    }

    // Check if group is configured and active
    const groupInfo = await this.sock.groupMetadata(groupId)
    const groupConfig = await this.db.collection('group_configs').findOne({
      $or: [
        { groupName: groupInfo.subject, isActive: true },
        { groupId: groupId, isActive: true }
      ]
    })

    if (!groupConfig) {
      console.log(`⏭️ Skipping message: group "${groupInfo.subject}" not configured or inactive`)
      return
    }

    console.log(`✅ Found active configuration for group: ${groupInfo.subject}`, {
      groupType: groupConfig.groupType,
      warningMethod: groupConfig.warningMethod
    })

    try {
      await this.storeGroupMessage(
        groupId,
        senderId,
        messageText,
        msg.messageTimestamp
      )
      
      const isViolation = await this.analyzeMessage(
        groupId,
        senderId,
        messageText,
        groupConfig.groupType
      )

      if (isViolation) {
        const quotedMessage = {
          key: msg.key,
          message: msg.message,
          participant: msg.key.participant,
          messageTimestamp: msg.messageTimestamp
        }
        
        await this.handleViolation(groupId, senderId, messageText, quotedMessage, groupConfig)
      }
    } catch (error) {
      if (
        error.message.includes('No SenderKeyRecord found') ||
        error.message.includes('decryption') ||
        error.message.includes('decrypt')
      ) {
        throw error
      }
      console.error('Error handling message:', error)
    }
  }

  async sendWarning(groupId, senderId, warningCount, violatingMessage, quotedMessage, groupConfig) {
    try {
      const userNumber = senderId.split('@')[0]
      const remainingWarnings = (groupConfig.maxWarnings || 5) - warningCount

      let warningMessage
      if (remainingWarnings > 0) {
        warningMessage =
          `⚠️ *Warning ${warningCount}/${groupConfig.maxWarnings || 5}*\n\n` +
          `@${userNumber}, your message violates our group guidelines.\n\n` +
          `*Reason:* Inappropriate content detected\n` +
          `*Remaining warnings:* ${remainingWarnings}\n\n` +
          `Please maintain respectful communication. Further violations may result in removal from the group.`
      } else {
        warningMessage =
          `🚫 *Final Warning*\n\n` +
          `@${userNumber}, you have reached the maximum number of warnings (${groupConfig.maxWarnings || 5}). ` +
          `${groupConfig.canRemoveUsers ? 'You will be removed from the group for repeated violations.' : 'Group admins have been notified.'}`
      }

      // Send warning based on configuration
      if (groupConfig.warningMethod === 'private') {
        // Send private warning
        await this.sock.sendMessage(senderId, {
          text: `🔒 *Private Warning*\n\n${warningMessage.replace(`@${userNumber}, `, 'Your ')}`
        })
        
        // Notify group (without mentioning user details)
        await this.sock.sendMessage(groupId, {
          text: `⚠️ A group member has been warned privately for violating group guidelines.`
        })
      } else {
        // Send public warning with quote attempts
        await this.sendPublicWarning(groupId, senderId, warningMessage, quotedMessage)
      }

      console.log(
        `Warning sent to ${userNumber} in group ${groupId}. Count: ${warningCount} (${groupConfig.warningMethod})`
      )
    } catch (error) {
      console.error('Error sending warning:', error)
    }
  }

  async sendPublicWarning(groupId, senderId, warningMessage, quotedMessage) {
    try {
      // Try multiple methods to send quoted reply
      await this.sock.sendMessage(groupId, {
        text: warningMessage,
        mentions: [senderId]
      }, {
        quoted: quotedMessage
      })
    } catch (quoteError) {
      console.log('Quote method failed, trying alternative:', quoteError.message)
      
      try {
        await this.sock.sendMessage(groupId, {
          text: warningMessage,
          mentions: [senderId],
          quoted: quotedMessage
        })
      } catch (quote2Error) {
        console.log('Second quote method failed, trying contextInfo:', quote2Error.message)
        
        try {
          await this.sock.sendMessage(groupId, {
            text: warningMessage,
            mentions: [senderId],
            contextInfo: {
              quotedMessage: quotedMessage.message,
              participant: quotedMessage.key.participant || quotedMessage.key.remoteJid,
              stanzaId: quotedMessage.key.id
            }
          })
        } catch (contextError) {
          console.log('Context method failed, sending without quote:', contextError.message)
          // Fallback: send without quote
          await this.sock.sendMessage(groupId, {
            text: warningMessage,
            mentions: [senderId]
          })
        }
      }
    }
  }

  extractMessageText(msg) {
    const message = msg.message
    let messageText = null

    if (message.conversation) {
      messageText = message.conversation
    } else if (message.extendedTextMessage) {
      messageText = message.extendedTextMessage.text
    } else if (message.imageMessage && message.imageMessage.caption) {
      messageText = message.imageMessage.caption
    } else if (message.videoMessage && message.videoMessage.caption) {
      messageText = message.videoMessage.caption
    } else if (message.documentMessage && message.documentMessage.caption) {
      messageText = message.documentMessage.caption
    } else if (message.audioMessage) {
      messageText = '[Audio Message]'
    } else if (message.stickerMessage) {
      messageText = '[Sticker]'
    } else if (message.locationMessage) {
      messageText = '[Location]'
    } else if (message.contactMessage) {
      messageText = '[Contact]'
    } else if (message.ephemeralMessage) {
      return this.extractMessageText({
        message: message.ephemeralMessage.message
      })
    } else if (message.viewOnceMessage) {
      return this.extractMessageText({
        message: message.viewOnceMessage.message
      })
    } else if (message.buttonsMessage) {
      messageText = message.buttonsMessage.contentText || '[Button Message]'
    } else if (message.templateMessage) {
      messageText =
        message.templateMessage.hydratedTemplate?.hydratedContentText ||
        '[Template Message]'
    } else if (message.listMessage) {
      messageText = message.listMessage.description || '[List Message]'
    } else if (message.reactionMessage) {
      messageText = `[Reaction: ${message.reactionMessage.text}]`
    }

    console.log('🔍 Message extraction:', {
      messageTypes: Object.keys(message),
      extractedText: messageText
        ? messageText.substring(0, 100) + '...'
        : 'null'
    })

    return messageText
  }

  async storeGroupMessage(groupId, senderId, messageText, timestamp) {
    try {
      const messageDoc = {
        groupId,
        senderId,
        messageText,
        timestamp: new Date(timestamp * 1000),
        createdAt: new Date()
      }

      await this.db.collection('group_messages').insertOne(messageDoc)

      if (!this.groupMessages.has(groupId)) {
        this.groupMessages.set(groupId, [])
      }

      const messages = this.groupMessages.get(groupId)
      messages.push(messageDoc)

      if (messages.length > config.bot.contextMessages) {
        messages.shift()
      }
    } catch (error) {
      console.error('Error storing message:', error)
    }
  }

  async analyzeMessage(groupId, senderId, messageText, groupType) {
    try {
      console.log(`🔍 Analyzing message from ${senderId.split('@')[0]}: "${messageText.substring(0, 50)}..."`)
      
      const recentMessages = await this.getRecentMessages(groupId, senderId)
      const contextMessages = recentMessages
        .map(msg => `${msg.senderId.split('@')[0]}: ${msg.messageText}`)
        .join('\n')

      const groupTypeConfig = groupTypeConfigs[groupType]
      const moderationPrompt = groupTypeConfig.moderationPrompt

      const prompt = `
${moderationPrompt}

Context (last ${recentMessages.length} messages):
${contextMessages}

Latest message to analyze: "${messageText}"

The messages may be written in English, Hindi, or Hinglish (a mix of both). Understand the **intent, tone, and meaning** behind the words, even if slang, shorthand, or transliteration is used.

Respond with only **"YES"** if the latest message violates any of the moderation criteria for this group type, or **"NO"** if it is acceptable.
Make your decision by considering both the content and tone within the full conversation context.
`

      console.log(`🤖 Sending to OpenAI for analysis...`)
      
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a content moderation assistant. Be strict but fair in your analysis based on the specific group type and its rules.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 10,
        temperature: 0.1
      })

      const result = response.choices[0].message.content.trim().toUpperCase()
      const isViolation = result === 'YES'
      
      console.log(`📊 OpenAI analysis result: ${result} (violation: ${isViolation})`)
      
      return isViolation
    } catch (error) {
      console.error('Error analyzing message:', error)
      return false
    }
  }

  async getRecentMessages(groupId, senderId) {
    try {
      const messages = await this.db
        .collection('group_messages')
        .find({ groupId })
        .sort({ timestamp: -1 })
        .limit(config.bot.contextMessages)
        .toArray()

      return messages.reverse()
    } catch (error) {
      console.error('Error getting recent messages:', error)
      return []
    }
  }

  async handleViolation(groupId, senderId, messageText, messageKey, groupConfig) {
    try {
      const lastWarning = this.lastWarningTime.get(senderId)
      const now = Date.now()

      if (
        lastWarning &&
        now - lastWarning < config.bot.warningCooldown * 1000
      ) {
        console.log(`⏰ Warning cooldown active for user ${senderId.split('@')[0]}`)
        return
      }

      console.log(`⚠️ Processing violation for user ${senderId.split('@')[0]}`)
      
      const warningCount = await this.updateWarningCount(groupId, senderId)
      await this.sendWarning(
        groupId,
        senderId,
        warningCount,
        messageText,
        messageKey,
        groupConfig
      )
      this.lastWarningTime.set(senderId, now)

      if (warningCount >= (groupConfig.maxWarnings || 5)) {
        if (groupConfig.canRemoveUsers) {
          console.log(`🚫 Removing user ${senderId.split('@')[0]} - max warnings reached`)
          await this.removeUser(groupId, senderId)
        } else {
          console.log(`📢 Notifying admins - user ${senderId.split('@')[0]} reached max warnings`)
          await this.notifyAdmins(groupId, senderId, warningCount, groupConfig)
        }
      }
    } catch (error) {
      console.error('Error handling violation:', error)
    }
  }

  async notifyAdmins(groupId, senderId, warningCount, groupConfig) {
    try {
      const userNumber = senderId.split('@')[0]
      const groupInfo = await this.sock.groupMetadata(groupId)
      const admins = groupInfo.participants.filter(p => p.admin).map(p => p.id)

      const notificationMessage = `🚨 *Admin Notification*

User @${userNumber} has reached the maximum warning limit (${warningCount}/${groupConfig.maxWarnings || 5}).

*Action Required:* Please review and take appropriate action.

*Recent Violations:* Check warning history for details.`

      // Send notification to group admins
      for (const adminId of admins) {
        try {
          await this.sock.sendMessage(adminId, {
            text: notificationMessage
          })
        } catch (error) {
          console.error(`Error notifying admin ${adminId}:`, error)
        }
      }

      console.log(`Admins notified about user ${userNumber} reaching warning limit`)
    } catch (error) {
      console.error('Error notifying admins:', error)
    }
  }

  async updateWarningCount(groupId, senderId) {
    try {
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
      )

      return result?.value?.count || 1
    } catch (error) {
      console.error('Error updating warning count:', error)
      return 0
    }
  }

  async removeUser(groupId, senderId) {
    try {
      await this.sock.groupParticipantsUpdate(groupId, [senderId], 'remove')

      const userNumber = senderId.split('@')[0]
      const removalMessage =
        `🚫 *User Removed*\n\n` +
        `User @${userNumber} has been removed from the group for repeated violations of group guidelines.`

      await this.sock.sendMessage(groupId, {
        text: removalMessage,
        mentions: [senderId]
      })

      console.log(`User ${userNumber} removed from group ${groupId}`)

      await this.db.collection('warnings').updateOne(
        { groupId, senderId },
        {
          $set: {
            removed: true,
            removedAt: new Date()
          }
        }
      )
    } catch (error) {
      console.error('Error removing user:', error)
    }
  }

  async getWarningStats(groupId, senderId = null) {
    try {
      const query = { groupId }
      if (senderId) {
        query.senderId = senderId
      }

      const warnings = await this.db
        .collection('warnings')
        .find(query)
        .toArray()

      return warnings
    } catch (error) {
      console.error('Error getting warning stats:', error)
      return []
    }
  }

  async getUserHistory(groupId, senderId) {
    try {
      const userRecord = await this.db.collection('warnings').findOne({
        groupId,
        senderId
      })

      if (!userRecord) {
        return {
          isNewUser: true,
          currentWarnings: 0,
          wasRemoved: false,
          wasReset: false
        }
      }

      return {
        isNewUser: false,
        currentWarnings: userRecord.count || 0,
        wasRemoved: userRecord.removed || false,
        wasReset: !!userRecord.resetAt,
        lastWarning: userRecord.lastWarning,
        removedAt: userRecord.removedAt,
        resetAt: userRecord.resetAt
      }
    } catch (error) {
      console.error('Error getting user history:', error)
      return {
        isNewUser: true,
        currentWarnings: 0,
        wasRemoved: false,
        wasReset: false
      }
    }
  }

  async cleanup() {
    try {
      this.decryptionRetries.clear()
      this.processedMessages.clear()
      this.setupStates.clear()
      this.pendingConfigs.clear()

      if (this.client) {
        await this.client.close()
      }
      console.log('Bot cleanup completed')
    } catch (error) {
      console.error('Error during cleanup:', error)
    }
  }
}

async function startBot() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is required')
    process.exit(1)
  }

  const bot = new WhatsAppModerationBot()

  process.on('SIGINT', async () => {
    console.log('\nShutting down bot...')
    await bot.cleanup()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    console.log('\nShutting down bot...')
    await bot.cleanup()
    process.exit(0)
  })

  await bot.initialize()
}

module.exports = { WhatsAppModerationBot }

if (require.main === module) {
  startBot().catch(console.error)
}