const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message);
    console.error(err.stack);
    // Don't exit - try to keep running
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit - try to keep running
});

// Heartbeat to keep the process alive and prevent idle timeout
setInterval(() => {
    console.log(`[${new Date().toISOString()}] Heartbeat - bot is running`);
}, 60000); // Log every minute

// Configuration
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'marknortonuk78/LifeOS';
const LIFEOS_PATH = path.join(__dirname, 'lifeos-vault');

if (!GROQ_API_KEY) {
    console.error('Error: GROQ_API_KEY environment variable not set');
    console.error('Get a free key at: https://console.groq.com/keys');
    process.exit(1);
}

if (!GITHUB_TOKEN) {
    console.error('Error: GITHUB_TOKEN environment variable not set');
    console.error('Create one at: https://github.com/settings/tokens');
    process.exit(1);
}

const groq = new Groq({ apiKey: GROQ_API_KEY });

// Git operations
function setupRepo() {
    const gitDir = path.join(LIFEOS_PATH, '.git');

    // If directory exists but isn't a valid git repo, remove it
    if (fs.existsSync(LIFEOS_PATH) && !fs.existsSync(gitDir)) {
        console.log('Found invalid repo directory, removing...');
        fs.rmSync(LIFEOS_PATH, { recursive: true, force: true });
    }

    if (!fs.existsSync(LIFEOS_PATH)) {
        console.log('Cloning LifeOS repo...');
        const repoUrl = `https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`;
        execSync(`git clone ${repoUrl} ${LIFEOS_PATH}`, { stdio: 'inherit' });
    } else {
        console.log('Pulling latest changes...');
        try {
            execSync('git pull', { cwd: LIFEOS_PATH, stdio: 'inherit' });
        } catch (e) {
            console.error('Git pull failed, continuing anyway:', e.message);
        }
    }

    // Configure git user for commits
    execSync('git config user.email "lifeos-bot@automated.local"', { cwd: LIFEOS_PATH });
    execSync('git config user.name "LifeOS Bot"', { cwd: LIFEOS_PATH });
}

function commitAndPush(filename, message) {
    try {
        execSync('git pull --rebase', { cwd: LIFEOS_PATH, stdio: 'inherit' });
        execSync(`git add "${filename}"`, { cwd: LIFEOS_PATH });
        execSync(`git commit -m "${message}"`, { cwd: LIFEOS_PATH });
        execSync('git push', { cwd: LIFEOS_PATH });
        console.log('Pushed to GitHub');
    } catch (error) {
        console.error('Git error:', error.message);
    }
}

// Initialize repo
setupRepo();

const INBOX_PATH = path.join(LIFEOS_PATH, 'Inbox');
if (!fs.existsSync(INBOX_PATH)) {
    fs.mkdirSync(INBOX_PATH, { recursive: true });
}

// Clear Chromium lock files that can cause issues after container restarts
const sessionPath = './whatsapp-session';
const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
if (fs.existsSync(sessionPath)) {
    for (const lockFile of lockFiles) {
        try {
            execSync(`find ${sessionPath} -name "${lockFile}" -delete 2>/dev/null || true`);
        } catch (e) {
            // Ignore errors
        }
    }
    console.log('Cleared any stale Chromium lock files');
}

let client = null;
let isReconnecting = false;

function createClient() {
    return new Client({
        authStrategy: new LocalAuth({ dataPath: sessionPath }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--no-zygote',
                '--disable-accelerated-2d-canvas',
                '--disable-software-rasterizer',
                '--disable-extensions'
            ]
        },
        restartOnAuthFail: true
    });
}

