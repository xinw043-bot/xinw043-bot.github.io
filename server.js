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
    try {
        supabase = createClient(supabaseUrl, supabaseKey);
    } catch (e) {
        console.error("Supabase Init Error:", e);
    }
}

function getBeijingTime() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }).replace(/\//g, '-'); 
}

function hashMeta(val) {
    if (!val || val === 'Unknown' || val === 'NULL') return undefined;
    return crypto.createHash('sha256').update(val.toString().trim().toLowerCase()).digest('hex');
}

function hashPhone(val) {
    if (!val) return undefined;
    const clean = val.toString().replace(/[^\d]/g, '');
    if (!clean) return undefined;
    return crypto.createHash('sha256').update(clean).digest('hex');
}

// ✨ 升级版回传函数：支持动态事件名和自定义金额数据
async function sendToMetaCAPI(eventData, eventName = 'qualified lead', value = null, currency = 'USD') {
    const pixelId = process.env.META_PIXEL_ID;
    const token = process.env.META_ACCESS_TOKEN;
    if (!pixelId || !token) return "Skipped: No Credentials";

    if (!eventData.id || !eventData.phone) return "Failed: Missing ID or Phone";

    const userData = {
        external_id: [hashMeta(eventData.id)],
        ph:[hashPhone(eventData.phone)],
        client_ip_address: eventData.ip,
        client_user_agent: eventData.ua
    };

    if (eventData.fbc) userData.fbc = eventData.fbc;
    if (eventData.fbp) userData.fbp = eventData.fbp;
    if (eventData.email) userData.em = [hashMeta(eventData.email)];
    if (eventData.name) userData.fn = [hashMeta(eventData.name)];

    const payloadData = {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_source_url: eventData.url,
        user_data: userData
    };

    if (eventName === 'Purchase') {
        payloadData.custom_data = { 
            value: parseFloat(value), 
            currency: currency || 'USD' 
        };
    }

    try {
        const response = await fetch(`https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${token}`, {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: [payloadData] })
        });

        const resJson = await response.json();
        if (resJson.error) return `Meta Error: ${resJson.error.message}`;
        return `Success | Sent: ${eventName}`;
    } catch (e) {
        return `Meta Fetch Failed: ${e.message}`;
    }
}

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// --- 核心写入接口 ---
app.post('/api/log', async (req, res) => {
    try {
        const logData = req.body;
        const ua = req.get('User-Agent') || '';
        const visitorIP = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.ip;
        
        let safeCity = 'Unknown';
        try { if (req.headers['x-vercel-ip-city']) safeCity = decodeURIComponent(req.headers['x-vercel-ip-city']); } catch (e) { safeCity = req.headers['x-vercel-ip-city'] || 'Unknown'; }

        if (logData.type === 'form_submission') {
            const formData = {
                name: logData.name, email: logData.email, company: logData.company, phone: logData.phone,
                page_url: logData.page_url, referrer_url: logData.referrer_url, ip: visitorIP, ua: ua,        
                fbc: logData.fbc || null, fbp: logData.fbp || null, gclid: logData.gclid || null,
                gcl_au: logData.gcl_au || null, wbraid: logData.wbraid || null, gbraid: logData.gbraid || null,
                country: req.headers['x-vercel-ip-country'] || 'Unknown', city: safeCity
            };
            const { error: dbError } = await supabase.from('form_submissions').insert([formData]);
            if (dbError) throw dbError;
            return res.status(200).json({ success: true, type: 'form' });
        }

        let tableName = logData.is_telegram ? 'tg_logs' : (logData.is_website ? 'website_logs' : 'wa_logs');
        if (ua.toLowerCase().includes('bot') || ua.toLowerCase().includes('crawl')) return res.status(200).json({ success: true, skipped: 'bot' });

        const { data: pastLogs } = await supabase.from(tableName).select('id').or(`ip.eq.${visitorIP},fbp.eq.${logData.fbp || 'null'}`);
        const visitCount = (pastLogs ? pastLogs.length : 0) + 1;
        const finalNote = `${tableName === 'website_logs' ? 'WA_Main' : (tableName === 'tg_logs' ? 'TG_Main' : 'Intermediate')} | ${visitCount > 1 ? `Old User (#${visitCount})` : 'New User'} | ${logData.referrer_url || 'Direct'}`;

        const insertData = {
            phone_number: logData.phoneNumber, redirect_time: getBeijingTime(), ip: visitorIP,
            country: req.headers['x-vercel-ip-country'] || 'Unknown', city: safeCity, user_agent: ua,
            language: logData.language || 'en', inquiry_id: logData.inquiryId || 'N/A', note: finalNote,
            referrer_url: logData.referrer_url || 'Direct', fbc: logData.fbc || null, fbp: logData.fbp || null,
            gclid: logData.gclid || null, wbraid: logData.wbraid || null, gbraid: logData.gbraid || null, gcl_au: logData.gcl_au || null
        };
        if (tableName !== 'wa_logs') insertData.meta_capi_status = "Pending";

        const { error: dbError } = await supabase.from(tableName).insert([insertData]);
        if (dbError) throw dbError;
        res.status(200).json({ success: true });
    } catch (error) {
        console.error("❌ 接口异常:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- 修改 Webhook 接口 ---
app.post('/api/webhook/supabase', async (req, res) => {
    try {
        const payload = req.body;
        if (payload.type === 'UPDATE' && payload.record) {
            const row = payload.record;
            const tableName = payload.table;
            const statusVal = row.meta_capi_status;
            
            // ✨ 关键修复：显式构建 eventData 对象，确保字段名对得上
            const eventData = {
                id: row.id || row.inquiry_id,      // 确保取到 ID
                phone: row.phone_number || row.phone, // 确保取到电话
                email: row.email,
                name: row.name,
                url: row.referrer_url,
                ip: row.ip,
                ua: row.user_agent || row.ua,
                fbc: row.fbc,
                fbp: row.fbp,
                country: row.country,
                city: row.city
            };

            let status = "";

            if (statusVal === 'gometa') {
                status = await sendToMetaCAPI(eventData, 'qualified lead');
            } else if (statusVal === 'purchase') {
                if (!row.value || parseFloat(row.value) <= 0) {
                    status = "Failed: Missing or Invalid Value";
                } else {
                    status = await sendToMetaCAPI(eventData, 'Purchase', row.value, row.currency);
                }
            }

            if (status && supabase) {
                await supabase.from(tableName).update({ meta_capi_status: status }).eq('id', row.id);
            }
        }
        res.status(200).json({ success: true });
    } catch (error) {
        console.error("Webhook Error:", error);
        res.status(500).json({ success: false });
    }
});

module.exports = app;
