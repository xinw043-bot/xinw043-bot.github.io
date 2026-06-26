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
const { GoogleAdsApi, services } = require('google-ads-api'); // 修复点：提前解构 services

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

    if (eventName === 'Purchase') {
        if (!value || !currency) {
            return "Failed: Missing Value or Currency for Purchase"; 
        }
    }

    const sentFields = ['external_id', 'ph'];   
    const userData = {
        external_id: [hashMeta(eventData.id)],
        ph: [hashPhone(eventData.phone)]
    };

    if (eventData.ip) { userData.client_ip_address = eventData.ip; sentFields.push('ip'); }
    if (eventData.ua) { userData.client_user_agent = eventData.ua; sentFields.push('ua'); }
    if (eventData.fbc) { userData.fbc = eventData.fbc; sentFields.push('fbc'); }
    if (eventData.fbp) { userData.fbp = eventData.fbp; sentFields.push('fbp'); }
    if (eventData.email) { userData.em = [hashMeta(eventData.email)]; sentFields.push('email'); }
    if (eventData.name) { userData.fn = [hashMeta(eventData.name)]; sentFields.push('name'); }
    if (eventData.country) { userData.ge = [hashMeta(eventData.country.substring(0, 2))]; sentFields.push('country'); }
    if (eventData.city) { userData.ct = [hashMeta(eventData.city)]; sentFields.push('city'); }

    const payloadData = {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_source_url: eventData.url,
        user_data: userData
    };

    if (value) { 
        payloadData.custom_data = { 
            value: parseFloat(value), 
            currency: (currency || 'USD').toUpperCase() 
        };
        sentFields.push(`value(${payloadData.custom_data.value})`);
        sentFields.push(`currency(${payloadData.custom_data.currency})`);
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

// ==================== Google Ads API ====================
async function sendToGoogleAds(row) {
    const customerIdRaw = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').trim();
    const loginCustomerIdRaw = (process.env.GOOGLE_LOGIN_CUSTOMER_ID || '').trim();
    const conversionActionId = (process.env.GOOGLE_CONVERSION_ACTION_ID || '').trim();
    const refreshToken = (process.env.GOOGLE_REFRESH_TOKEN || '').trim();

    const customerId = customerIdRaw.replace(/-/g, '');
    const loginCustomerId = loginCustomerIdRaw.replace(/-/g, '');

    // 💡 逻辑变更：删除了之前的 "if (!row.gclid...) return" 拦截器
    // 即使没有 GCLID，我们也允许进入发送流程，依靠加密手机号进行匹配

    try {
        if (!customerId || customerId.length !== 10) return `❌ Invalid GOOGLE_ADS_CUSTOMER_ID`;
        if (!conversionActionId) return `❌ Missing GOOGLE_CONVERSION_ACTION_ID`;
        if (!refreshToken) return `❌ Missing GOOGLE_REFRESH_TOKEN`;

        const rawPhone = row.phone_number || row.phone;
        if (!row.id || !rawPhone || !row.value) return `❌ Missing required fields(id, phone, value)`;

        const customer = googleClient.Customer({
            customer_id: customerId,
            refresh_token: refreshToken,
            login_customer_id: loginCustomerId || undefined,
        });

        const sentFields = ['id', 'phone', 'value'];
        sentFields.push(row.currency ? 'currency' : 'currency(USD)');
        
        // 关键：即使用户没有点广告，这部分加密信息也会发给谷歌进行“增强型”匹配
        const userIdentifiers = [{ hashed_phone_number: hashPhone(rawPhone) }];
        if (row.email) {
            userIdentifiers.push({ hashed_email: hashMeta(row.email) });
            sentFields.push('email');
        }
        if (row.gcl_au) sentFields.push('gcl_au');

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

        // 有哪个 ID 就传哪个，都没有就不传这些字段
        if (row.gclid) { conversion.gclid = row.gclid; sentFields.push('gclid'); }
        if (row.wbraid) { conversion.wbraid = row.wbraid; sentFields.push('wbraid'); }
        if (row.gbraid) { conversion.gbraid = row.gbraid; sentFields.push('gbraid'); }

        if (row.country || row.city) {
           conversion.user_location = {
               country_code: row.country ? row.country.substring(0, 2).toUpperCase() : undefined,
               city: row.city || undefined
           };
           sentFields.push('user_location');
        }

        const request = new services.UploadClickConversionsRequest({
            customer_id: customerId,           
            conversions: [conversion],
            partial_failure: true
        });

        const response = await customer.conversionUploads.uploadClickConversions(request);

        // 这里的报错处理会告诉你，如果没有 GCLID 且手机号也没匹配上，谷歌会报什么错
        if (response.partial_failure_error) {
            console.error("Google Partial Error:", JSON.stringify(response.partial_failure_error));
            return `❌ Google Error: ${response.partial_failure_error.message}`;
        }

        const successMsg = `✅ Google Ads | Sent: ${sentFields.join(', ')}`;
        console.log(`✅ Google Success for ID ${row.id} → ${successMsg}`);
        return successMsg;

    } catch (err) {
        console.error("❌ Google Ads Full Error:", err);
        return `❌ Google Ads Error: ${err.message}`;
    }
}

// ==================== GA4 Measurement Protocol ====================
async function sendToGA4(record, eventName = 'purchase') {
    const measurementId = process.env.GA4_MEASUREMENT_ID;
    const apiSecret = process.env.GA4_API_SECRET;

    if (!measurementId || !apiSecret) return "❌ GA4 Error: Missing API Key";
    if (!record.ga_client_id) return "⚠️ GA4 Skipped: No Client ID";

    // --- 定义回执中显示的字段简写 ---
    const sentFields = ['cid', 'tid']; // cid: client_id, tid: transaction_id
    if (record.value) sentFields.push('val');
    if (record.currency) sentFields.push('cur');
    if (record.referrer_url) sentFields.push('src'); // src: source
    
    const cType = record.note ? record.note.split(' | ')[0] : 'Inquiry';
    if (cType) sentFields.push('type'); // type: content_type

    const payload = {
        client_id: record.ga_client_id, 
        events: [{
            name: eventName,
            params: {
                transaction_id: record.inquiry_id || `ID_${record.id}`,
                value: parseFloat(record.value || 0),
                currency: (record.currency || 'USD').toUpperCase(),
                engagement_time_msec: "100",
                source: record.referrer_url || 'Direct',
                content_type: cType
            }
        }]
    };

    try {
        const url = `https://www.google-analytics.com/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}`;
        const response = await fetch(url, {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        
        // GA4 MP 成功通常返回 204 No Content
        if (response.status === 204 || response.status === 200) {
            const successMsg = `✅ GA4:${eventName} | Sent: ${sentFields.join(', ')}`;
            console.log(`✅ GA4 Success for ID ${record.id} → ${successMsg}`);
            return successMsg; // 这个字符串会写入 google_data_api 字段
        } else {
            return `❌ GA4 Error: ${response.status}`;
        }
    } catch (e) {
        return `❌ GA4 Failed: ${e.message}`;
    }
}

// ==================== CORS + Routes ====================
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// --- api 核心写入接口 ---
app.post('/api/log', async (req, res) => {
    try {
        const logData = req.body;
        const ua = req.get('User-Agent') || '';
        const visitorIP = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.ip;
        
        if (!supabase) {
            console.error("❌ 严重错误: Supabase 未初始化，请检查环境变量");
            return res.status(500).json({ success: false, error: 'DB_CONNECTION_ERROR' });
        }

        let safeCity = 'Unknown';
        if (req.headers['x-vercel-ip-city']) {
            try {
                safeCity = decodeURIComponent(req.headers['x-vercel-ip-city']);
            } catch (e) {
                safeCity = req.headers['x-vercel-ip-city']; 
            }
        }

        if (logData.type === 'form_submission') {
            const formData = {
                ga_client_id: logData.ga_client_id || null, // 写入 GA Client ID
                name: logData.name,
                email: logData.email,
                company: logData.company,
                phone: logData.phone,
                page_url: logData.page_url,
                referrer_url: logData.referrer_url, 
                ip: visitorIP, 
                ua: ua,        
                fbc: logData.fbc || null,
                fbp: logData.fbp || null,
                gclid: logData.gclid || null,
                gcl_au: logData.gcl_au || null,
                wbraid: logData.wbraid || null,
                gbraid: logData.gbraid || null,
                country: req.headers['x-vercel-ip-country'] || 'Unknown', 
                city: safeCity
            };

            const { error: dbError } = await supabase.from('form_submissions').insert([formData]);
            if (dbError) throw dbError;
            return res.status(200).json({ success: true, type: 'form' });
        }
        
        let tableName = 'wa_logs'; 
        if (logData.is_telegram === true) {
            tableName = 'tg_logs';
        } else if (logData.is_website === true) {
            tableName = 'website_logs';
        }

        if (ua.toLowerCase().includes('bot') || ua.toLowerCase().includes('crawl')) {
            return res.status(200).json({ success: true, skipped: 'bot' });
        }

        let visitCount = 1;
        let queryStr = `ip.eq.${visitorIP}`;
        if (logData.fbp) queryStr += `,fbp.eq.${logData.fbp}`;
        const { data: pastLogs } = await supabase.from(tableName).select('id').or(queryStr);
        if (pastLogs && pastLogs.length > 0) visitCount = pastLogs.length + 1;

        let pageUrl = logData.referrer_url || 'Direct';
        if (logData.note && logData.note.includes(' | ')) pageUrl = logData.note.split(' | ').slice(2).join(' | ');
        const actionTag = tableName === 'website_logs' ? 'WA_Main' : (tableName === 'tg_logs' ? 'TG_Main' : 'Intermediate');
        const finalNote = `${actionTag} | ${visitCount > 1 ? `Old User (Click #${visitCount})` : 'New User'} | ${pageUrl}`;

        const insertData = {
            ga_client_id: logData.ga_client_id || null, // 写入 GA Client ID
            phone_number: logData.phoneNumber,
            ip: visitorIP,
            country: req.headers['x-vercel-ip-country'] || 'Unknown',
            city: safeCity,  
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
            gcl_au: logData.gcl_au || null
        };

        if (tableName !== 'wa_logs') insertData.meta_capi_status = "Pending";

        const { error: dbError } = await supabase.from(tableName).insert([insertData]);
        if (dbError) throw dbError;

        res.status(200).json({ success: true });
    } catch (error) {
        console.error("❌ 接口发生全局异常:", error.message || error);
        res.status(500).json({ success: false, error: error.message || error });
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

            // Meta 逻辑
            if (metaStatusVal === 'gometa') {
                const metaRes = await sendToMetaCAPI(eventData, 'Lead', record.value, record.currency);
                if (metaRes !== record.meta_capi_status) updatePayload.meta_capi_status = metaRes;
            } else if (metaStatusVal === 'purchase') {
                const metaRes = await sendToMetaCAPI(eventData, 'Purchase', record.value, record.currency);
                if (metaRes !== record.meta_capi_status) updatePayload.meta_capi_status = metaRes;
            }

            // Google & GA4 逻辑
            if (googleStatusVal === 'gogoogle') {
                // 1. Google Ads API 离线转化 (已加无 GCLID 拦截)
                const googleRes = await sendToGoogleAds(record);
                
                // 2. 同步发送给 GA4
                await sendToGA4(record, 'purchase'); 
                
                if (googleRes !== record.google_data_api) updatePayload.google_data_api = googleRes;

            } else if (googleStatusVal === 'goga4') {
                // 仅触发 GA4，适合自然流量
                const ga4Res = await sendToGA4(record, 'purchase'); 
                updatePayload.google_data_api = ga4Res; 
            }

            // 更新数据库
            if (Object.keys(updatePayload).length > 0 && supabase) {
                console.log("-> 更新数据库:", updatePayload);
                const { error } = await supabase
                    .from(table || 'website_logs')
                    .update(updatePayload)
                    .eq('id', record.id);
                if (error) console.error("❌ DB Update Error:", error);
            }
        }

        res.status(200).json({ success: true }); // 修复点：正确的结束请求
    } catch (error) {
        console.error("❌ Webhook Error:", error);
        res.status(500).json({ success: false });
    }
});

module.exports = app;
