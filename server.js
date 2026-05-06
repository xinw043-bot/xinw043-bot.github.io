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

// Meta CAPI 回传函数
async function sendToMetaCAPI(eventData) {
    const pixelId = process.env.META_PIXEL_ID;
    const token = process.env.META_ACCESS_TOKEN;
    if (!pixelId || !token) return "Skipped: No Meta Credentials";

    const reportFields = ['ip', 'ua'];
    if (eventData.fbc) reportFields.push('fbc');
    if (eventData.fbp) reportFields.push('fbp');
    if (eventData.country && eventData.country !== 'Unknown') reportFields.push('country');
    if (eventData.city && eventData.city !== 'Unknown') reportFields.push('city');

    try {
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
        if (resJson.error) return `Meta Error: ${resJson.error.message}`;
        return `Success | Sent: ${reportFields.join(',')}`;
    } catch (e) {
        return `Meta Fetch Failed: ${e.message}`;
    }
}

// CORS 处理
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
        
        // 1. 分表逻辑
        let tableName = 'wa_logs'; // 默认中间页
        if (logData.is_website === true) {
            tableName = 'website_logs'; // 网站主站 WhatsApp
        } else if (logData.is_telegram === true) {
            tableName = 'tg_logs'; // 网站主站 Telegram
        }

        // 2. 查重及 Note 生成 (彻底删除 cet_uid 引用)
        let visitCount = 1;
        let queryStr = `ip.eq.${visitorIP}`;
        if (logData.fbp) queryStr += `,fbp.eq.${logData.fbp}`;

        const { data: pastLogs } = await supabase.from(tableName).select('id').or(queryStr);
        if (pastLogs && pastLogs.length > 0) visitCount = pastLogs.length + 1;

        let pageUrl = logData.referrer_url || 'Direct';
        if (logData.note && logData.note.includes(' | ')) {
            pageUrl = logData.note.split(' | ').slice(2).join(' | ');
        }
        
        const actionTag = tableName === 'website_logs' ? 'WA_Main' : (tableName === 'tg_logs' ? 'TG_Main' : 'Intermediate');
        const finalNote = `${actionTag} | ${visitCount > 1 ? `Old User (Click #${visitCount})` : 'New User'} | ${pageUrl}`;

        // 3. 构建写入对象 (严格对齐你的截图字段，彻底移除 cet_uid)
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

        // 只有主站两个表包含此字段，wa_logs (中间页) 不包含
        if (tableName !== 'wa_logs') {
            insertData.meta_capi_status = "Pending";
        }

        // 4. 执行写入
        const { data: insertedRows, error: dbError } = await supabase.from(tableName).insert([insertData]).select();

        if (dbError) {
            console.error(`Supabase Insert Error:`, dbError.message);
            return res.status(500).json({ success: false, error: dbError.message });
        }

        // 5. 触发 Meta 回传并更新状态
        if (['website_logs', 'tg_logs'].includes(tableName)) {
            sendToMetaCAPI({
                url: pageUrl, ip: visitorIP, ua: ua,
                fbc: logData.fbc, fbp: logData.fbp,
                country: insertData.country, city: insertData.city
            }).then(status => {
                if (insertedRows && insertedRows[0]) {
                    supabase.from(tableName).update({ meta_capi_status: status }).eq('id', insertedRows[0].id).then(()=>{});
                }
            });
        }

        res.status(200).json({ success: true });

    } catch (error) {
        console.error("Critical API Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- 补发接口 ---
app.get('/api/backfill', async (req, res) => {
    const { pwd, table } = req.query;
    if (pwd !== '123456') return res.status(403).send('Auth Failed');
    const tName = table === 'website' ? 'website_logs' : (table === 'tg' ? 'tg_logs' : null);
    if (!tName) return res.send('Table invalid');

    const { data: logs } = await supabase.from(tName).select('*').or('meta_capi_status.is.null,meta_capi_status.eq.Pending').limit(15);
    if (!logs || logs.length === 0) return res.send('All caught up');

    for (const item of logs) {
        let pUrl = item.referrer_url || '';
        if (item.note && item.note.includes(' | ')) pUrl = item.note.split(' | ').slice(2).join(' | ');
        const status = await sendToMetaCAPI({ url: pUrl, ip: item.ip, ua: item.user_agent, fbc: item.fbc, fbp: item.fbp, country: item.country, city: item.city });
        await supabase.from(tName).update({ meta_capi_status: `Backfill: ${status}` }).eq('id', item.id);
    }
    res.json({ processed: logs.length });
});

// --- 查重接口 ---
app.get('/api/check-phone', async (req, res) => {
    try {
        const visitorIP = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.ip;
        const { data } = await supabase.from('wa_logs').select('phone_number').eq('ip', visitorIP).order('id', { ascending: false }).limit(1);
        res.json({ found: !!(data && data.length), phone: data?.[0]?.phone_number });
    } catch (e) { res.json({ found: false }); }
});

module.exports = app;
