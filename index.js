const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
    if (!fs.existsSync(LIFEOS_PATH)) {
        console.log('Cloning LifeOS repo...');
        const repoUrl = `https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`;
        execSync(`git clone ${repoUrl} ${LIFEOS_PATH}`, { stdio: 'inherit' });
    } else {
        console.log('Pulling latest changes...');
        execSync('git pull', { cwd: LIFEOS_PATH, stdio: 'inherit' });
    }

    // Configure git user for commits
    execSync('git config user.email "lifeos-bot@automated.local"', { cwd: LIFEOS_PATH });
    execSync('git config user.name "LifeOS Bot"', { cwd: LIFEOS_PATH });
}

function commitAndPush(filename, message) {
    try {
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

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('Scan this QR code with WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('WhatsApp bot is ready!');
    console.log('Send voice notes to yourself to transcribe them to LifeOS Inbox.');
});

client.on('authenticated', () => {
    console.log('Authenticated successfully');
});

client.on('auth_failure', (msg) => {
    console.error('Authentication failed:', msg);
});

client.on('disconnected', (reason) => {
    console.log('Client disconnected:', reason);
    console.log('Attempting to reconnect...');
    setTimeout(() => client.initialize(), 5000);
});

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

function saveToInbox(text) {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');
    const filename = `${dateStr}-${timeStr}-voice-note.md`;
    const filepath = path.join(INBOX_PATH, filename);
    const relativePath = path.join('Inbox', filename);

    const content = `---
created: ${dateStr}
time: ${now.toTimeString().split(' ')[0]}
source: whatsapp-voice
tags: [inbox, voice-note]
---

# Voice Note

${text}
`;

    fs.writeFileSync(filepath, content);
    console.log(`Saved to: ${filepath}`);

    // Commit and push to GitHub
    commitAndPush(relativePath, `Add voice note: ${filename}`);

    return filename;
}

client.on('message', async (message) => {
    try {
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

            const filename = saveToInbox(text);

            await message.reply(`Saved to LifeOS: ${filename}`);
        }
    } catch (error) {
        console.error('Error processing message:', error);
        await message.reply('Error processing voice note. Check logs.');
    }
});

console.log('Starting WhatsApp bot...');
client.initialize();
