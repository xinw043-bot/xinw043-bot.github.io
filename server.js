const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { GoogleAdsApi } = require('google-ads-api');

const app = express();
app.use(bodyParser.json());

// 环境变量配置
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

// Google Ads 初始化
const googleClient = new GoogleAdsApi({
  client_id: process.env.GOOGLE_CLIENT_ID,
  client_secret: process.env.GOOGLE_CLIENT_SECRET,
  developer_token: process.env.GOOGLE_DEVELOPER_TOKEN,
});

// 工具：北京时间
function getBeijingTime() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }).replace(/\//g, '-'); 
}

// 工具：加密
function hashMeta(val) { return val ? crypto.createHash('sha256').update(val.toString().trim().toLowerCase()).digest('hex') : undefined; }
function hashPhone(val) { return val ? crypto.createHash('sha256').update(val.toString().replace(/\D/g, '')).digest('hex') : undefined; }

// --- Meta CAPI 回传 ---
async function sendToMetaCAPI(eventData, eventName = 'qualified lead', value = null, currency = 'USD') {
    const pixelId = process.env.META_PIXEL_ID;
    const token = process.env.META_ACCESS_TOKEN;
    if (!pixelId || !token) return "Skipped: Meta Credentials";
    if (!eventData.id || !eventData.phone) return "Failed: Missing ID or Phone";

    let reportFields =['id', 'phone', 'ip', 'ua']; 
    const userData = {
        external_id: [hashMeta(eventData.id)],
        ph: [hashPhone(eventData.phone)],
        client_ip_address: eventData.ip,
        client_user_agent: eventData.ua
    };
    reportFields.push('ip', 'ua');

    if (eventData.fbc) { userData.fbc = eventData.fbc; reportFields.push('fbc'); }
    if (eventData.fbp) { userData.fbp = eventData.fbp; reportFields.push('fbp'); }
    if (eventData.email) { userData.em =[hashMeta(eventData.email)]; reportFields.push('email'); }
    if (eventData.name) { userData.fn = [hashMeta(eventData.name)]; reportFields.push('name'); }
    if (eventData.country) { userData.ge =[hashMeta(eventData.country.substring(0,2))]; reportFields.push('country'); }
    if (eventData.city) { userData.ct =[hashMeta(eventData.city)]; reportFields.push('city'); }

    const payloadData = {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_source_url: eventData.url,
        user_data: userData
    };

    if (eventName === 'Purchase' && value) {
        payloadData.custom_data = { value: parseFloat(value), currency: currency || 'USD' };
        reportFields.push('value', 'currency');
    }

    try {
        const response = await fetch(`https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${token}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data:[payloadData] })
        });
        const resJson = await response.json();
        return resJson.error ? `Meta Error: ${resJson.error.message}` : `✅ Meta:${eventName} | Sent:[${reportFields.join(', ')}]`;
    } catch (e) { return `Meta Failed: ${e.message}`; }
}

// --- Google Ads 回传 ---
async function sendToGoogleAds(row) {
    try {
        const customer = googleClient.Customer({
            customer_id: process.env.GOOGLE_ADS_CUSTOMER_ID,
            refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
        });
        const conversion = {
            customer_id: process.env.GOOGLE_ADS_CUSTOMER_ID,
            gclid: row.gclid,
            conversion_action: process.env.GOOGLE_CONVERSION_ACTION_ID,
            conversion_date_time: new Date(row.created_at || new Date()).toISOString(),
            conversion_value: parseFloat(row.value) || 0,
            currency_code: row.currency || 'USD'
        };
        await customer.uploadConversion(conversion);
        return "✅ Google Ads";
    } catch (err) { return `❌ Google Ads: ${err.message}`; }
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

// --- Webhook 接口 ---
app.post('/api/webhook/supabase', async (req, res) => {
    try {
        const { type, record, table } = req.body;
        if (type === 'UPDATE' && record) {
            const eventData = { id: record.id, phone: record.phone_number || record.phone, email: record.email, name: record.name, url: record.referrer_url, ip: record.ip, ua: record.user_agent || record.ua, fbc: record.fbc, fbp: record.fbp, country: record.country, city: record.city };
            let status = "";
            const statusVal = record.meta_capi_status;

            if (statusVal === 'gometa') {
                status = await sendToMetaCAPI(eventData, 'qualified lead');
            } else if (statusVal === 'purchase') {
                if (!record.value || parseFloat(record.value) <= 0) status = "Failed: Missing Value";
                else status = await sendToMetaCAPI(eventData, 'Purchase', record.value, record.currency);
            } else if (statusVal === 'gogoogle') {
                if (!record.gclid) status = "Failed: Missing GCLID";
                else status = await sendToGoogleAds(record);
            }

            if (status && supabase) await supabase.from(table).update({ meta_capi_status: status }).eq('id', record.id);
        }
        res.status(200).json({ success: true });
    } catch (error) { 
        console.error("Webhook Error:", error);
        res.status(500).json({ success: false }); 
    }
});

module.exports = app;
