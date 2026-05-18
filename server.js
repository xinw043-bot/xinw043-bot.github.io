// ====================== 消除 MetadataLookupWarning ======================
process.env.GCE_METADATA_HOST = '0.0.0.0';           // 让它快速失败
process.env.METADATA_SERVER_DETECTION = 'none';      // 关键：禁用 metadata 探测

// 抑制 Node.js 的特定 Warning
const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning, type, ...args) => {
    if (warning && warning.includes && warning.includes('MetadatalookupWarning')) {
        return; // 直接吞掉这个 warning
    }
    return originalEmitWarning.call(process, warning, type, ...args);
};

console.log('⚙️ MetadataLookupWarning 已全局抑制');

const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { GoogleAdsApi } = require('google-ads-api');

const app = express();
app.use(bodyParser.json());

// Supabase 初始化
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
let supabase = null;
if (supabaseUrl && supabaseKey) {
    try {
        supabase = createClient(supabaseUrl, supabaseKey);
        console.log('✅ Supabase initialized');
    } catch (e) {
        console.error("❌ Supabase Init Error:", e);
    }
}

// Google Ads Client
const googleClient = new GoogleAdsApi({
    client_id: (process.env.GOOGLE_CLIENT_ID || '').trim(),
    client_secret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
    developer_token: (process.env.GOOGLE_DEVELOPER_TOKEN || '').trim(),
});

function hashMeta(val) {
    return val ? crypto.createHash('sha256').update(val.toString().trim().toLowerCase()).digest('hex') : undefined;
}

function hashPhone(val) {
    return val ? crypto.createHash('sha256').update(val.toString().replace(/\D/g, '')).digest('hex') : undefined;
}

