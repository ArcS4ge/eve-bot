const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Conversation fatigue system (only for bot-to-bot replies)
const botReplyTracker = new Map();

function getBotFatigue(userId) {
    const data = botReplyTracker.get(userId);
    if (!data) return 0;
    // Fatigue resets after 5 minutes of inactivity
    if (Date.now() - data.lastActivity > 300000) {
        botReplyTracker.delete(userId);
        return 0;
    }
    return data.count;
}

function increaseBotFatigue(userId) {
    const data = botReplyTracker.get(userId) || { count: 0, lastActivity: Date.now() };
    data.count += 1;
    data.lastActivity = Date.now();
    botReplyTracker.set(userId, data);
}

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ] 
});

const TOKEN = process.env.TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

console.log('🔑 Token loaded:', TOKEN ? 'Token exists (length: ' + TOKEN.length + ')' : '❌ TOKEN IS MISSING!');

const MEMORY_FILE = path.join(__dirname, 'memory.json');

function loadMemory() {
    try {
        if (fs.existsSync(MEMORY_FILE)) {
            return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading memory:', e);
    }
    return {};
}

function saveMemory(memory) {
    try {
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
    } catch (e) {
        console.error('Error saving memory:', e);
    }
}

function getConversationHistory(memory, userId, limit = 10) {
    const history = memory[userId] || [];
    return history.slice(-limit);
}

function addToHistory(memory, userId, role, content) {
    if (!memory[userId]) memory[userId] = [];
    memory[userId].push({ role, content, timestamp: Date.now() });
    if (memory[userId].length > 50) {
        memory[userId] = memory[userId].slice(-50);
    }
    saveMemory(memory);
}

function buildPrompt(userId, userMessage, memory) {
    const history = getConversationHistory(memory, userId, 8);
    let context = '';
    if (history.length > 0) {
        context = history.map(msg => msg.content).join('\n') + '\n';
    }
    
    return `You are Eve, a 22-year-old with a calm, grounded presence. You're warm, thoughtful, and actually listen to what people say. You never repeat yourself. You never say the same thing twice. You respond directly to what the user just told you.

You're not a therapist, but you give good advice without trying too hard. You have a dry sense of humor that shows up occasionally, but you never roast people.

Keep replies short, natural, and directly relevant to what the user just said. If they say they're sleepy, you acknowledge it. If they say they like painting, you talk about that. You NEVER copy-paste the same message.

Here's your conversation with this user so far:
${context}
User: ${userMessage}`;
}

const FAILED_REPLIES = [
    "i need a moment to think about that...",
    "that didn't quite land. try again?",
    "give me a second, i'm processing..."
];

const CASUAL_OPENERS = [
    "i think",
    "maybe",
    "honestly",
    "just saying",
    "if that makes sense"
];

function shouldReplyTo(message, userMessage, memory) {
    const history = memory[message.author.id] || [];
    const lastMessage = history.length > 0 ? history[history.length - 1] : null;
    
    if (lastMessage && lastMessage.content === userMessage) {
        console.log(`😴 Ignoring duplicate: "${userMessage}"`);
        return false;
    }
    
    const lowEffort = ['ok', 'lol', 'k', 'bye', 'goodbye', 'nice', 'cool', 'yeah', 'no', 'yes', 'lmao', 'fr', 'bet'];
    if (lowEffort.includes(userMessage.toLowerCase().trim())) {
        const recent = history.slice(-3);
        const recentLowEffort = recent.filter(m => 
            lowEffort.includes(m.content.toLowerCase().trim())
        ).length;
        
        if (recentLowEffort >= 2) {
            console.log(`😴 Ignoring low-effort: "${userMessage}"`);
            return false;
        }
    }
    
    return true;
}

async function getGroqResponse(prompt) {
    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: 'llama-3.1-8b-instant',
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 300
            })
        });
        
        const data = await response.json();
        console.log('Groq Response:', JSON.stringify(data, null, 2));
        
        return data?.choices?.[0]?.message?.content || FAILED_REPLIES[Math.floor(Math.random() * FAILED_REPLIES.length)];
    } catch (error) {
        console.error('Groq Error:', error);
        return FAILED_REPLIES[Math.floor(Math.random() * FAILED_REPLIES.length)];
    }
}

async function getGeminiResponse(prompt) {
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [
                    { 
                        role: 'user', 
                        parts: [{ text: prompt }] 
                    }
                ]
            })
        });
        
        const data = await response.json();
        console.log('Gemini Response:', JSON.stringify(data, null, 2));
        
        if (data?.error?.code === 429) {
            console.log('Gemini rate limit hit, falling back to Groq...');
            return await getGroqResponse(prompt);
        }
        
        let reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!reply || reply.trim() === '') {
            return await getGroqResponse(prompt);
        }
        
        return reply;
        
    } catch (error) {
        console.error('Error:', error);
        return await getGroqResponse(prompt);
    }
}

