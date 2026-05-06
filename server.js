const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

// 环境变量
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY; 
let supabase = null;

if (supabaseUrl && supabaseKey) {
    try {
        supabase = createClient(supabaseUrl, supabaseKey);
    } catch (e) {
        console.error("Supabase Init Error:", e);
    }
}

// 工具：北京时间
function getBeijingTime() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }).replace(/\//g, '-'); 
}

// 工具：Meta SHA256 加密
function hashMeta(val) {
    if (!val || val === 'Unknown' || val === 'NULL') return undefined;
    return crypto.createHash('sha256').update(val.trim().toLowerCase()).digest('hex');
}

// 工具：重试逻辑
async function retryRequest(fn, retries = 3, delay = 500) {
    for (let i = 0; i < retries; i++) {
        try { return await fn(); } catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// ✨ Meta CAPI 回传函数 (严格限制字段：ip/ua/country/city/fbc/fbp)
async function sendToMetaCAPI(eventData) {
    const pixelId = process.env.META_PIXEL_ID;
    const token = process.env.META_ACCESS_TOKEN;
    if (!pixelId || !token) return "Skipped: No Meta Credentials";

    const reportFields = ['ip', 'ua'];
    if (eventData.fbc) reportFields.push('fbc');
    if (eventData.fbp) reportFields.push('fbp');
    if (eventData.country && eventData.country !== 'Unknown') reportFields.push('country');
    if (eventData.city && eventData.city !== 'Unknown') reportFields.push('city');

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
        return `Success | Sent: ${reportFields.join(',')}`;
    }).catch(err => `Error After Retries: ${err.message}`);
}

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// --- 接口 1: 写入接口 ---
app.post('/api/log', async (req, res) => {
    try {
        const logData = req.body;
        const ua = req.get('User-Agent') || '';
        const uaLower = ua.toLowerCase();
        
        // 修正后的分表逻辑
        let tableName = 'wa_logs'; // 默认分配给中间页点击
        if (logData.is_website === true) {
            tableName = 'website_logs'; // 网站主站 WhatsApp
        } else if (logData.is_telegram === true) {
            tableName = 'tg_logs'; // 网站主站 Telegram
        }

        // ✨ 仅允许 website_logs (主站WA) 和 tg_logs (主站TG) 回传 Meta
        const metaEnabledTables = ['website_logs', 'tg_logs']; 

        // 爬虫拦截
        const botKeywords = ['bot', 'spider', 'crawl', 'facebook', 'meta', 'whatsapp', 'preview', 'google', 'twitter', 'slack', 'python'];
        if (botKeywords.some(keyword => uaLower.includes(keyword))) {
            return res.status(200).send({ success: true, skipped: true });
        }

        const country = req.headers['x-vercel-ip-country'] || 'Unknown';
        let city = req.headers['x-vercel-ip-city'] || 'Unknown';
        try { city = decodeURIComponent(city); } catch (e) {}
        const visitorIP = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.ip;
        const bjTime = getBeijingTime();

        if (!supabase) return res.status(200).send({ success: false });

        // 1. 后端精准查重 (IP + fbp)
        let visitCount = 1;
        let queryConditions = [];
        if (visitorIP) queryConditions.push(`ip.eq.${visitorIP}`);
        if (logData.fbp) queryConditions.push(`fbp.eq.${logData.fbp}`);
        if (queryConditions.length > 0) {
            const { data: pastLogs } = await supabase.from(tableName).select('id').or(queryConditions.join(','));
            if (pastLogs && pastLogs.length > 0) visitCount = pastLogs.length + 1;
        }

        // 2. Note 重新拼接
        let actionPrefix = logData.is_website ? 'WA_MainSite' : (logData.is_telegram ? 'TG_MainSite' : 'Intermediate_Page');
        let pageUrl = logData.referrer_url || 'Direct';
        if (logData.note && logData.note.includes(' | ')) {
            const parts = logData.note.split(' | ');
            actionPrefix = parts[0];
            pageUrl = parts.slice(2).join(' | ');
        }
        const finalNote = `${actionPrefix} | ${visitCount > 1 ? `Old User (Click #${visitCount})` : 'New User'} | ${pageUrl}`;

        // 3. Meta CAPI 实时回传过滤
        let capiStatus = "Skipped: Intermediate Page";
        if (metaEnabledTables.includes(tableName)) {
            capiStatus = await sendToMetaCAPI({ url: pageUrl, ip: visitorIP, ua: ua, fbc: logData.fbc, fbp: logData.fbp, country: country, city: city });
        }

        // 4. 入库
        await retryRequest(async () => {
            const { error } = await supabase.from(tableName).insert([{
                phone_number: logData.phoneNumber, redirect_time: bjTime, ip: visitorIP, country: country, city: city, 
                user_agent: ua, language: logData.language || 'en', inquiry_id: logData.inquiryId || 'N/A', 
                note: finalNote, referrer_url: logData.referrer_url || 'Direct', 
                fbc: logData.fbc || null, fbp: logData.fbp || null, gclid: logData.gclid || null,
                wbraid: logData.wbraid || null, gbraid: logData.gbraid || null, gcl_au: logData.gcl_au || null,
                meta_capi_status: capiStatus
            }]);
            if (error) throw error;
        });

        res.status(200).send({ success: true });
    } catch (error) {
        res.status(200).send({ success: false, msg: error.message });
    }
});

// --- 接口 2: 存量补发接口 (仅限主站渠道) ---
app.get('/api/backfill', async (req, res) => {
    const { pwd, table } = req.query;
    if (pwd !== '123456') return res.status(403).send('Auth Failed');
    
    // 只能补发这主站两个表的数据
    const tName = table === 'website' ? 'website_logs' : (table === 'tg' ? 'tg_logs' : null);
    if (!tName) return res.status(400).send('Invalid Table. Use website or tg');

    try {
        const { data: logs, error: fetchErr } = await supabase
            .from(tName).select('*').or('meta_capi_status.is.null,meta_capi_status.ilike.%Error%,meta_capi_status.ilike.%Skipped%').limit(20);
        if (!logs || logs.length === 0) return res.send('All matched.');
        for (const item of logs) {
            let pUrl = item.referrer_url || '';
            if (item.note && item.note.includes(' | ')) pUrl = item.note.split(' | ').slice(2).join(' | ');
            const resCapi = await sendToMetaCAPI({ url: pUrl, ip: item.ip, ua: item.user_agent, fbc: item.fbc, fbp: item.fbp, country: item.country, city: item.city });
            await supabase.from(tName).update({ meta_capi_status: `Backfilled: ${resCapi}` }).eq('id', item.id);
        }
        res.json({ success: true, processed: logs.length });
    } catch (e) { res.status(500).send(e.message); }
});

// 其他接口保持不变...
app.get('/api/check-phone', async (req, res) => { /*...*/ });
app.get('/api/logs', async (req, res) => { /*...*/ });

module.exports = app;
