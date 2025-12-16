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

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

app.post('/api/log', async (req, res) => {
    try {
        const logData = req.body;
        const ua = req.get('User-Agent') || '';
        
        // --- 【核心新增】爬虫拦截器 ---
        // 定义爬虫关键词
        const botKeywords = ['bot', 'spider', 'crawl', 'facebook', 'meta', 'whatsapp', 'preview', 'google'];
        // 检查 UA 是否包含这些词 (转小写比较)
        const isBot = botKeywords.some(keyword => ua.toLowerCase().includes(keyword));
        
        // 专门拦截那个伪造的 Facebook 安卓爬虫
        const isFakeAndroid = ua.includes('Android 10; K');

        if (isBot || isFakeAndroid) {
            console.log(`🚫 拦截爬虫: ${ua.substring(0, 50)}...`);
            // 直接返回成功，骗过爬虫，但不写入数据库
            return res.status(200).send({ success: true, skipped: true });
        }
        // -----------------------------

        const visitorIP = req.headers['x-forwarded-for'] 
            ? req.headers['x-forwarded-for'].split(',')[0] 
            : req.ip;

        const country = req.headers['x-vercel-ip-country'] || 'Unknown';
        let city = req.headers['x-vercel-ip-city'] || 'Unknown';
        try { city = decodeURIComponent(city); } catch (e) {}

        const bjTime = getBeijingTime();

        if (!supabase) return res.status(200).send({ success: false });

        const { error } = await supabase
            .from('wa_logs')
            .insert({
                phone_number: logData.phoneNumber,
                redirect_time: bjTime,
                ip: visitorIP,
                country: country,
                city: city,
                user_agent: ua
            });

        if (error) throw error;

        res.status(200).send({ success: true });

    } catch (error) {
        console.error('SERVER_ERROR:', error.message);
        res.status(200).send({ success: false });
    }
});

app.get('/api/logs', async (req, res) => {
    // 这里保持不变...
    if (!supabase) return res.send('Config Error');
    if (req.query.pwd !== '123456') return res.send('🔒 Password Error');

    try {
        const { data: logs, error } = await supabase
            .from('wa_logs')
            .select('*')
            .order('id', { ascending: false })
            .limit(50);

        if (error) throw error;
        
        let html = `<html><head><meta charset="UTF-8"><title>Data</title>
        <style>table{width:100%;border-collapse:collapse;}th,td{border:1px solid #ddd;padding:8px;}tr:nth-child(even){background:#f9f9f9;}</style></head><body>
        <h2>Real User Logs</h2><table><tr><th>Time</th><th>Loc</th><th>WA</th><th>IP</th></tr>
        ${logs.map(log => `<tr><td>${log.redirect_time}</td><td>${log.country}/${log.city}</td><td>${log.phone_number}</td><td>${log.ip}</td></tr>`).join('')}
        </table></body></html>`;
        res.send(html);
    } catch (error) {
        res.status(500).send(error.message);
    }
});

module.exports = app;
