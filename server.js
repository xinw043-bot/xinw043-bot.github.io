const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

// 环境变量配置 (Vercel后台必须配置 SUPABASE_KEY 为你的 service_role secret key)
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
    if (!pixelId || !token) return "Skipped: No Credentials";

    const reportFields = ['ip', 'ua'];
    if (eventData.fbc) reportFields.push('fbc');
    if (eventData.fbp) reportFields.push('fbp');
    if (eventData.country && eventData.country !== 'Unknown') reportFields.push('country');
    if (eventData.city && eventData.city !== 'Unknown') reportFields.push('city');

    try {
        const payload = {
            data:[{
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

        // --- 分支 1: 处理表单提交逻辑 ---
        if (logData.type === 'form_submission') {
            const formData = {
                name: logData.name,
                email: logData.email,
                company: logData.company,
                phone: logData.phone,
                page_url: logData.page_url,
                referrer_url: logData.referrer_url, // ✨ 补充了 Referrer URL 字段
                ip: visitorIP, // ✨ 由 Vercel 自动获取真实 IP
                ua: ua,        // ✨ 由 Vercel 自动获取真实 UA
                fbc: logData.fbc || null,
                fbp: logData.fbp || null,
                gclid: logData.gclid || null,
                gcl_au: logData.gcl_au || null,
                wbraid: logData.wbraid || null,
                gbraid: logData.gbraid || null,
                country: req.headers['x-vercel-ip-country'] || 'Unknown', // ✨ Vercel 自动获取国家
                city: decodeURIComponent(req.headers['x-vercel-ip-city'] || 'Unknown') // ✨ Vercel 自动获取城市
            };

            const { error: dbError } = await supabase.from('form_submissions').insert([formData]);
            if (dbError) throw dbError;
            return res.status(200).json({ success: true, type: 'form' });
        }

        // --- 分支 2: Telegram / WhatsApp 点击记录 ---
        let tableName = 'wa_logs'; 
        if (logData.is_telegram === true) {
            tableName = 'tg_logs';
        } else if (logData.is_website === true) {
            tableName = 'website_logs';
        }

        // 爬虫过滤
        if (ua.toLowerCase().includes('bot') || ua.toLowerCase().includes('crawl')) {
            return res.status(200).json({ success: true, skipped: 'bot' });
        }

        // 1. 查重
        let visitCount = 1;
        let queryStr = `ip.eq.${visitorIP}`;
        if (logData.fbp) queryStr += `,fbp.eq.${logData.fbp}`;
        const { data: pastLogs } = await supabase.from(tableName).select('id').or(queryStr);
        if (pastLogs && pastLogs.length > 0) visitCount = pastLogs.length + 1;

        // 2. Note 生成
        let pageUrl = logData.referrer_url || 'Direct';
        if (logData.note && logData.note.includes(' | ')) pageUrl = logData.note.split(' | ').slice(2).join(' | ');
        const actionTag = tableName === 'website_logs' ? 'WA_Main' : (tableName === 'tg_logs' ? 'TG_Main' : 'Intermediate');
        const finalNote = `${actionTag} | ${visitCount > 1 ? `Old User (Click #${visitCount})` : 'New User'} | ${pageUrl}`;

        // 3. 构建插入对象
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

        // 4. 执行写入
        const { data: insertedRows, error: dbError } = await supabase.from(tableName).insert([insertData]).select();
        if (dbError) throw dbError;

        // 5. 等待 Meta 回传
        if (['website_logs', 'tg_logs'].includes(tableName) && insertedRows && insertedRows[0]) {
            const status = await sendToMetaCAPI({
                url: pageUrl, ip: visitorIP, ua: ua,
                fbc: logData.fbc, fbp: logData.fbp,
                country: insertData.country, city: insertData.city
            });
            await supabase.from(tableName).update({ meta_capi_status: status }).eq('id', insertedRows[0].id);
        }

        res.status(200).json({ success: true });

    } catch (error) {
        console.error("Global API Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- 补发接口 ---
app.get('/api/backfill', async (req, res) => {
    // 保持原有逻辑
});

// --- 查重接口 ---
app.get('/api/check-phone', async (req, res) => {
    // 保持原有逻辑
});

module.exports = app;
