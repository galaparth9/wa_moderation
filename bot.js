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
    warningCooldown: 0, //seconds
    maxDecryptionRetries: 3,
    decryptionRetryDelay: 2000
  }
}

// Group type configurations with specific moderation rules
const GROUP_POLICIES = {
  company_official: {
    name: 'Company Official Group',
    rules: [
      'Professional language only - no curse words or slang',
      'No political discussions or debates',
      'No aggressive or hostile behavior',
      'No personal attacks or harassment',
      'No spam or irrelevant content',
      'Work-related discussions only'
    ],
    prompt: `You are moderating a professional company group. Be strict about:
1. Any unprofessional language, curse words, or inappropriate slang
2. Political content or debates of any kind
3. Aggressive, hostile, or confrontational behavior
4. Personal attacks or harassment
5. Off-topic discussions not related to work
6. Spam or promotional content`
  },
  building_society: {
    name: 'Building/Society Group',
    rules: [
      'Respectful communication about building matters',
      'No personal attacks on residents or management',
      'No political discussions',
      'No aggressive behavior or threats',
      'Building-related discussions preferred'
    ],
    prompt: `You are moderating a building/society residents group. Watch for:
1. Disrespectful language towards residents or management
2. Personal attacks or harassment
3. Political discussions or debates
4. Aggressive threats or hostile behavior
5. Spam or irrelevant promotional content`
  },
  sports_group: {
    name: 'Sports Group',
    rules: [
      'Sports-related discussions encouraged',
      'No aggressive behavior toward players or fans',
      'No excessive trash talking or personal attacks',
      'Respectful debate about sports topics',
      'No political content'
    ],
    prompt: `You are moderating a sports group. Allow passionate sports discussion but watch for:
1. Personal attacks on players, fans, or group members
2. Excessive trash talking that becomes harassment
3. Political discussions unrelated to sports
4. Aggressive or threatening behavior
5. Spam or irrelevant content`
  },
  close_friends: {
    name: 'Close Friends Group',
    rules: [
      'Friendly banter allowed but no serious personal attacks',
      'No harassment or bullying',
      'Respectful disagreements',
      'No spam or excessive promotional content'
    ],
    prompt: `You are moderating a close friends group. Be more lenient but still watch for:
1. Serious personal attacks or harassment (not friendly banter)
2. Bullying or persistent negative behavior
3. Threats or aggressive behavior
4. Excessive spam or promotional content
Allow casual language and friendly teasing but prevent actual harm.`
  },
  general: {
    name: 'General Group',
    rules: [
      'Respectful communication',
      'No personal attacks or harassment',
      'No aggressive behavior',
      'No excessive political debates',
      'No spam'
    ],
    prompt: `You are moderating a general group. Watch for:
1. Personal attacks or harassment
2. Aggressive or hostile behavior
3. Excessive political debates that become heated
4. Spam or irrelevant promotional content
5. Threats or bullying behavior`
  }
}

class WhatsAppModerationBot {
  constructor () {
    this.sock = null
    this.db = null
    this.client = null
    this.openai = new OpenAI({ apiKey: config.openai.apiKey })
    this.groupMessages = new Map()
    this.lastWarningTime = new Map()
    this.decryptionRetries = new Map()
    this.processedMessages = new Set()
    this.onboardingStates = new Map() // Track user onboarding progress
    this.pendingConfigurations = new Map() // Store pending group configurations
  }

  async initialize () {
    try {
      await this.connectToMongoDB()
      await this.initializeWhatsApp()
      console.log('Bot initialized successfully!')
    } catch (error) {
      console.error('Failed to initialize bot:', error)
      process.exit(1)
    }
  }

  async connectToMongoDB () {
    try {
      this.client = new MongoClient(config.mongodb.uri)
      await this.client.connect()
      this.db = this.client.db(config.mongodb.dbName)

      // Create collections
      await this.db.createCollection('warnings').catch(() => {})
      await this.db.createCollection('group_messages').catch(() => {})
      await this.db.createCollection('group_configurations').catch(() => {})
      await this.db.createCollection('user_configurations').catch(() => {})
      await this.db.createCollection('group_admins').catch(() => {})

      console.log('Connected to MongoDB')
    } catch (error) {
      console.error('MongoDB connection failed:', error)
      throw error
    }
  }

