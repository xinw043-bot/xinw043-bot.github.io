const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { GoogleAdsApi } = require('google-ads-api');

const app = express();
app.use(bodyParser.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY; 
let supabase = null;

if (supabaseUrl && supabaseKey) {
    try { supabase = createClient(supabaseUrl, supabaseKey); } catch (e) { console.error("Supabase Init Error:", e); }
}

const googleClient = new GoogleAdsApi({
  client_id: process.env.GOOGLE_CLIENT_ID,
  client_secret: process.env.GOOGLE_CLIENT_SECRET,
  developer_token: process.env.GOOGLE_DEVELOPER_TOKEN,
});

function getBeijingTime() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }).replace(/\//g, '-'); 
}

function hashMeta(val) { return val ? crypto.createHash('sha256').update(val.toString().trim().toLowerCase()).digest('hex') : undefined; }
function hashPhone(val) { return val ? crypto.createHash('sha256').update(val.toString().replace(/\D/g, '')).digest('hex') : undefined; }

// --- Meta CAPI ---
async function sendToMetaCAPI(eventData, eventName = 'qualified lead', value = null, currency = 'USD') {
    const pixelId = process.env.META_PIXEL_ID;
    const token = process.env.META_ACCESS_TOKEN;
    if (!pixelId || !token) return "Skipped: Meta Credentials";
    if (!eventData.id || !eventData.phone) return "Failed: Missing ID or Phone";

    let reportFields = ['id', 'phone', 'ip', 'ua']; 
    const userData = {
        external_id: [hashMeta(eventData.id)],
        ph: [hashPhone(eventData.phone)],
        client_ip_address: eventData.ip,
        client_user_agent: eventData.ua
    };

    if (eventData.fbc) { userData.fbc = eventData.fbc; reportFields.push('fbc'); }
    if (eventData.fbp) { userData.fbp = eventData.fbp; reportFields.push('fbp'); }
    if (eventData.email) { userData.em = [hashMeta(eventData.email)]; reportFields.push('email'); }
    if (eventData.name) { userData.fn =[hashMeta(eventData.name)]; reportFields.push('name'); }
    if (eventData.country) { userData.ge = [hashMeta(eventData.country.substring(0,2))]; reportFields.push('country'); }
    if (eventData.city) { userData.ct = [hashMeta(eventData.city)]; reportFields.push('city'); }

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
            body: JSON.stringify({ data: [payloadData] })
        });
        const resJson = await response.json();
        return resJson.error ? `Meta Error: ${resJson.error.message}` : `✅ Meta:${eventName} | Sent:[${reportFields.join(', ')}]`;
    } catch (e) { return `Meta Failed: ${e.message}`; }
}

// --- Google Ads API ---
async function sendToGoogleAds(row) {
    try {
        const missingFields =[];
        if (!row.id) missingFields.push('id');
        if (!row.phone) missingFields.push('phone');
        if (!row.gcl_au) missingFields.push('gcl_au');
        if (missingFields.length > 0) return `❌ Google Ads: Missing required fields: ${missingFields.join(', ')}`;

        const customer = googleClient.Customer({
            customer_id: process.env.GOOGLE_ADS_CUSTOMER_ID,
            refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
        });

        let reportFields =['id', 'phone', 'gcl_au', 'conversion_action'];
        const userIdentifiers =[
            { hashed_phone_number: hashPhone(row.phone) }
        ];
        if (row.email) {
            userIdentifiers.push({ hashed_email: hashMeta(row.email) });
            reportFields.push('email');
        }

        const conversion = {
            customer_id: process.env.GOOGLE_ADS_CUSTOMER_ID,
            gcl_au: row.gcl_au,
            conversion_action: process.env.GOOGLE_CONVERSION_ACTION_ID,
            conversion_date_time: new Date(row.created_at || new Date()).toISOString(),
            conversion_value: parseFloat(row.value) || 0,
            currency_code: row.currency || 'USD',
            user_identifiers: userIdentifiers
        };

        if (row.gclid) { conversion.gclid = row.gclid; reportFields.push('gclid'); }
        if (row.wbraid) { conversion.wbraid = row.wbraid; reportFields.push('wbraid'); }
        if (row.gbraid) { conversion.gbraid = row.gbraid; reportFields.push('gbraid'); }

        await customer.uploadConversion(conversion);
        return `✅ Google Ads | Sent:[${reportFields.join(', ')}]`;
    } catch (err) { return `❌ Google Ads: ${err.message}`; }
}

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// --- API ---
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
        res.status(200).json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// --- Webhook ---
app.post('/api/webhook/supabase', async (req, res) => {
    try {
        const { type, record, table } = req.body;
        // 增加调试日志，查看接收到的数据
        console.log("Webhook Received:", type, "Status:", record.meta_capi_status);
        
        if (type === 'UPDATE' && record) {
            const eventData = { id: record.id, phone: record.phone_number || record.phone, email: record.email, name: record.name, url: record.referrer_url, ip: record.ip, ua: record.user_agent || record.ua, fbc: record.fbc, fbp: record.fbp, country: record.country, city: record.city };
            let status = "";
            const statusVal = record.meta_capi_status;

            if (statusVal === 'gometa') {
                status = await sendToMetaCAPI(eventData, 'qualified lead');
            } else if (statusVal === 'purchase') {
                if (!record.value || parseFloat(record.value) <= 0) status = "Failed: Invalid Value";
                else status = await sendToMetaCAPI(eventData, 'Purchase', record.value, record.currency);
            } else if (statusVal === 'gogoogle') {
                // ✨ 调试重点：看看是否进入了这个分支
                console.log("Executing Google Ads Sync for ID:", record.id);
                if (!record.gclid) {
                    status = "Failed: Missing GCLID";
                } else {
                    status = await sendToGoogleAds(record);
                }
            } else {
                // 如果是其他状态，不处理
                return res.status(200).json({ success: true, message: "No action needed" });
            }

            // 数据库更新
            if (status && supabase) {
                const { error: updateError } = await supabase.from(table).update({ meta_capi_status: status }).eq('id', record.id);
                if (updateError) {
                    console.error("❌ Supabase 更新回执失败:", updateError);
                } else {
                    console.log("✅ 数据库回执已更新为:", status);
                }
            }
        }
        res.status(200).json({ success: true });
    } catch (error) { 
        console.error("❌ Webhook Fatal Error:", error);
        res.status(500).json({ success: false }); 
    }
});

module.exports = app;
