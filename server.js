const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(bodyParser.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
let supabase = null;

if (supabaseUrl && supabaseKey) {
    try {
        supabase = createClient(supabaseUrl, supabaseKey);
    } catch (e) {}
}

function getBeijingTime() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }).replace(/\//g, '-'); 
}

// --- 核心修复：CORS 预检深度处理 ---
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // 2月后失效主因：OPTIONS 必须直接返回 204/200，不能进入后续路由
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

// --- 查重接口 (保持原样) ---
app.get('/api/check-phone', async (req, res) => {
    try {
        if (!supabase) return res.json({ found: false });
        const visitorIP = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.ip;
        const { data: tgData } = await supabase.from('tg_logs').select('phone_number').eq('ip', visitorIP).order('id', { ascending: false }).limit(1);
        if (tgData && tgData.length > 0) return res.json({ found: true, phone: tgData[0].phone_number, source: 'tg' });
        const { data: webData } = await supabase.from('website_logs').select('phone_number').eq('ip', visitorIP).order('id', { ascending: false }).limit(1);
        if (webData && webData.length > 0) return res.json({ found: true, phone: webData[0].phone_number, source: 'website' });
        const { data: waData } = await supabase.from('wa_logs').select('phone_number').eq('ip', visitorIP).order('id', { ascending: false }).limit(1);
        if (waData && waData.length > 0) return res.json({ found: true, phone: waData[0].phone_number, source: 'landing' });
        return res.json({ found: false });
    } catch (error) { res.json({ found: false }); }
});

// --- 写入接口 (已补充精准查重与 Note 重写逻辑) ---
app.post('/api/log', async (req, res) => {
    try {
        const logData = req.body;
        const ua = req.get('User-Agent') || '';
        const uaLower = ua.toLowerCase();
        
        // 分表逻辑
        let tableName = 'wa_logs';
        if (logData.is_telegram === true) tableName = 'tg_logs';
        else if (logData.is_website === true) tableName = 'website_logs';

        // 爬虫拦截
        const botKeywords =['bot', 'spider', 'crawl', 'facebook', 'meta', 'whatsapp', 'preview', 'google', 'twitter', 'slack', 'python'];
        if (botKeywords.some(keyword => uaLower.includes(keyword))) {
            return res.status(200).send({ success: true, skipped: true });
        }

        const country = req.headers['x-vercel-ip-country'] || 'Unknown';
        let city = req.headers['x-vercel-ip-city'] || 'Unknown';
        try { city = decodeURIComponent(city); } catch (e) {}
        
        // 后端直接抓取最真实 IP，防前端伪造
        const visitorIP = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.ip;
        const bjTime = getBeijingTime();

        if (!supabase) return res.status(200).send({ success: false });

        // ==========================================
        // ✨ 1. 后端精准查重：利用 IP 和 Cookie (fbp) 
        // ==========================================
        let visitCount = 1; // 默认为 1
        let queryConditions =[];
        
        // 构建 OR 查询条件：IP 相同，或者 fbp(Cookie) 相同，都算作同一个人
        if (visitorIP) queryConditions.push(`ip.eq.${visitorIP}`);
        if (logData.fbp) queryConditions.push(`fbp.eq.${logData.fbp}`);

        if (queryConditions.length > 0) {
            const orQuery = queryConditions.join(',');
            // 去数据库中检索这个人的历史记录数量
            const { data: pastLogs, error: searchError } = await supabase
                .from(tableName)
                .select('id')
                .or(orQuery);
            
            if (!searchError && pastLogs && pastLogs.length > 0) {
                visitCount = pastLogs.length + 1; // 查到了历史记录，加上当前的这一次
            }
        }

        // ==========================================
        // ✨ 2. 重写 Note 字段格式 (剥离出带长参数的 URL)
        // ==========================================
        let actionPrefix = 'Chat';
        let pageUrl = logData.referrer_url || '';

        // 前端传来的格式通常是: "Chat | New User | https://cethermal.com/?utm_source..."
        if (logData.note) {
            const parts = logData.note.split(' | ');
            if (parts.length >= 3) {
                actionPrefix = parts[0]; // 提取动作 (Chat 或 Form)
                pageUrl = parts.slice(2).join(' | '); // 提取最后面的完整长链接(即使链接里包含 | 也能正确合并)
            } else {
                pageUrl = logData.note; // 如果格式异常，作为兜底
            }
        }

        // 根据后端查重结果生成绝对精准的状态
        const trueStatus = visitCount > 1 ? `Old User (Click #${visitCount})` : 'New User';
        
        // 组装成您要求的最终格式: 
        // Chat | Old User (Click #2) | https://cethermal.com/?utm_source=fb...
        const finalNote = `${actionPrefix} | ${trueStatus} | ${pageUrl}`;


        // ==========================================
        // ✨ 3. 执行最终写入
        // ==========================================
        const { error } = await supabase
            .from(tableName)
            .insert({
                phone_number: logData.phoneNumber, 
                redirect_time: bjTime,
                ip: visitorIP, 
                country: country,
                city: city,
                user_agent: ua, 
                language: logData.language || 'en',
                inquiry_id: logData.inquiryId || 'N/A',
                note: finalNote,  // <--- 写入重写后的精准 Note !!!
                referrer_url: logData.referrer_url || 'Direct', 
                fbc: logData.fbc || null,
                fbp: logData.fbp || null,
                gclid: logData.gclid || null,
                wbraid: logData.wbraid || null,
                gbraid: logData.gbraid || null,
                gcl_au: logData.gcl_au || null
            });

        if (error) throw error;
        res.status(200).send({ success: true });
    } catch (error) {
        res.status(200).send({ success: false });
    }
});

// 日志查询 (保持原样)
app.get('/api/logs', async (req, res) => {
    if (!supabase) return res.send('Config Error');
    if (req.query.pwd !== '123456') return res.send('🔒 Password Error');
    let tableName = 'wa_logs';
    if (req.query.table === 'website') tableName = 'website_logs';
    if (req.query.table === 'tg') tableName = 'tg_logs';
    try {
        const { data: logs } = await supabase.from(tableName).select('*').order('id', { ascending: false }).limit(50);
        res.json(logs);
    } catch (error) { res.status(500).send(error.message); }
});

module.exports = app;