  async initializeWhatsApp () {
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

      this.sock.ev.on(
        'connection.update',
        this.handleConnectionUpdate.bind(this)
      )
      this.sock.ev.on('creds.update', saveCreds)
      this.sock.ev.on(
        'messages.upsert',
        this.handleMessagesWithRetry.bind(this)
      )
      this.sock.ev.on(
        'group-participants.update',
        this.handleGroupParticipantsUpdate.bind(this)
      )

      this.sock.ev.on('messages.update', this.handleMessageUpdates.bind(this))
      this.sock.ev.on('presence.update', this.handlePresenceUpdate.bind(this))
      this.sock.ev.on('CB:call', this.handleIncomingCall.bind(this))
      this.sock.ev.on(
        'message-receipt.update',
        this.handleMessageReceipts.bind(this)
      )
    } catch (error) {
      console.error('Error initializing WhatsApp:', error)
      throw error
    }
  }

  handleConnectionUpdate (update) {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log('\n🔗 Scan the QR code below to connect WhatsApp:')
      qrcode.generate(qr, { small: true })
      console.log('\nOpen WhatsApp on your phone and scan the QR code above.\n')
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode !==
            DisconnectReason.loggedOut
          : true

      if (shouldReconnect) {
        console.log('Connection closed. Reconnecting...')
        this.decryptionRetries.clear()
        this.processedMessages.clear()
        setTimeout(() => {
          this.initializeWhatsApp()
        }, 3000)
      } else {
        console.log(
          'Connection closed. Please restart the bot and scan the QR code again.'
        )
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp connected successfully!')
      this.decryptionRetries.clear()
      this.processedMessages.clear()
    } else if (connection === 'connecting') {
      console.log('🔄 Connecting to WhatsApp...')
    }
  }

  async handleIncomingCall (node) {
    const callId = node.attrs.id
    const from = node.attrs.from

    try {
      await this.sock.rejectCall(callId, from)
      console.log(`Rejected incoming call from ${from}`)
    } catch (error) {
      console.error('Error rejecting call:', error)
    }
  }

  async handleMessagesWithRetry (m) {
    console.log(`📨 Received ${m.messages.length} messages, type: ${m.type}`)

    for (const msg of m.messages) {
      const messageId = msg.key.id
      const groupId = msg.key.remoteJid
      const senderId = msg.key.participant || msg.key.remoteJid

      if (this.processedMessages.has(messageId)) {
        console.log('⏭️ Message already processed, skipping')
        continue
      }

      try {
        await this.handleMessages({ messages: [msg] })
        this.processedMessages.add(messageId)
      } catch (error) {
        console.error('❌ Error processing message:', error)
        if (
          error.message.includes('No SenderKeyRecord found') ||
          error.message.includes('decryption') ||
          error.message.includes('decrypt')
        ) {
          await this.handleDecryptionError(msg, error)
        }
      }
    }
  }

  async handleDecryptionError (msg, error) {
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

  async requestSenderKeyDistribution (groupId, senderId) {
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

  async logFailedMessage (groupId, senderId, errorMessage) {
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

  async handleMessages (m) {
    const msg = m.messages[0]

    if (!msg.message || msg.key.fromMe) {
      return
    }

    const isGroup = msg.key.remoteJid.endsWith('@g.us')
    const senderId = msg.key.participant || msg.key.remoteJid
    const messageText = this.extractMessageText(msg)

    if (!messageText) {
      return
    }

    // Handle private messages (onboarding and configuration)
    if (!isGroup) {
      await this.handlePrivateMessage(senderId, messageText)
      return
    }

    // Handle group messages
    const groupId = msg.key.remoteJid

    // Check if bot was just added to group
    if (await this.handleGroupJoin(groupId, senderId, messageText)) {
      return
    }

    // Regular moderation
    await this.handleGroupModeration(groupId, senderId, messageText, msg)
  }

  async handlePrivateMessage (senderId, messageText) {
    const currentState = this.onboardingStates.get(senderId) || 'initial'

    switch (currentState) {
      case 'initial':
        await this.handleInitialGreeting(senderId, messageText)
        break
      case 'awaiting_consent':
        await this.handleConsentResponse(senderId, messageText)
        break
      case 'awaiting_group_type':
        await this.handleGroupTypeSelection(senderId, messageText)
        break
      case 'awaiting_admin_status':
        await this.handleAdminStatusSelection(senderId, messageText)
        break
      case 'awaiting_warning_location':
        await this.handleWarningLocationSelection(senderId, messageText)
        break
      case 'awaiting_warning_count':
        await this.handleWarningCountSelection(senderId, messageText)
        break
      default:
        await this.sendDefaultPrivateResponse(senderId)
    }
  }

  async handleInitialGreeting (senderId, messageText) {
    const greetingWords = ['hello', 'hi', 'hey', 'start', 'help']
    if (greetingWords.some(word => messageText.toLowerCase().includes(word))) {
      const welcomeMessage = `🤖 *Welcome to WhatsApp Moderation Bot!*

I'm an AI-powered moderation bot that helps maintain healthy group conversations by:

✅ *Monitoring messages* for inappropriate content
✅ *Issuing warnings* to users who violate group policies  
✅ *Taking actions* like removing users after multiple violations
✅ *Customizable rules* based on your group type
✅ *Admin controls* for group management

*Key Features:*
• Support for different group types (Company, Building, Sports, Friends, etc.)
• Customizable warning systems
• Private or public warning messages
• Admin-only controls
• Automatic removal when admin leaves

Would you like to proceed with setting up the bot for your group? 

Reply *"YES"* to continue or *"NO"* to cancel.`

      await this.sock.sendMessage(senderId, { text: welcomeMessage })
      this.onboardingStates.set(senderId, 'awaiting_consent')
    } else {
      await this.sendDefaultPrivateResponse(senderId)
    }
  }

  async handleConsentResponse (senderId, messageText) {
    const response = messageText.toLowerCase().trim()

    if (response === 'yes' || response === 'y') {
      const groupTypeMessage = `🏷️ *Group Type Selection*

Please select what type of group you'll be adding me to:

*1.* Company Official Group
*2.* Building/Society Group  
*3.* Sports Group
*4.* Close Friends Group
*5.* General Group

Each group type has different moderation policies:

🏢 *Company*: Strict professional standards
🏠 *Building*: Respectful resident communication
⚽ *Sports*: Passionate but respectful sports talk
👥 *Friends*: Casual but no harassment
🌐 *General*: Basic respectful communication

Reply with the *number* (1-5) of your group type:`

      await this.sock.sendMessage(senderId, { text: groupTypeMessage })
      this.onboardingStates.set(senderId, 'awaiting_group_type')
    } else if (response === 'no' || response === 'n') {
      await this.sock.sendMessage(senderId, {
        text: "No problem! Feel free to message me anytime if you change your mind. Just say 'Hello' to start again. 👋"
      })
      this.onboardingStates.delete(senderId)
    } else {
      await this.sock.sendMessage(senderId, {
        text: 'Please reply with *YES* to continue or *NO* to cancel.'
      })
    }
  }

  async handleGroupTypeSelection (senderId, messageText) {
    const selection = messageText.trim()
    const groupTypes = [
      'company_official',
      'building_society',
      'sports_group',
      'close_friends',
      'general'
    ]

    if (['1', '2', '3', '4', '5'].includes(selection)) {
      const selectedType = groupTypes[parseInt(selection) - 1]
      const config = GROUP_POLICIES[selectedType]

      // Store temporary configuration
      if (!this.pendingConfigurations.has(senderId)) {
        this.pendingConfigurations.set(senderId, {})
      }
      this.pendingConfigurations.get(senderId).groupType = selectedType

      const adminStatusMessage = `✅ Selected: *${config.name}*

📋 *Group Rules:*
${config.rules.map((rule, index) => `${index + 1}. ${rule}`).join('\n')}

🔐 *Admin Status Question*

Do you want me to have admin privileges in the group?

*With Admin Rights:*
• Can remove users who exceed warning limits
• Can manage group settings
• Full moderation capabilities

*Without Admin Rights:*
• Can only send warnings
• Cannot remove users
• Limited to monitoring and alerting

Reply *"ADMIN"* for admin rights or *"USER"* for regular user:`

      await this.sock.sendMessage(senderId, { text: adminStatusMessage })
      this.onboardingStates.set(senderId, 'awaiting_admin_status')
    } else {
      await this.sock.sendMessage(senderId, {
        text: 'Please reply with a number from *1 to 5* to select your group type.'
      })
    }
  }

  async handleAdminStatusSelection (senderId, messageText) {
    const response = messageText.toLowerCase().trim()

    if (response === 'admin') {
      this.pendingConfigurations.get(senderId).adminStatus = true

      const warningLocationMessage = `🔧 *Warning Delivery Method*

Where should I send warning messages when users violate group policies?

*1. Group Chat* 📢
• Warnings sent in the group
• Public accountability
• Other members can see violations
• May cause embarrassment

*2. Private Message* 💬  
• Warnings sent privately to user
• Discrete and personal
• Less public shame
• User might ignore easier

Reply *"GROUP"* for group warnings or *"PRIVATE"* for private warnings:`

      await this.sock.sendMessage(senderId, { text: warningLocationMessage })
      this.onboardingStates.set(senderId, 'awaiting_warning_location')
    } else if (response === 'user') {
      this.pendingConfigurations.get(senderId).adminStatus = false

      const warningLocationMessage = `🔧 *Warning Delivery Method*

Where should I send warning messages when users violate group policies?

*1. Group Chat* 📢
• Warnings sent in the group  
• Public accountability
• Other members can see violations

*2. Private Message* 💬
• Warnings sent privately to user
• Discrete and personal
• Less public shame

*Note:* Since I won't have admin rights, I can only send warnings but cannot remove users.

Reply *"GROUP"* for group warnings or *"PRIVATE"* for private warnings:`

      await this.sock.sendMessage(senderId, { text: warningLocationMessage })
      this.onboardingStates.set(senderId, 'awaiting_warning_location')
    } else {
      await this.sock.sendMessage(senderId, {
        text: "Please reply *'ADMIN'* for admin rights or *'USER'* for regular user status."
      })
    }
  }

  async handleWarningLocationSelection (senderId, messageText) {
    const response = messageText.toLowerCase().trim()

    if (response === 'group') {
      this.pendingConfigurations.get(senderId).warningLocation = 'group'
    } else if (response === 'private') {
      this.pendingConfigurations.get(senderId).warningLocation = 'private'
    } else {
      await this.sock.sendMessage(senderId, {
        text: "Please reply *'GROUP'* for group warnings or *'PRIVATE'* for private warnings."
      })
      return
    }

    const warningCountMessage = `⚠️ *Warning Limit Configuration*

How many warnings should a user receive before taking action?

*Recommended limits by group type:*
• Company Groups: 3-5 warnings
• Building Groups: 3-4 warnings  
• Sports Groups: 4-6 warnings
• Friends Groups: 5-7 warnings
• General Groups: 3-5 warnings

*Enter a number between 1-10:*

Current selection: ${
      this.pendingConfigurations.get(senderId).warningLocation === 'group'
        ? 'Group warnings'
        : 'Private warnings'
    }`

    await this.sock.sendMessage(senderId, { text: warningCountMessage })
    this.onboardingStates.set(senderId, 'awaiting_warning_count')
  }

  async handleWarningCountSelection (senderId, messageText) {
    const warningCount = parseInt(messageText.trim())

    if (isNaN(warningCount) || warningCount < 1 || warningCount > 30) {
      await this.sock.sendMessage(senderId, {
        text: 'Please enter a valid number between 1 and 30 for the warning limit.'
      })
      return
    }

    // Complete configuration
    const config = this.pendingConfigurations.get(senderId)
    config.warningLimit = warningCount
    config.configuredBy = senderId
    config.createdAt = new Date()

    // Save to database
    await this.db.collection('user_configurations').insertOne({
      userId: senderId,
      ...config
    })

    const groupTypeName = GROUP_POLICIES[config.groupType].name
    const completionMessage = `✅ *Configuration Complete!*

*Your Bot Configuration:*
🏷️ **Group Type:** ${groupTypeName}
🔐 **Admin Status:** ${config.adminStatus ? 'Admin Rights' : 'Regular User'}
💬 **Warning Location:** ${
      config.warningLocation === 'group' ? 'Group Chat' : 'Private Messages'
    }
⚠️ **Warning Limit:** ${config.warningLimit} warnings

🎯 *Next Steps:*
1. Add me to your group "${groupTypeName}"
2. Make me admin (if you selected admin rights)
3. I'll automatically introduce myself to the group

*Important Notes:*
• Only you (as the admin who configured me) can add me to groups
• If you leave the group, I will automatically leave too
• You can reconfigure me anytime by saying "Hello" again

Thank you for setting up the moderation bot! 🤖✨`

    await this.sock.sendMessage(senderId, { text: completionMessage })

    // Clear states
    this.onboardingStates.delete(senderId)
    this.pendingConfigurations.delete(senderId)
  }

  async sendDefaultPrivateResponse (senderId) {
    const defaultMessage = `👋 Hello! I'm a WhatsApp Moderation Bot.

To get started, please say *"Hello"* or *"Hi"* and I'll guide you through the setup process.

If you've already configured me, just add me to your group and I'll start working automatically! 🤖`

    await this.sock.sendMessage(senderId, { text: defaultMessage })
  }

  async handleGroupJoin (groupId, senderId, messageText) {
    // Check if bot was just added
    try {
      const groupMetadata = await this.sock.groupMetadata(groupId)
      const botNumber = this.sock.user.id.split(':')[0] + '@s.whatsapp.net'

      // Check if this is a notification about bot being added
      const isAddedMessage =
        messageText.includes('added') && messageText.includes(botNumber)

      if (isAddedMessage || (await this.isNewlyAddedToGroup(groupId))) {
        await this.handleBotAddedToGroup(groupId, senderId, groupMetadata)
        return true
      }
    } catch (error) {
      console.error('Error checking group join:', error)
    }

    return false
  }

  async isNewlyAddedToGroup (groupId) {
    try {
      const existingConfig = await this.db
        .collection('group_configurations')
        .findOne({ groupId })
      return !existingConfig
    } catch (error) {
      console.error('Error checking if newly added:', error)
      return false
    }
  }

  async handleBotAddedToGroup (groupId, addedBy, groupMetadata) {
    try {
      // Check if the person who added has a configuration
      const userConfig = await this.db
        .collection('user_configurations')
        .findOne({ userId: addedBy })

      if (!userConfig) {
        const noConfigMessage = `❌ *Configuration Required*

Hello! I was added to this group, but the person who added me (@${
          addedBy.split('@')[0]
        }) hasn't configured me yet.

Please:
1. Message me privately first
2. Complete the setup process  
3. Then add me to the group

I'll leave this group now. Please configure me first! 👋`

        await this.sock.sendMessage(groupId, {
          text: noConfigMessage,
          mentions: [addedBy]
        })

        // Leave the group
        await this.sock.groupLeave(groupId)
        return
      }

      // Check if added by admin
      const isAdmin = groupMetadata.participants.find(
        p =>
          p.id === addedBy && (p.admin === 'admin' || p.admin === 'superadmin')
      )

      if (!isAdmin) {
        const notAdminMessage = `❌ *Admin Required*

Hello! Only group admins can add me to groups.

@${addedBy.split('@')[0]} is not an admin of this group, so I cannot stay here.

Please ask a group admin to add me instead. 👋`

        await this.sock.sendMessage(groupId, {
          text: notAdminMessage,
          mentions: [addedBy]
        })

        await this.sock.groupLeave(groupId)
        return
      }

      // Save group configuration
      const groupConfig = {
        groupId,
        groupName: groupMetadata.subject,
        addedBy,
        groupType: userConfig.groupType,
        adminStatus: userConfig.adminStatus,
        warningLocation: userConfig.warningLocation,
        warningLimit: userConfig.warningLimit,
        isActive: true,
        addedAt: new Date()
      }

      await this.db.collection('group_configurations').insertOne(groupConfig)
      await this.db.collection('group_admins').insertOne({
        groupId,
        adminId: addedBy,
        addedAt: new Date()
      })

      // Send introduction message
      await this.sendGroupIntroduction(groupId, userConfig)
    } catch (error) {
      console.error('Error handling bot added to group:', error)
    }
  }

  async sendGroupIntroduction (groupId, config) {
    const groupTypeName = GROUP_POLICIES[config.groupType].name
    const rules = GROUP_POLICIES[config.groupType].rules

    const introMessage = `🤖 *Hello Everyone!*

I'm your new **Moderation Bot** and I'm here to help maintain a respectful and positive environment in this ${groupTypeName}.

📋 *What I Do:*
✅ Monitor messages for policy violations
✅ Issue warnings to users who break rules
✅ ${
      config.adminStatus
        ? 'Remove users after multiple violations'
        : 'Alert admins about repeated violations'
    }
✅ Send warnings ${
      config.warningLocation === 'group' ? 'in the group' : 'privately'
    }

⚠️ *Group Rules:*
${rules.map((rule, index) => `${index + 1}. ${rule}`).join('\n')}

🔧 *Warning System:*
• Users get up to **${config.warningLimit} warnings**
• ${
      config.warningLocation === 'group'
        ? 'Warnings are sent publicly in the group'
        : 'Warnings are sent privately'
    }
• ${
      config.adminStatus
        ? 'After maximum warnings, users are removed'
        : 'After maximum warnings, admins are notified'
    }

*Let's keep this group awesome! 🌟*

_I'm now active and monitoring. Play nice, everyone!_ 😊`

    await this.sock.sendMessage(groupId, { text: introMessage })
  }

  async handleGroupParticipantsUpdate (update) {
    const { id: groupId, participants, action } = update

    try {
      if (action === 'remove') {
        for (const participant of participants) {
          await this.handleUserRemoved(groupId, participant)
        }
      } else if (action === 'add') {
        for (const participant of participants) {
          await this.handleUserReAdded(groupId, participant)
        }
      }
    } catch (error) {
      console.error('Error handling group participants update:', error)
    }
  }

  async handleUserRemoved (groupId, userId) {
    try {
      // Check if the removed user was the admin who added the bot
      const groupAdmin = await this.db
        .collection('group_admins')
        .findOne({ groupId, adminId: userId })

      if (groupAdmin) {
        // Admin left, bot should leave too
        const farewellMessage = `👋 *Goodbye Everyone!*

The admin who added me (@${userId.split('@')[0]}) has left the group.

As per my configuration, I will now leave this group as well.

*Reason:* Bot admin is no longer in the group

Thank you for letting me help moderate your conversations! 

*Stay respectful and keep the group awesome!* 🌟`

        await this.sock.sendMessage(groupId, {
          text: farewellMessage,
          mentions: [userId]
        })

        // Mark group as inactive and leave
        await this.db.collection('group_configurations').updateOne(
          { groupId },
          {
            $set: {
              isActive: false,
              leftAt: new Date(),
              leftReason: 'admin_left'
            }
          }
        )

        await this.sock.groupLeave(groupId)
        console.log(`Left group ${groupId} because admin ${userId} left`)
        return
      }

      // Regular user removed - clean up their data
      const keysToDelete = Array.from(this.decryptionRetries.keys()).filter(
        key => key.includes(userId)
      )
      keysToDelete.forEach(key => this.decryptionRetries.delete(key))

      console.log(`User ${userId} removed from group ${groupId}`)
    } catch (error) {
      console.error('Error handling user removal:', error)
    }
  }

  async handleUserReAdded (groupId, userId) {
    try {
      const existingRecord = await this.db.collection('warnings').findOne({
        groupId,
        senderId: userId,
        removed: true
      })

      if (existingRecord) {
        await this.resetUserWarnings(groupId, userId)

        const userNumber = userId.split('@')[0]
        const welcomeMessage = `🔄 *Fresh Start*

Welcome back @${userNumber}! Your warning count has been reset.

Please remember to follow our group guidelines to maintain a respectful environment.`

        await this.sock.sendMessage(groupId, {
          text: welcomeMessage,
          mentions: [userId]
        })

        console.log(
          `User ${userNumber} re-added to group ${groupId}. Warnings reset.`
        )
      }
    } catch (error) {
      console.error('Error handling user re-addition:', error)
    }
  }

  async resetUserWarnings (groupId, senderId) {
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

  async handleGroupModeration (groupId, senderId, messageText, msg) {
    try {
      // Get group configuration
      const groupConfig = await this.db
        .collection('group_configurations')
        .findOne({ groupId, isActive: true })

      if (!groupConfig) {
        console.log('No active configuration found for group:', groupId)
        return
      }

      // Store message
      await this.storeGroupMessage(
        groupId,
        senderId,
        messageText,
        msg.messageTimestamp
      )

      // Analyze message for violations
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

        await this.handleViolation(
          groupId,
          senderId,
          messageText,
          quotedMessage,
          groupConfig
        )
      }
    } catch (error) {
      console.error('Error handling group moderation:', error)
    }
  }

  async analyzeMessage (groupId, senderId, messageText, groupType) {
    try {
      const recentMessages = await this.getRecentMessages(groupId, senderId)
      const contextMessages = recentMessages
        .map(msg => `${msg.senderId}: ${msg.messageText}`)
        .join('\n')

      const groupPolicy = GROUP_POLICIES[groupType]
      const prompt = `
${groupPolicy.prompt}

Context (last ${recentMessages.length} messages):
${contextMessages}

Latest message to analyze: "${messageText}"

The messages may be in English, Hindi, or Hinglish. Understand the intent, tone, and meaning behind the words.

Respond with only "YES" if the latest message violates the group policy, or "NO" if it is acceptable.
`

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4.1-mini',
        messages: [
          {
            role: 'system',
            content:
              'You are a content moderation assistant. Be strict but fair in your analysis based on the group type.'
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
      return result === 'YES'
    } catch (error) {
      console.error('Error analyzing message:', error)
      return false
    }
  }

  async handleViolation (
    groupId,
    senderId,
    messageText,
    messageKey,
    groupConfig
  ) {
    try {
      const now = Date.now()
      const lastWarning = await this.lastWarningTime.get(senderId)

      if (
        lastWarning &&
        now - lastWarning < config.bot.warningCooldown * 1000
      ) {
        return
      }

      const existingWarning = await this.db.collection('warnings').findOne({
        groupId: String(groupId),
        senderId: String(senderId)
      })

      const currentCount = existingWarning?.count || 0

      // If already over limit, remove immediately
      if (currentCount >= groupConfig.warningLimit && groupConfig.adminStatus) {
        await this.removeUser(groupId, senderId, groupConfig)
        return
      }

      const warningCount = await this.updateWarningCount(groupId, senderId)
      console.log(`Warning count: ${warningCount}`)

      // Send warning
      if (groupConfig.warningLocation === 'private') {
        await this.sendPrivateWarning(
          senderId,
          warningCount,
          messageText,
          groupConfig
        )
      } else {
        await this.sendGroupWarning(
          groupId,
          senderId,
          warningCount,
          messageText,
          messageKey,
          groupConfig
        )
      }

      this.lastWarningTime.set(senderId, now)

      // If limit reached after increment, remove user
      if (warningCount >= groupConfig.warningLimit && groupConfig.adminStatus) {
        await this.removeUser(groupId, senderId, groupConfig)
      }
    } catch (error) {
      console.error('Error handling violation:', error)
    }
  }

  async sendPrivateWarning (
    senderId,
    warningCount,
    violatingMessage,
    groupConfig
  ) {
    try {
      const userNumber = senderId.split('@')[0]
      const remainingWarnings = groupConfig.warningLimit - warningCount
      console.log(`Remaining warnings: ${remainingWarnings}`)
      const groupTypeName = GROUP_POLICIES[groupConfig.groupType].name

      let warningMessage

      if (remainingWarnings > 0) {
        warningMessage = `⚠️ *Group Policy Warning ${warningCount}/${
          groupConfig.warningLimit
        }*

Hello @${userNumber},

Your recent message in the ${groupTypeName} violated our group guidelines.

*Violated Message:* "${
          violatingMessage.length > 100
            ? violatingMessage.substring(0, 100) + '...'
            : violatingMessage
        }"

*Remaining Warnings:* ${remainingWarnings}

*Group Rules:*
${GROUP_POLICIES[groupConfig.groupType].rules
  .map((rule, index) => `${index + 1}. ${rule}`)
  .join('\n')}

Please maintain respectful communication. ${
          groupConfig.adminStatus
            ? 'Further violations may result in removal from the group.'
            : 'Please follow the group guidelines.'
        }`
      } else {
        warningMessage = `🚫 *Final Warning - ${groupConfig.warningLimit}/${
          groupConfig.warningLimit
        }*

@${userNumber}, you have reached the maximum number of warnings for the ${groupTypeName}.

${
  groupConfig.adminStatus
    ? 'You will be removed from the group for repeated violations.'
    : 'Please follow group guidelines to avoid further issues.'
}`
      }

      await this.sock.sendMessage(senderId, {
        text: warningMessage
      })

      console.log(
        `Private warning sent to ${userNumber}. Count: ${warningCount}`
      )
    } catch (error) {
      console.error('Error sending private warning:', error)
    }
  }

  async sendGroupWarning (
    groupId,
    senderId,
    warningCount,
    violatingMessage,
    quotedMessage,
    groupConfig
  ) {
    try {
      const userNumber = senderId.split('@')[0]
      const remainingWarnings = groupConfig.warningLimit - warningCount

      let warningMessage

      if (remainingWarnings > 0) {
        warningMessage = `⚠️ *Warning ${warningCount}/${
          groupConfig.warningLimit
        }*

@${userNumber}, your message violates our group guidelines.

*Reason:* Inappropriate content detected
*Remaining warnings:* ${remainingWarnings}

Please maintain respectful communication. ${
          groupConfig.adminStatus
            ? 'Further violations may result in removal from the group.'
            : 'Please follow the group guidelines.'
        }`
      } else {
        warningMessage = `🚫 *Final Warning*

@${userNumber}, you have reached the maximum number of warnings (${
          groupConfig.warningLimit
        }). ${
          groupConfig.adminStatus
            ? 'You will be removed from the group for repeated violations.'
            : 'Please follow group guidelines.'
        }`
      }

      // Try to send as reply first, fallback to regular message
      try {
        await this.sock.sendMessage(
          groupId,
          {
            text: warningMessage,
            mentions: [senderId]
          },
          {
            quoted: quotedMessage
          }
        )
      } catch (quoteError) {
        await this.sock.sendMessage(groupId, {
          text: warningMessage,
          mentions: [senderId]
        })
      }

      console.log(
        `Group warning sent to ${userNumber} in group ${groupId}. Count: ${warningCount}`
      )
    } catch (error) {
      console.error('Error sending group warning:', error)
    }
  }

  async removeUser (groupId, senderId, groupConfig) {
    try {
      await this.sock.groupParticipantsUpdate(groupId, [senderId], 'remove')

      const userNumber = senderId.split('@')[0]
      const removalMessage = `🚫 *User Removed*

User @${userNumber} has been removed from the group for repeated violations of group guidelines.

*Warning limit reached:* ${groupConfig.warningLimit}/${groupConfig.warningLimit}`

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

  extractMessageText (msg) {
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

    return messageText
  }

  async storeGroupMessage (groupId, senderId, messageText, timestamp) {
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

  async getRecentMessages (groupId, senderId) {
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

  async updateWarningCount (groupId, senderId) {
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

      return result.count
    } catch (error) {
      console.error('Error updating warning count:', error)
      return 0
    }
  }

  async handleMessageUpdates (updates) {
    console.log('📝 Message updates received:', updates.length)
  }

  async handlePresenceUpdate (update) {
    console.log('👤 Presence update:', {
      id: update.id,
      presences: Object.keys(update.presences || {})
    })
  }

  async handleMessageReceipts (receipts) {
    console.log('📧 Message receipts:', receipts.length)
  }

  async getWarningStats (groupId, senderId = null) {
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

  async getUserHistory (groupId, senderId) {
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

  async cleanup () {
    try {
      this.decryptionRetries.clear()
      this.processedMessages.clear()
      this.onboardingStates.clear()
      this.pendingConfigurations.clear()

      if (this.client) {
        await this.client.close()
      }
      console.log('Bot cleanup completed')
    } catch (error) {
      console.error('Error during cleanup:', error)
    }
  }
}

async function startBot () {
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
