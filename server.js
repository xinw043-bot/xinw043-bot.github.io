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

// 工具：Meta 电话专属加密 (去除非数字字符)
function hashPhone(val) {
    if (!val) return undefined;
    const clean = val.toString().replace(/[^\d]/g, '');
    if (!clean) return undefined;
    return crypto.createHash('sha256').update(clean).digest('hex');
}

// ✨ 升级版 Meta CAPI 回传函数
async function sendToMetaCAPI(eventData) {
    const pixelId = process.env.META_PIXEL_ID;
    const token = process.env.META_ACCESS_TOKEN;
    if (!pixelId || !token) return "Skipped: No Credentials";

    // 核心拦截逻辑：id 和 phone 是必填项
    if (!eventData.id || !eventData.phone) {
        return "Failed: Missing ID or Phone";
    }

    const reportFields = ['ip', 'ua', 'id', 'phone'];

    const userData = {
        external_id: [hashMeta(eventData.id)],    // 必填 ID
        ph: [hashPhone(eventData.phone)],         // 必填 Phone
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
                event_name: 'qualified lead',
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
        
        if (!supabase) {
            console.error("❌ 严重错误: Supabase 未初始化，请检查环境变量");
            return res.status(500).json({ success: false, error: 'DB_CONNECTION_ERROR' });
        }

        // ⚠️ 修复点1：安全解析 City，防止 Vercel 特殊字符导致后端直接崩溃 (报500)
        let safeCity = 'Unknown';
        if (req.headers['x-vercel-ip-city']) {
            try {
                safeCity = decodeURIComponent(req.headers['x-vercel-ip-city']);
            } catch (e) {
                safeCity = req.headers['x-vercel-ip-city']; // 如果解析失败，直接使用原生字符串
            }
        }

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
                city: safeCity
            };

            const { error: dbError } = await supabase.from('form_submissions').insert([formData]);
            
            // ⚠️ 修复点2：将 Supabase 具体的拒绝原因打印到 Vercel 日志
            if (dbError) {
                console.error("❌ Supabase 写入失败 (form_submissions):", JSON.stringify(dbError));
                throw dbError; // 将错误抛出给全局 catch
            }
            
            return res.status(200).json({ success: true, type: 'form' });
        }

        // ======================= 下方是你原有的其他逻辑 =======================
        
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
            city: safeCity,  // 这里也同步应用了安全解码的城市
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
        if (dbError) {
            console.error(`❌ Supabase 写入失败 (${tableName}):`, JSON.stringify(dbError));
            throw dbError;
        }

        res.status(200).json({ success: true });
    } catch (error) {
        // ⚠️ 修复点3：确保全局异常信息能在 Vercel Logs 中显示
        console.error("❌ 接口发生全局异常:", error.message || error);
        res.status(500).json({ success: false, error: error.message || error });
    }
});


// --- ✨ 新增：监听 Supabase 数据库修改的 Webhook 接口 ---
app.post('/api/webhook/supabase', async (req, res) => {
    try {
        const payload = req.body;

        // 仅拦截 UPDATE 操作，并且只有当你在表格里把状态改成 'GO_META' 时才触发
        if (payload.type === 'UPDATE' && payload.record && payload.record.meta_capi_status === 'gometa') {
            const row = payload.record;
            const tableName = payload.table;

            // 调用回传函数，获取数据库里的最新字段发送
            const status = await sendToMetaCAPI({
                id: row.id,
                phone: row.phone_number || row.phone, // 兼容不同表的列名
                email: row.email,                     // 如果数据库没有该列，将是 undefined，自动忽略
                name: row.name,                       // 同上
                url: row.referrer_url,
                ip: row.ip,
                ua: row.user_agent || row.ua,
                fbc: row.fbc,
                fbp: row.fbp,
                country: row.country,
                city: row.city
            });

            // 成功或失败后，再次更新该行数据的状态，刷新回执
            if (supabase) {
                await supabase.from(tableName).update({ meta_capi_status: status }).eq('id', row.id);
            }
        }

        res.status(200).json({ success: true });
    } catch (error) {
        console.error("Webhook Execution Error:", error);
        res.status(500).json({ success: false });
    }
});

module.exports = app;