// ==================== Meta CAPI ====================
async function sendToMetaCAPI(eventData, eventName = 'qualified lead', value = null, currency = 'USD') {
    const pixelId = process.env.META_PIXEL_ID;
    const token = process.env.META_ACCESS_TOKEN;
    if (!pixelId || !token) return "Skipped: Meta Credentials";
    if (!eventData.id || !eventData.phone) return "Failed: Missing ID or Phone";

    const sentFields = ['external_id', 'ph', 'ip', 'ua'];   // ← 新增

    const userData = {
        external_id: [hashMeta(eventData.id)],
        ph: [hashPhone(eventData.phone)],
        client_ip_address: eventData.ip,
        client_user_agent: eventData.ua
    };

    if (eventData.fbc) userData.fbc = eventData.fbc;sentFields.push('fbc');
    if (eventData.fbp) userData.fbp = eventData.fbp;sentFields.push('fbp');
    if (eventData.email) userData.em = [hashMeta(eventData.email)];sentFields.push('email');
    if (eventData.name) userData.fn = [hashMeta(eventData.name)];sentFields.push('name');
    if (eventData.country) userData.ge = [hashMeta(eventData.country.substring(0, 2))];sentFields.push('country');
    if (eventData.city) userData.ct = [hashMeta(eventData.city)];sentFields.push('city');

    const payloadData = {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_source_url: eventData.url,
        user_data: userData
    };

    if (eventName === 'Purchase' && value) {
        payloadData.custom_data = { value: parseFloat(value), currency: currency || 'USD' };
    }

    try {
        const response = await fetch(`https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${token}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: [payloadData] })
        });
        const resJson = await response.json();
    if (resJson.error) {
            return `Meta Error: ${resJson.error.message}`;
        } else {
            const successMsg = `✅ Meta:${eventName} | Sent: ${sentFields.join(', ')}`;
            console.log(`✅ Meta Success → ${successMsg}`);
            return successMsg;
        }
    } catch (e) {
        return `Meta Failed: ${e.message}`;
    }
}

// ==================== Google Ads（关键修复）===================
async function sendToGoogleAds(row) {
    const customerIdRaw = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').trim();
    const loginCustomerIdRaw = (process.env.GOOGLE_LOGIN_CUSTOMER_ID || '').trim();
    const conversionActionId = (process.env.GOOGLE_CONVERSION_ACTION_ID || '').trim();
    const refreshToken = (process.env.GOOGLE_REFRESH_TOKEN || '').trim();

    const customerId = customerIdRaw.replace(/-/g, '');
    const loginCustomerId = loginCustomerIdRaw.replace(/-/g, '');

    console.log('🔍 [Google Ads Debug]', {
        customerId,
        loginCustomerId: loginCustomerId || 'None',
        conversionActionId,
        hasRefreshToken: !!refreshToken
    });

    try {
        if (!customerId || customerId.length !== 10) {
            return `❌ Invalid GOOGLE_ADS_CUSTOMER_ID: ${customerIdRaw}`;
        }
        if (!conversionActionId) {
            return `❌ Missing GOOGLE_CONVERSION_ACTION_ID`;
        }
        if (!refreshToken) {
            return `❌ Missing GOOGLE_REFRESH_TOKEN`;
        }

        const rawPhone = row.phone_number || row.phone;
        if (!row.id || !rawPhone || !row.value) {
            return `❌ Missing required fields(id, phone, value)`;
        }

        // 创建 Customer
        const customer = googleClient.Customer({
            customer_id: customerId,
            refresh_token: refreshToken,
            login_customer_id: loginCustomerId || undefined,
        });

        const sentFields = ['id', 'phone', 'value'];
        sentFields.push(row.currency ? 'currency' : 'currency(USD)');
        const userIdentifiers = [{ hashed_phone_number: hashPhone(rawPhone) }];
        if (row.email) {
            userIdentifiers.push({ hashed_email: hashMeta(row.email) });
            sentFields.push('email');
        }
        if (row.gcl_au) {
           sentFields.push('gcl_au');
        }

        const dateObj = new Date(row.created_at || Date.now());
        const formattedTime = dateObj.toISOString().replace('T', ' ').substring(0, 19) + '+00:00';

        const conversionActionResourceName = `customers/${customerId}/conversionActions/${conversionActionId}`;

        const conversion = {
            conversion_action: conversionActionResourceName,
            conversion_date_time: formattedTime,
            conversion_value: parseFloat(row.value),
            currency_code: (row.currency || 'USD').toUpperCase(),
            user_identifiers: userIdentifiers
        };

        if (row.gclid) conversion.gclid = row.gclid;
        if (row.wbraid) conversion.wbraid = row.wbraid;
        if (row.gbraid) conversion.gbraid = row.gbraid;
        if (row.country || row.city) {
           conversion.user_location = {
           country_code: row.country ? row.country.substring(0, 2).toUpperCase() : undefined,
           city: row.city || undefined
    };
    sentFields.push('user_location');
}

        // 【关键修复】使用正确的 Request 对象格式
        const { services } = require('google-ads-api');   // 新增
        const request = new services.UploadClickConversionsRequest({
            customer_id: customerId,           // 必须显式传入
            conversions: [conversion],
            partial_failure: true
        });

        const response = await customer.conversionUploads.uploadClickConversions(request);

        if (response.partial_failure_error) {
            console.error("Google Partial Failure:", JSON.stringify(response.partial_failure_error));
            return `❌ Google Partial Error: ${response.partial_failure_error.message || 'Unknown'}`;
        }

        const successMsg = `✅ Google Success | Sent: ${sentFields.join(', ')}`;
        console.log(`✅ Google Success for ID ${row.id} → ${successMsg}`);
        return successMsg;

    } catch (err) {
        console.error("❌ Google Ads Full Error:", err);
        return `❌ Google Ads Error: ${err.message}`;
    }
}

// CORS + Routes（保持不变）
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// --- API 路由：接收前端数据并分流到 3 个不同的表 ---
app.post('/api/log', async (req, res) => {
    try {
        const logData = req.body;
        console.log(`📥 接收到前端数据 | 类型: ${logData.type || '未定义'}`, logData);

        // 统一获取隐藏字段 (IP, UA, 归属地等)
        const ua = req.get('User-Agent') || '';
        const visitorIP = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.ip;
        let safeCity = 'Unknown';
        try { if (req.headers['x-vercel-ip-city']) safeCity = decodeURIComponent(req.headers['x-vercel-ip-city']); } catch (e) { safeCity = req.headers['x-vercel-ip-city'] || 'Unknown'; }
        const country = req.headers['x-vercel-ip-country'] || 'Unknown';

        // ==============================
        // 1. 表单提交 -> form_submissions 表
        // ==============================
        if (logData.type === 'form_submission') {
            const formData = {
                name: logData.name, email: logData.email, company: logData.company, phone: logData.phone,
                page_url: logData.page_url, referrer_url: logData.referrer_url, 
                ip: visitorIP, ua: ua,        
                fbc: logData.fbc || null, fbp: logData.fbp || null, gclid: logData.gclid || null,
                gcl_au: logData.gcl_au || null, wbraid: logData.wbraid || null, gbraid: logData.gbraid || null,
                country: country, city: safeCity
            };
            const { error: dbError } = await supabase.from('form_submissions').insert([formData]);
            if (dbError) throw dbError;
            console.log("✅ 成功写入 [form_submissions] 表");
            return res.status(200).json({ success: true, type: 'form_submission' });
        } 
        
        // ==============================
        // 2. WhatsApp 点击 -> website_logs 表 (已修正为复数)
        // ==============================
        else if (logData.type === 'whatsapp') {
            const waData = {
                phone: logData.phone || logData.phone_number || null,
                referrer_url: logData.page_url || logData.referrer_url || null,
                ip: visitorIP, 
                user_agent: ua, 
                fbc: logData.fbc || null, 
                fbp: logData.fbp || null, 
                gclid: logData.gclid || null,
                country: country, 
                city: safeCity,
                // meta_capi_status: 'gometa',   // 若需点击立刻触发回传，取消注释
                // google_data_api: 'gogoogle'
            };
            
            // 清理空字段
            Object.keys(waData).forEach(key => waData[key] === undefined && delete waData[key]);

            // 写入 website_logs 表
            const { error: dbError } = await supabase.from('website_logs').insert([waData]);
            if (dbError) throw dbError;
            console.log("✅ 成功写入 [website_logs] 表");
            return res.status(200).json({ success: true, type: 'whatsapp' });
        }

        // ==============================
        // 3. Telegram 点击 -> tg_logs 表 (已修正为复数)
        // ==============================
        else if (logData.type === 'telegram') {
            const tgData = {
                phone: logData.phone || logData.phone_number || null, 
                referrer_url: logData.page_url || logData.referrer_url || null,
                ip: visitorIP, 
                user_agent: ua, 
                fbc: logData.fbc || null, 
                fbp: logData.fbp || null, 
                gclid: logData.gclid || null,
                country: country, 
                city: safeCity,
                // meta_capi_status: 'gometa',
                // google_data_api: 'gogoogle'
            };

            // 清理空字段
            Object.keys(tgData).forEach(key => tgData[key] === undefined && delete tgData[key]);

            // 写入 tg_logs 表
            const { error: dbError } = await supabase.from('tg_logs').insert([tgData]);
            if (dbError) throw dbError;
            console.log("✅ 成功写入 [tg_logs] 表");
            return res.status(200).json({ success: true, type: 'telegram' });
        }

        // ==============================
        // 4. 其他未知事件（兜底处理）
        // ==============================
        else {
            console.log("⚠️ 收到未知的事件类型:", logData.type, "没有写入任何表");
            return res.status(200).json({ success: true, warning: 'Unknown event type ignored' });
        }

    } catch (error) { 
        console.error("❌ /api/log Route Error:", error.message);
        res.status(500).json({ success: false, error: error.message }); 
    }
});

// --- Webhook ---
app.post('/api/webhook/supabase', async (req, res) => {
    console.log("Raw Webhook Payload:", JSON.stringify(req.body));

    try {
        const payload = req.body;
        const record = payload.record || payload.data;
        const table = payload.table;

        if (payload.type === 'UPDATE' && record) {
            const metaStatusVal = record.meta_capi_status ? String(record.meta_capi_status).trim().toLowerCase() : "";
            const googleStatusVal = record.google_data_api ? String(record.google_data_api).trim().toLowerCase() : "";

            console.log(`Processing ID: ${record.id} | Meta: "${metaStatusVal}" | Google: "${googleStatusVal}"`);

            const eventData = {
                id: record.id,
                phone: record.phone_number || record.phone,
                email: record.email,
                name: record.name,
                url: record.referrer_url,
                ip: record.ip,
                ua: record.user_agent || record.ua,
                fbc: record.fbc,
                fbp: record.fbp,
                country: record.country,
                city: record.city
            };

            let updatePayload = {};

            if (metaStatusVal === 'gometa') {
                const metaRes = await sendToMetaCAPI(eventData, 'Lead');
                if (metaRes !== record.meta_capi_status) updatePayload.meta_capi_status = metaRes;
            } else if (metaStatusVal === 'purchase') {
                const metaRes = await sendToMetaCAPI(eventData, 'Purchase', record.value, record.currency);
                if (metaRes !== record.meta_capi_status) updatePayload.meta_capi_status = metaRes;
            }

            if (googleStatusVal === 'gogoogle') {
                const googleRes = await sendToGoogleAds(record);
                if (googleRes !== record.google_data_api) updatePayload.google_data_api = googleRes;
            }

            if (Object.keys(updatePayload).length > 0 && supabase) {
                console.log("-> 更新数据库:", updatePayload);
                const { error } = await supabase
                    .from(table || 'website_logs')
                    .update(updatePayload)
                    .eq('id', record.id);
                if (error) console.error("❌ DB Update Error:", error);
            }
        }

        res.status(200).json({ success: true });
    } catch (error) {
        console.error("❌ Webhook Error:", error);
        res.status(500).json({ success: false });
    }
});

module.exports = app;
