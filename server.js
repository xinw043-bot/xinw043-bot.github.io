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
// ✨ 终极防抖：自动剔除所有环境变量可能带入的空格、回车和多余字符
const googleClient = new GoogleAdsApi({
  client_id: (process.env.GOOGLE_CLIENT_ID || '').trim(),
  client_secret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
  developer_token: (process.env.GOOGLE_DEVELOPER_TOKEN || '').trim(),
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

// --- Meta CAPI 回传 ---
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
// --- Google Ads API 回传 (修复了官方函数名与格式) ---
async function sendToGoogleAds(row) {
    const subAccountId = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '').trim();
    const mccId = (process.env.GOOGLE_LOGIN_CUSTOMER_ID || '').replace(/-/g, '').trim();
    const convActionId = (process.env.GOOGLE_CONVERSION_ACTION_ID || '').trim();
    const refreshToken = (process.env.GOOGLE_REFRESH_TOKEN || '').trim();
    try {
        // 1. 必传项强制校验
        const missingFields = [];
        if (!row.id) missingFields.push('id');
        const rawPhone = row.phone_number || row.phone;
        if (!rawPhone) missingFields.push('phone');
        if (!row.gcl_au) missingFields.push('gcl_au');
        if (!row.value || parseFloat(row.value) <= 0) missingFields.push('value');
        
        if (missingFields.length > 0) return `❌ Failed: Missing [${missingFields.join(', ')}]`;
        const cleanCustomerId = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '').trim();
        const cleanConversionActionId = (process.env.GOOGLE_CONVERSION_ACTION_ID || '').trim();

        const customer = googleClient.Customer({
            customer_id: cleanCustomerId,
            refresh_token: (process.env.GOOGLE_REFRESH_TOKEN || '').trim(),
            login_customer_id: mccId,
        });

        let reportFields = ['id', 'phone', 'gcl_au', 'value', 'currency'];
        const userIdentifiers = [
            { hashed_phone_number: hashPhone(rawPhone) }
        ];
        
        if (row.email) {
            userIdentifiers.push({ hashed_email: hashMeta(row.email) });
            reportFields.push('email');
        }

        // ✨ 修复 1：Google 要求时间必须是 "yyyy-mm-dd hh:mm:ss+|-hh:mm" 格式
        const dateObj = new Date(row.created_at || new Date());
        const formattedTime = dateObj.toISOString().replace('T', ' ').substring(0, 19) + '+00:00';

        const conversion = {
            // ✨ 修复 2：Google 要求转化操作 ID 必须是完整的资源路径
            conversion_action: `customers/${process.env.GOOGLE_ADS_CUSTOMER_ID}/conversionActions/${process.env.GOOGLE_CONVERSION_ACTION_ID}`,
            conversion_date_time: formattedTime,
            conversion_value: parseFloat(row.value),
            currency_code: row.currency || 'USD',
            user_identifiers: userIdentifiers
        };

        if (row.country || row.city) {
            conversion.user_location = {
                country_code: row.country ? row.country.substring(0, 2).toUpperCase() : undefined,
                city: row.city
            };
            reportFields.push('country', 'city');
        }

        if (row.gclid) { conversion.gclid = row.gclid; reportFields.push('gclid'); }
        if (row.wbraid) { conversion.wbraid = row.wbraid; reportFields.push('wbraid'); }
        if (row.gbraid) { conversion.gbraid = row.gbraid; reportFields.push('gbraid'); }

        // ✨ 修复 3：调用正确的官方 API 方法上传
        const response = await customer.conversionUploads.uploadClickConversions({
            conversions: [conversion],
            partial_failure: true
        });

        if (response.partial_failure_error) {
            console.error("❌ Google Ads 详细拒绝原因:", JSON.stringify(response.partial_failure_error));
            return `❌ Google Ads 拒绝: ${response.partial_failure_error.message}`;
        }

        return `✅ Success | Sent:[${reportFields.join(', ')}]`;
    } catch (err) { 
        console.error("❌ Google 代码执行报错:", err);
        return `❌ Google Ads: ${err.message}`; 
    }
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
    console.log("Raw Webhook Payload:", JSON.stringify(req.body));
    
    try {
        const payload = req.body;
        const record = payload.record || payload.data;
        const table = payload.table;

        if (payload.type === 'UPDATE' && record) {
            
            // 提取 Meta 和 Google 的状态值
            const metaStatusVal = record.meta_capi_status ? String(record.meta_capi_status).trim().toLowerCase() : "";
            const googleStatusVal = record.google_data_api ? String(record.google_data_api).trim().toLowerCase() : "";
            
            console.log(`Processing ID: ${record.id} | Meta: "${metaStatusVal}" | Google: "${googleStatusVal}"`);

            const eventData = { id: record.id, phone: record.phone_number || record.phone, email: record.email, name: record.name, url: record.referrer_url, ip: record.ip, ua: record.user_agent || record.ua, fbc: record.fbc, fbp: record.fbp, country: record.country, city: record.city };
            
            let updatePayload = {};

            // ================= 1. 处理 Meta 逻辑 =================
            if (metaStatusVal === 'gometa') {
                const metaRes = await sendToMetaCAPI(eventData, 'qualified lead');
                if (metaRes !== record.meta_capi_status) updatePayload.meta_capi_status = metaRes;
            } else if (metaStatusVal === 'purchase') {
                let metaRes = "";
                if (!record.value || parseFloat(record.value) <= 0) metaRes = "Failed: Missing or Invalid Value";
                else metaRes = await sendToMetaCAPI(eventData, 'Purchase', record.value, record.currency);
                
                if (metaRes !== record.meta_capi_status) updatePayload.meta_capi_status = metaRes;
            }

            // ================= 2. 处理 Google Ads 逻辑 =================
            if (googleStatusVal === 'gogoogle') {
                const googleRes = await sendToGoogleAds(record);
                // 只有状态改变了，才丢进 update 队列
                if (googleRes !== record.google_data_api) updatePayload.google_data_api = googleRes;
            }

            // ================= 3. 统一更新数据库 =================
            if (Object.keys(updatePayload).length > 0 && supabase) {
                console.log("-> 准备写入数据库:", updatePayload);
                const { error } = await supabase.from(table || 'website_logs').update(updatePayload).eq('id', record.id);
                if (error) console.error("❌ 数据库写入失败:", error);
            } else {
                console.log("-> 无匹配关键词或状态无需更新");
            }
        }
        res.status(200).json({ success: true });
    } catch (error) { 
        console.error("❌ Webhook 崩溃报错:", error);
        res.status(500).json({ success: false }); 
    }
});

module.exports = app; 
