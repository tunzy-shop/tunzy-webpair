import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';

const router = express.Router();

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error('Error removing file:', e);
    }
}

router.get('/', async (req, res) => {
    let responseSent = false;
    let num = req.query.number;
    
    if (!num) {
        return res.status(400).send({ 
            code: 'Phone number required. Add ?number=15551234567 to URL' 
        });
    }
    
    let dirs = './' + (num || `session`);
    await removeFile(dirs);

    // Clean and validate phone number
    num = num.replace(/[^0-9]/g, '');
    const phone = pn('+' + num);
    
    if (!phone.isValid()) {
        return res.status(400).send({ 
            code: 'Invalid phone number. Use full international number without + (e.g., 15551234567, 447911123456)' 
        });
    }
    
    num = phone.getNumber('e164').replace('+', '');
    console.log('Processing number:', num);

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version } = await fetchLatestBaileysVersion();
            let KnightBot = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.windows('Chrome'),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 250,
                maxRetries: 5,
            });

            KnightBot.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;

                if (connection === 'open') {
                    console.log("✅ Connected!");
                    
                    if (!KnightBot.authState.creds.registered) {
                        console.log("🔄 Not registered, requesting pairing code...");
                        await delay(3000);
                        
                        try {
                            let code = await KnightBot.requestPairingCode(num);
                            console.log("Raw code from WhatsApp:", code);
                            
                            // Format code
                            if (code && typeof code === 'string') {
                                code = code.replace(/-/g, '');
                                if (code.length > 4) {
                                    code = code.match(/.{1,4}/g).join('-');
                                }
                                
                                console.log("Formatted code:", code);
                                
                                if (!responseSent && !res.headersSent) {
                                    responseSent = true;
                                    res.send({ num, code });
                                }
                            }
                        } catch (error) {
                            console.error("Pairing code error:", error.message);
                            if (!responseSent && !res.headersSent) {
                                responseSent = true;
                                res.status(500).send({ 
                                    code: `Error: ${error.message}` 
                                });
                            }
                        }
                    }
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    console.log("Connection closed, status:", statusCode);
                    
                    if (statusCode === 401 || statusCode === 403) {
                        console.log("Authentication failed");
                        if (!responseSent && !res.headersSent) {
                            responseSent = true;
                            res.status(401).send({ 
                                code: 'Authentication failed. Try again.' 
                            });
                        }
                    }
                }
            });

            KnightBot.ev.on('creds.update', saveCreds);
            
            // Timeout after 30 seconds
            setTimeout(() => {
                if (!responseSent && !res.headersSent) {
                    responseSent = true;
                    res.status(408).send({ 
                        code: 'Timeout. WhatsApp server took too long to respond.' 
                    });
                    removeFile(dirs);
                }
            }, 30000);
            
        } catch (err) {
            console.error('Init error:', err);
            if (!responseSent && !res.headersSent) {
                responseSent = true;
                res.status(500).send({ 
                    code: `Server error: ${err.message}` 
                });
            }
            removeFile(dirs);
        }
    }

    await initiateSession();
});

export default router;