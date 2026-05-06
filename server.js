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

// 获取北京时间
function getBeijingTime() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }).replace(/\//g, '-'); 
}

// Meta 专用 SHA256 加密
function hashMeta(val) {
    if (!val || val === 'Unknown' || val === 'NULL') return undefined;
    return crypto.createHash('sha256').update(val.trim().toLowerCase()).digest('hex');
}

// 网络请求重试装饰器
async function retryRequest(fn, retries = 3, delay = 500) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// ✨ Meta CAPI 回传函数 (严格限定回传字段)
async function sendToMetaCAPI(eventData) {
    const pixelId = process.env.META_PIXEL_ID;
    const token = process.env.META_ACCESS_TOKEN;
    
    if (!pixelId || !token) return "Skipped: No Meta Credentials";

    // 统计本次回传的有效匹配字段
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
                    // 严格只回传要求的 6 类字段
                    client_ip_address: eventData.ip,
                    client_user_agent: eventData.ua,
                    fbc: eventData.fbc || undefined, // 无数据则不传输该 Key
                    fbp: eventData.fbp || undefined, // 无数据则不传输该 Key
                    country: hashMeta(eventData.country),
                    ct: hashMeta(eventData.city)
                }
            }]
        };

        const response = await fetch(`https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${token}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const resJson = await response.json();
        if (resJson.error) throw new Error(resJson.error.message);
        return `Success | Sent: ${fieldsReport.join(',')}`;
    }).catch(err => `Error After Retries: ${err.message}`);
}

// CORS 跨域配置
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// --- 接口 1: 核心日志记录与实时回传 ---
app.post('/api/log', async (req, res) => {
    try {
        const logData = req.body;
        const ua = req.get('User-Agent') || '';
        const uaLower = ua.toLowerCase();
        
        // 1. 自动分表逻辑
        let tableName = 'wa_logs';
        if (logData.is_telegram === true) tableName = 'tg_logs';
        else if (logData.is_website === true) tableName = 'website_logs';

        // 2. 爬虫过滤
        const botKeywords = ['bot', 'spider', 'crawl', 'facebook', 'meta', 'whatsapp', 'preview', 'google', 'twitter', 'slack', 'python'];
        if (botKeywords.some(keyword => uaLower.includes(keyword))) {
            return res.status(200).send({ success: true, skipped: true, reason: 'bot_detected' });
        }

        // 3. 环境属性抓取
        const country = req.headers['x-vercel-ip-country'] || 'Unknown';
        let city = req.headers['x-vercel-ip-city'] || 'Unknown';
        try { city = decodeURIComponent(city); } catch (e) {}
        const visitorIP = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.ip;
        const bjTime = getBeijingTime();

        if (!supabase) return res.status(200).send({ success: false });

        // 4. 后端精准查重 (IP + fbp + userId)
        let visitCount = 1;
        let queryConditions = [];
        if (visitorIP) queryConditions.push(`ip.eq.${visitorIP}`);
        if (logData.fbp) queryConditions.push(`fbp.eq.${logData.fbp}`);
        if (logData.cet_uid) queryConditions.push(`cet_uid.eq.${logData.cet_uid}`);

        if (queryConditions.length > 0) {
            const { data: pastLogs } = await supabase.from(tableName).select('id').or(queryConditions.join(','));
            if (pastLogs && pastLogs.length > 0) visitCount = pastLogs.length + 1;
        }

        // 5. Note 字段格式格式化
        let actionPrefix = logData.is_website ? 'Form' : 'Chat';
        let pageUrl = logData.referrer_url || '';
        if (logData.note && logData.note.includes(' | ')) {
            const parts = logData.note.split(' | ');
            actionPrefix = parts[0];
            pageUrl = parts.slice(2).join(' | ');
        }
        const finalNote = `${actionPrefix} | ${visitCount > 1 ? `Old User (Click #${visitCount})` : 'New User'} | ${pageUrl}`;

        // 6. Meta CAPI 逻辑执行 (仅限 website 和 tg 表)
        let capiStatus = "Skipped: CAPI only for website/tg logs";
        const metaEnabledTables = ['website_logs', 'tg_logs']; 
        if (metaEnabledTables.includes(tableName)) {
            capiStatus = await sendToMetaCAPI({
                url: pageUrl,
                ip: visitorIP,
                ua: ua,
                fbc: logData.fbc,
                fbp: logData.fbp,
                country: country,
                city: city
            });
        }

        // 7. 最终入库 (全字段对齐)
        await retryRequest(async () => {
            const { error } = await supabase.from(tableName).insert({
                phone_number: logData.phoneNumber, // 注意：此处记录的是分配的业务员账号
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
            });
            if (error) throw error;
        });

        res.status(200).send({ success: true });
    } catch (error) {
        console.error("Critical API Error:", error);
        res.status(200).send({ success: false });
    }
});

// --- 接口 2: 存量数据补发补偿 ---
app.get('/api/backfill', async (req, res) => {
    const { pwd, table } = req.query;
    if (pwd !== '123456') return res.status(403).send('🔒 Auth Failed');
    const tableName = table === 'website' ? 'website_logs' : (table === 'tg' ? 'tg_logs' : null);
    if (!tableName) return res.status(400).send('Use ?table=website or ?table=tg');

    try {
        const { data: logs, error: fetchErr } = await supabase
            .from(tableName)
            .select('*')
            .or('meta_capi_status.is.null,meta_capi_status.ilike.%Error%,meta_capi_status.ilike.%Skipped%')
            .order('id', { ascending: false }).limit(20);

        if (fetchErr) throw fetchErr;
        if (!logs || logs.length === 0) return res.send('No logs need backfilling.');

        let processed = 0;
        for (const item of logs) {
            let pUrl = item.referrer_url || '';
            if (item.note && item.note.includes(' | ')) pUrl = item.note.split(' | ').slice(2).join(' | ');
            const resCapi = await sendToMetaCAPI({
                url: pUrl, ip: item.ip, ua: item.user_agent,
                fbc: item.fbc, fbp: item.fbp, country: item.country, city: item.city
            });
            await supabase.from(tableName).update({ meta_capi_status: `Backfilled: ${resCapi}` }).eq('id', item.id);
            processed++;
        }
        res.json({ success: true, processed, table: tableName });
    } catch (e) { res.status(500).send(e.message); }
});

// --- 接口 3: 存量日志快速预览 ---
app.get('/api/logs', async (req, res) => {
    if (!supabase) return res.send('Config Error');
    if (req.query.pwd !== '123456') return res.send('Password Error');
    let tName = 'wa_logs';
    if (req.query.table === 'website') tName = 'website_logs';
    if (req.query.table === 'tg') tName = 'tg_logs';
    try {
        const { data: logs } = await supabase.from(tName).select('*').order('id', { ascending: false }).limit(50);
        res.json(logs);
    } catch (error) { res.status(500).send(error.message); }
});

module.exports = app;
