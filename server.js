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

    const userData = {
        external_id: [hashMeta(eventData.id)],
        ph: [hashPhone(eventData.phone)],
        client_ip_address: eventData.ip,
        client_user_agent: eventData.ua
    };

    if (eventData.fbc) userData.fbc = eventData.fbc;
    if (eventData.fbp) userData.fbp = eventData.fbp;
    if (eventData.email) userData.em = [hashMeta(eventData.email)];
    if (eventData.name) userData.fn = [hashMeta(eventData.name)];
    if (eventData.country) userData.ge = [hashMeta(eventData.country.substring(0, 2))];
    if (eventData.city) userData.ct = [hashMeta(eventData.city)];

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
        return resJson.error ? `Meta Error: ${resJson.error.message}` : `✅ Meta:${eventName}`;
    } catch (e) {
        return `Meta Failed: ${e.message}`;
    }
}

// ==================== Google Ads（关键修复）===================
// ==================== Google Ads（已按你要求优化）===================
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

        const customer = googleClient.Customer({
            customer_id: customerId,
            refresh_token: refreshToken,
            login_customer_id: loginCustomerId || undefined,
        });

        // 用于回执显示实际发送了哪些字段
        const sentFields = ['id', 'phone', 'value'];

        const userIdentifiers = [{ hashed_phone_number: hashPhone(rawPhone) }];

        if (row.email) {
            userIdentifiers.push({ hashed_email: hashMeta(row.email) });
            sentFields.push('email');
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

        // ==================== 选传字段 ====================
        if (row.gclid) {
            conversion.gclid = row.gclid;
            sentFields.push('gclid');
        }
        if (row.gcl_au) {
            conversion.gcl_au = row.gcl_au;
            sentFields.push('gcl_au');
        }
        if (row.wbraid) {
            conversion.wbraid = row.wbraid;
            sentFields.push('wbraid');
        }
        if (row.gbraid) {
            conversion.gbraid = row.gbraid;
            sentFields.push('gbraid');
        }

        // 新增：国家/城市（有就传，没有就不传）
        if (row.country || row.city) {
            conversion.user_location = {
                country_code: row.country ? row.country.substring(0, 2).toUpperCase() : undefined,
                city: row.city || undefined
            };
            sentFields.push('user_location');
        }

        const response = await customer.conversionUploads.uploadClickConversions({
            conversions: [conversion],
            partial_failure: true
        });

        if (response.partial_failure_error) {
            console.error("Google Partial Failure:", response.partial_failure_error);
            return `❌ Google Partial Error`;
        }

        // ✅ 你想要的回执格式
        const successMsg = `✅ Google Success | Sent: ${sentFields.join(', ')}`;
        console.log(`✅ Google Success for ID ${row.id} | ${successMsg}`);
        
        return successMsg;

    } catch (err) {
        console.error("❌ Google Ads Full Error:", err);
        return `❌ Google Ads Error: ${err.message || 'Unknown'}`;
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

app.post('/api/log', async (req, res) => { /* ... 保持你原来的代码 */ });

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
                const metaRes = await sendToMetaCAPI(eventData, 'qualified lead');
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
