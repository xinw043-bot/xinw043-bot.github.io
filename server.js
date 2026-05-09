const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

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

// 工具：北京时间
function getBeijingTime() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }).replace(/\//g, '-'); 
}

// 工具：Meta SHA256 基础加密
function hashMeta(val) {
    if (!val || val === 'Unknown' || val === 'NULL') return undefined;
    return crypto.createHash('sha256').update(val.toString().trim().toLowerCase()).digest('hex');
}

// 工具：Meta 电话专属加密 (去除非数字字符，Meta 'ph' 字段强制要求)
function hashPhone(val) {
    if (!val) return undefined;
    const clean = val.toString().replace(/[^\d]/g, '');
    if (!clean) return undefined;
    return crypto.createHash('sha256').update(clean).digest('hex');
}

// ✨ 升级版 Meta CAPI 回传函数：映射 client_phone
async function sendToMetaCAPI(eventData) {
    const pixelId = process.env.META_PIXEL_ID;
    const token = process.env.META_ACCESS_TOKEN;
    if (!pixelId || !token) return "Skipped: No Credentials";

    // 核心拦截逻辑：id 和 client_phone 是必填项
    // 如果您在触发 GO_META 时没有填 client_phone，将直接拦截并提示
    if (!eventData.id || !eventData.client_phone) {
        return "Failed: Missing ID or Client Phone";
    }

    const reportFields = ['ip', 'ua', 'id', 'client_phone'];

    const userData = {
        external_id: [hashMeta(eventData.id)],               // 必填 ID
        ph: [hashPhone(eventData.client_phone)],             // 必填 客户电话，正确映射至 Meta 的 'ph' 字段
        client_ip_address: eventData.ip,
        client_user_agent: eventData.ua
    };

    // 原有常规字段
    if (eventData.fbc) { userData.fbc = eventData.fbc; reportFields.push('fbc'); }
    if (eventData.fbp) { userData.fbp = eventData.fbp; reportFields.push('fbp'); }
    if (eventData.country && eventData.country !== 'Unknown') { userData.country = hashMeta(eventData.country); reportFields.push('country'); }
    if (eventData.city && eventData.city !== 'Unknown') { userData.ct = hashMeta(eventData.city); reportFields.push('city'); }

    // 选填字段：有则发，无则忽略
    if (eventData.email) {
        userData.em =[hashMeta(eventData.email)];
        reportFields.push('email');
    }
    if (eventData.name) {
        userData.fn = [hashMeta(eventData.name)];
        reportFields.push('name');
    }

    try {
        const payload = {
            data:[{
                event_name: 'Lead',
                event_time: Math.floor(Date.now() / 1000),
                action_source: 'website',
                event_source_url: eventData.url,
                user_data: userData
            }]
        };

        const response = await fetch(`https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${token}`, {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const resJson = await response.json();
        if (resJson.error) return `Meta Error: ${resJson.error.message}`;
        return `Success | Sent: ${reportFields.join(',')}`;
    } catch (e) {
        return `Meta Fetch Failed: ${e.message}`;
    }
}

// CORS 处理跨域
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
        
        if (!supabase) return res.status(500).json({ success: false, error: 'DB_CONNECTION_ERROR' });

        if (logData.type === 'form_submission') {
            const formData = {
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
                city: decodeURIComponent(req.headers['x-vercel-ip-city'] || 'Unknown') 
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
            phone_number: logData.phoneNumber,
            redirect_time: getBeijingTime(),
            ip: visitorIP,
            country: req.headers['x-vercel-ip-country'] || 'Unknown',
            city: decodeURIComponent(req.headers['x-vercel-ip-city'] || 'Unknown'),
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
        res.status(500).json({ success: false, error: error.message });
    }
});


// --- ✨ Webhook 接口：现在读取 client_phone 而不是业务员的 phone ---
app.post('/api/webhook/supabase', async (req, res) => {
    try {
        const payload = req.body;

        // 提取状态并转为小写、去空格，防止手误输入 "gometa " 导致不触发
        const currentStatus = payload.record?.meta_capi_status?.trim().toLowerCase();

        // 当状态等于 'gometa' 时触发
        if (payload.type === 'UPDATE' && payload.record && currentStatus === 'gometa') {
            const row = payload.record;
            const tableName = payload.table; // Supabase webhook 默认带有 table 字段

            console.log(`[Webhook Triggered] Table: ${tableName}, Row ID: ${row.id}`); // 打印日志方便排查

            const status = await sendToMetaCAPI({
                id: row.id,
                client_phone: row.client_phone,  
                email: row.email,                
                name: row.name,                  
                url: row.referrer_url,
                ip: row.ip,
                ua: row.user_agent || row.ua,
                fbc: row.fbc,
                fbp: row.fbp,
                country: row.country,
                city: row.city
            });

            // 把回传结果 (Success 或 Failed) 写回表格
            if (supabase) {
                const { error: updateErr } = await supabase.from(tableName).update({ meta_capi_status: status }).eq('id', row.id);
                if (updateErr) console.error("[Supabase Update Error]:", updateErr);
            }
        }

        res.status(200).json({ success: true });
    } catch (error) {
        console.error("Webhook Execution Error:", error);
        res.status(500).json({ success: false });
    }
});

module.exports = app;