function setupClientEvents(client) {
    client.on('qr', async (qr) => {
        console.log('QR code generated. Saving to GitHub...');
        qrcode.generate(qr, { small: true });

        try {
            const qrImagePath = path.join(LIFEOS_PATH, 'whatsapp-qr.png');
            await QRCode.toFile(qrImagePath, qr, { width: 300 });
            execSync('git pull --rebase || true', { cwd: LIFEOS_PATH });
            execSync('git add whatsapp-qr.png', { cwd: LIFEOS_PATH });
            execSync('git commit -m "WhatsApp QR code - scan to connect"', { cwd: LIFEOS_PATH });
            execSync('git push', { cwd: LIFEOS_PATH });
            console.log('');
            console.log('==============================================');
            console.log('QR CODE SAVED! View it here:');
            console.log(`https://github.com/${GITHUB_REPO}/blob/main/whatsapp-qr.png`);
            console.log('==============================================');
            console.log('');
        } catch (error) {
            console.error('Failed to save QR to GitHub:', error.message);
        }
    });

    client.on('ready', () => {
        console.log('WhatsApp bot is ready!');
        console.log('Send voice notes to yourself to transcribe them to LifeOS Inbox.');
        isReconnecting = false;
    });

    client.on('authenticated', () => {
        console.log('Authenticated successfully');
    });

    client.on('auth_failure', (msg) => {
        console.error('Authentication failed:', msg);
        scheduleReconnect();
    });

    client.on('disconnected', (reason) => {
        console.log('Client disconnected:', reason);
        scheduleReconnect();
    });

    client.on('message_create', async (message) => {
        try {
            // Only process voice notes sent by me (not from groups or other people)
            if (!message.fromMe) {
                return;
            }

            if (message.hasMedia && (message.type === 'ptt' || message.type === 'audio')) {
                console.log('Voice note received, processing...');

                const media = await message.downloadMedia();

                if (!media) {
                    console.error('Failed to download media');
                    return;
                }

                const audioBuffer = Buffer.from(media.data, 'base64');

                console.log('Transcribing...');
                const text = await transcribeAudio(audioBuffer);
                console.log('Transcription:', text);

                const filename = await saveToInbox(text);

                await message.reply(`Saved to LifeOS: ${filename}`);
            }
        } catch (error) {
            console.error('Error processing message:', error);
            try {
                await message.reply('Error processing voice note. Check logs.');
            } catch (e) {
                console.error('Failed to send error reply:', e.message);
            }
        }
    });
}

function scheduleReconnect() {
    if (isReconnecting) {
        console.log('Already attempting to reconnect...');
        return;
    }
    isReconnecting = true;
    console.log('Scheduling reconnect in 10 seconds...');
    setTimeout(async () => {
        try {
            console.log('Attempting to reconnect...');
            if (client) {
                try {
                    await client.destroy();
                } catch (e) {
                    console.log('Error destroying old client:', e.message);
                }
            }
            client = createClient();
            setupClientEvents(client);
            await client.initialize();
        } catch (error) {
            console.error('Reconnect failed:', error.message);
            isReconnecting = false;
            scheduleReconnect();
        }
    }, 10000);
}

async function transcribeAudio(audioBuffer) {
    const tempPath = path.join(__dirname, `temp_audio_${Date.now()}.ogg`);
    fs.writeFileSync(tempPath, audioBuffer);

    try {
        const transcription = await groq.audio.transcriptions.create({
            file: fs.createReadStream(tempPath),
            model: 'whisper-large-v3',
        });
        return transcription.text;
    } finally {
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
    }
}

async function generateTitle(text) {
    try {
        const response = await groq.chat.completions.create({
            model: 'llama-3.1-8b-instant',
            messages: [{
                role: 'user',
                content: `Generate a very short title (3-5 words max) summarizing this voice note. Only respond with the title, nothing else. No quotes or punctuation.\n\nVoice note: "${text}"`
            }],
            max_tokens: 20,
            temperature: 0.3
        });
        let title = response.choices[0].message.content.trim();
        // Sanitize for filename: remove special chars, replace spaces with hyphens
        title = title.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '-').toLowerCase();
        return title || 'voice-note';
    } catch (error) {
        console.error('Failed to generate title:', error.message);
        return 'voice-note';
    }
}

async function saveToInbox(text) {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0];

    // Generate smart title
    const title = await generateTitle(text);
    const filename = `${title}.md`;
    const filepath = path.join(INBOX_PATH, filename);
    const relativePath = path.join('Inbox', filename);

    const content = `---
created: ${dateStr}
time: ${timeStr}
source: whatsapp-voice
tags: [inbox, voice-note]
---

# ${title.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}

${text}
`;

    fs.writeFileSync(filepath, content);
    console.log(`Saved to: ${filepath}`);

    // Commit and push to GitHub
    commitAndPush(relativePath, `Add voice note: ${title}`);

    return filename;
}

// Start the bot
console.log('Starting WhatsApp bot...');
client = createClient();
setupClientEvents(client);
client.initialize().catch(err => {
    console.error('Failed to initialize client:', err.message);
    scheduleReconnect();
});
