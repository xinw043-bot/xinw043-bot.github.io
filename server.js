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

// 工具：Meta SHA256 加密
function hashMeta(val) {
    if (!val || val === 'Unknown' || val === 'NULL') return undefined;
    return crypto.createHash('sha256').update(val.trim().toLowerCase()).digest('hex');
}

// Meta CAPI 回传函数（发送事件配置为 Lead）
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
                event_name: 'Lead', // 转化事件定为 Lead
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

        if (logData.type === 'form_submission') {
            const formData = {
                // ... (与上一版本保持一致)
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

        // 核心变更点：仅存入 Pending，不再自动触发发送
        if (tableName !== 'wa_logs') insertData.meta_capi_status = "Pending";

        const { error: dbError } = await supabase.from(tableName).insert([insertData]).select();
        if (dbError) throw dbError;

        res.status(200).json({ success: true });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- ✨ 新版手动回传接口（支持列出名单 & 指定行发送） ---
app.post('/api/trigger-capi', async (req, res) => {
    try {
        const { keyword, action, id, tableName } = req.body;
        
        if (keyword !== 'capigo') return res.status(403).json({ success: false, error: 'Forbidden' });
        if (!supabase) return res.status(500).json({ success: false, error: 'DB_CONNECTION_ERROR' });

        // 分支 1：请求获取积压数据列表
        if (action === 'list') {
            let allPending = [];
            const tablesToCheck =['website_logs', 'tg_logs'];
            
            // 查询每个表里最新生成的 50 条 Pending 数据
            for (const t of tablesToCheck) {
                const { data, error } = await supabase
                    .from(t)
                    .select('id, phone_number, redirect_time')
                    .eq('meta_capi_status', 'Pending')
                    .order('id', { ascending: false }) 
                    .limit(50);
                
                if (data) {
                    data.forEach(row => { row.tableName = t; allPending.push(row); });
                }
            }
            
            // 简单按时间排序，最新的排在前面
            allPending.sort((a, b) => new Date(b.redirect_time) - new Date(a.redirect_time));
            return res.status(200).json({ success: true, data: allPending });
        } 
        
        // 分支 2：请求触发指定单行数据的回传
        else if (action === 'send') {
            if (!id || !tableName) return res.status(400).json({ success: false, error: 'Missing row identifier' });
            
            // 根据前端传来的 ID 获取具体的一条记录
            const { data: rows, error: fetchErr } = await supabase.from(tableName).select('*').eq('id', id);
            if (fetchErr || !rows || rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Record not found' });
            }
            
            const rowToProcess = rows[0];

            // 把这单条数据发给 Meta
            const status = await sendToMetaCAPI({
                url: rowToProcess.referrer_url, 
                ip: rowToProcess.ip, 
                ua: rowToProcess.user_agent,
                fbc: rowToProcess.fbc, 
                fbp: rowToProcess.fbp,
                country: rowToProcess.country, 
                city: rowToProcess.city
            });

            // 更新这单条数据的状态为已发送 (Success 等)
            await supabase.from(tableName).update({ meta_capi_status: status }).eq('id', id);

            return res.status(200).json({ success: true, status: status });
        }

        return res.status(400).json({ success: false, error: 'Invalid action' });

    } catch (error) {
        console.error("Trigger CAPI Error:", error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// --- 补发接口 ---
app.get('/api/backfill', async (req, res) => { /* 保持原有逻辑 */ });

// --- 查重接口 ---
app.get('/api/check-phone', async (req, res) => { /* 保持原有逻辑 */ });

module.exports = app;
