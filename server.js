const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
let supabase = null;

if (supabaseUrl && supabaseKey) {
    try { supabase = createClient(supabaseUrl, supabaseKey); } catch (e) { console.error("Supabase Init Error:", e); }
}

function getBeijingTime() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).replace(/\//g, '-'); 
}

function hashMeta(val) {
    if (!val || val === 'Unknown' || val === 'NULL') return undefined;
    return crypto.createHash('sha256').update(val.trim().toLowerCase()).digest('hex');
}

async function retryRequest(fn, retries = 3, delay = 500) {
    for (let i = 0; i < retries; i++) {
        try { return await fn(); } catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

async function sendToMetaCAPI(eventData) {
    const pixelId = process.env.META_PIXEL_ID;
    const token = process.env.META_ACCESS_TOKEN;
    if (!pixelId || !token) return "Skipped: No Meta Credentials";

    const fieldsReport = ['ip', 'ua'];
    if (eventData.fbc) fieldsReport.push('fbc');
    if (eventData.fbp) fieldsReport.push('fbp');
    if (eventData.country && eventData.country !== 'Unknown') fieldsReport.push('country');
    if (eventData.city && eventData.city !== 'Unknown') fieldsReport.push('city');

    return await retryRequest(async () => {
        const payload = {
            data: [{
                event_name: 'Lead',
                event_time: Math.floor(Date.now() / 1000),
                action_source: 'website',
                event_source_url: eventData.url,
                user_data: {
                    client_ip_address: eventData.ip,
                    client_user_agent: eventData.ua,
                    fbc: eventData.fbc || undefined,
                    fbp: eventData.fbp || undefined,
                    country: hashMeta(eventData.country),
                    ct: hashMeta(eventData.city)
                }
            }]
        };
        const response = await fetch(`https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${token}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const resJson = await response.json();
        if (resJson.error) throw new Error(resJson.error.message);
        return `Success | Sent: ${fieldsReport.join(',')}`;
    }).catch(err => `Error: ${err.message}`);
}

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.post('/api/log', async (req, res) => {
    try {
        const logData = req.body;
        const ua = req.get('User-Agent') || '';
        const uaLower = ua.toLowerCase();
        
        let tableName = 'wa_logs';
        if (logData.is_telegram === true) tableName = 'tg_logs';
        else if (logData.is_website === true) tableName = 'website_logs';

        const botKeywords = ['bot', 'spider', 'crawl', 'facebook', 'meta', 'whatsapp', 'preview', 'google', 'twitter', 'slack', 'python'];
        if (botKeywords.some(keyword => uaLower.includes(keyword))) {
            return res.status(200).send({ success: true, skipped: true });
        }

        const country = req.headers['x-vercel-ip-country'] || 'Unknown';
        let city = req.headers['x-vercel-ip-city'] || 'Unknown';
        try { city = decodeURIComponent(city); } catch (e) {}
        const visitorIP = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.ip;
        const bjTime = getBeijingTime();

        if (!supabase) return res.status(200).send({ success: false, error: "Supabase not connected" });

        // 1. 查重
        let visitCount = 1;
        let queryConditions = [];
        if (visitorIP) queryConditions.push(`ip.eq.${visitorIP}`);
        if (logData.fbp) queryConditions.push(`fbp.eq.${logData.fbp}`);
        if (logData.cet_uid) queryConditions.push(`cet_uid.eq.${logData.cet_uid}`);
        if (queryConditions.length > 0) {
            const { data: pastLogs } = await supabase.from(tableName).select('id').or(queryConditions.join(','));
            if (pastLogs && pastLogs.length > 0) visitCount = pastLogs.length + 1;
        }

        // 2. Note 重写
        let actionPrefix = logData.is_website ? 'Form' : 'Chat';
        let pageUrl = logData.referrer_url || '';
        if (logData.note && logData.note.includes(' | ')) {
            const parts = logData.note.split(' | ');
            actionPrefix = parts[0];
            pageUrl = parts.slice(2).join(' | ');
        }
        const finalNote = `${actionPrefix} | ${visitCount > 1 ? `Old User (Click #${visitCount})` : 'New User'} | ${pageUrl}`;

        // 3. Meta CAPI
        let capiStatus = "Skipped: CAPI only for website/tg logs";
        const metaEnabledTables = ['website_logs', 'tg_logs']; 
        if (metaEnabledTables.includes(tableName)) {
            capiStatus = await sendToMetaCAPI({ url: pageUrl, ip: visitorIP, ua: ua, fbc: logData.fbc, fbp: logData.fbp, country: country, city: city });
        }

        // 4. ✨ 容错写入逻辑：构建要插入的数据对象
        const insertObject = {
            phone_number: logData.phoneNumber,
            redirect_time: bjTime,
            ip: visitorIP,
            country: country,
            city: city,
            user_agent: ua,
            language: logData.language || 'en',
            inquiry_id: logData.inquiryId || 'N/A',
            note: finalNote,
            referrer_url: logData.referrer_url || 'Direct',
            fbc: logData.fbc || null,
            fbp: logData.fbp || null,
            gclid: logData.gclid || null,
            wbraid: logData.wbraid || null,
            gbraid: logData.gbraid || null,
            gcl_au: logData.gcl_au || null,
            cet_uid: logData.cet_uid || null,
            meta_capi_status: capiStatus
        };

        const { error } = await supabase.from(tableName).insert([insertObject]);

        if (error) {
            console.error(`Supabase Insert Error (${tableName}):`, error.message);
            // 如果报错是字段不存在，尝试只插入基础字段以保住数据
            if (error.message.includes('column') && error.message.includes('does not exist')) {
                console.log("Retrying with minimal fields...");
                await supabase.from(tableName).insert([{ 
                    phone_number: logData.phoneNumber, 
                    ip: visitorIP, 
                    note: finalNote,
                    inquiry_id: logData.inquiryId
                }]);
            }
            throw error;
        }

        res.status(200).send({ success: true });
    } catch (error) {
        console.error("API Error:", error);
        res.status(200).send({ success: false, message: error.message });
    }
});

// 其他查询接口保持不变...
app.get('/api/logs', async (req, res) => { /*...*/ });
app.get('/api/backfill', async (req, res) => { /*...*/ });

module.exports = app;