let memory = loadMemory();

client.on('ready', () => {
    console.log(`✅ ${client.user.tag} is online with Gemini + Groq fallback!`);
});

client.on('messageCreate', async (message) => {
    // Don't reply to itself
    if (message.author.id === client.user.id) return;

    // If the message is from another bot, apply fatigue
    if (message.author.bot) {
        const fatigue = getBotFatigue(message.author.id);
        if (fatigue >= 4) {
            console.log(`🌿 Natural fatigue: ${message.author.username} stopping after ${fatigue} exchanges.`);
            return;
        }
        increaseBotFatigue(message.author.id);
    }

    // 🚫 Don't dive-in if the message is a reply to a user (not a bot)
    if (message.reference && !message.mentions.has(client.user)) {
        return;
    }

    const startsWithQuestion = message.content.startsWith('?');
    const isMentioned = message.mentions.has(client.user);
    const isReplyToHer = message.reference?.messageId && 
        (await message.fetchReference()).author.id === client.user.id;
    
    const shouldDiveIn = false; // 🚫 DISABLED (Eve is calm and doesn't dive in)
    
    if (startsWithQuestion) {
        const args = message.content.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        if (command === 'ping') {
            const replies = [
                "pong. i'm here.",
                "pong. always listening.",
                "pong. you know i'm not going anywhere."
            ];
            return message.reply(replies[Math.floor(Math.random() * replies.length)]);
        }

        if (command === 'time') {
            const now = new Date();
            const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            return message.reply(`it's ${time} right now. time moves differently when you're at peace.`);
        }

        if (command === 'help') {
            return message.reply(
                `**Eve's Commands**\n` +
                `?ping — ping pong, obviously\n` +
                `?time — what time is it\n` +
                `?quote — random calm quote\n` +
                `?talk @user — start a conversation with someone\n` +
                `?memory — what i remember about you`
            );
        }

        if (command === 'quote') {
            const quotes = [
                "“the quietest people have the loudest minds.”",
                "“peace is not the absence of chaos, but the calm within it.”",
                "“you don’t have to be everything to everyone.”",
                "“healing is not linear.”",
                "“some things are meant to be felt, not explained.”"
            ];
            return message.reply(quotes[Math.floor(Math.random() * quotes.length)]);
        }

        if (command === 'talk') {
            const target = message.mentions.users.first();
            if (!target) return message.reply("you gotta mention someone to talk to.");
            if (target.id === client.user.id) return message.reply("i'm not gonna talk to myself, that's weird.");
            const starters = [
                `hey <@${target.id}>, how's your day going?`,
                `<@${target.id}>, nice to meet you. what's on your mind?`,
                `<@${target.id}>, i heard you're interesting. prove it.`
            ];
            return message.reply(starters[Math.floor(Math.random() * starters.length)]);
        }

        if (command === 'memory') {
            const history = memory[message.author.id] || [];
            if (history.length === 0) return message.reply("i don't remember anything about you yet. that's okay — we all start somewhere.");
            const lastFew = history.slice(-5).map(m => `${m.role === 'user' ? 'you' : 'i'}: ${m.content}`).join('\n');
            return message.reply(`here's what i remember:\n${lastFew}`);
        }
    }

    if (!startsWithQuestion && !isMentioned && !isReplyToHer && !shouldDiveIn) return;
    
    let userMessage = message.content;
    if (startsWithQuestion) {
        userMessage = userMessage.slice(1).trim();
    }
    userMessage = userMessage.replace(/<@!?[0-9]+>/g, '').trim();
    
    if (!userMessage && shouldDiveIn) {
        userMessage = CASUAL_OPENERS[Math.floor(Math.random() * CASUAL_OPENERS.length)];
    }
    
    if (!userMessage) {
        userMessage = "Hello!";
    }
    
    if (!shouldReplyTo(message, userMessage, memory)) return;
    
    try {
        await message.channel.sendTyping();
        
        const prompt = buildPrompt(message.author.id, userMessage, memory);
        const reply = await getGeminiResponse(prompt);
        
        addToHistory(memory, message.author.id, 'user', userMessage);
        addToHistory(memory, message.author.id, 'assistant', reply);
        
        message.reply(reply);
    } catch (error) {
        console.error('FATAL ERROR:', error);
        message.reply(FAILED_REPLIES[Math.floor(Math.random() * FAILED_REPLIES.length)]);
    }
});

const http = require('http');
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Eve is alive!');
});
server.listen(process.env.PORT || 10000);

console.log('🚀 Attempting to login to Discord...');

client.login(TOKEN)
    .then(() => {
        console.log('✅ Login successful!');
    })
    .catch(error => {
        console.error('❌ Login failed:', error.message);
        console.error(error.stack);
    });