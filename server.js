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
        const uaLower = ua.toLowerCase();
        
        // 获取位置
        const country = req.headers['x-vercel-ip-country'] || 'Unknown';
        let city = req.headers['x-vercel-ip-city'] || 'Unknown';
        try { city = decodeURIComponent(city); } catch (e) {}

        // ================= 防护网 V3.1 (VPN 友好版) =================

        // 1. 基础关键词拦截 (这些词永远代表爬虫，不会误杀真人)
        // 注意：移除了对城市的判断，允许 VPN 用户通过
        const botKeywords = [
            'bot', 'spider', 'crawl', 
            'facebook', 'meta', 'whatsapp', 'preview', 
            'google', 'twitter', 'slack', 'ahrefs', 'pinterest', 
            'python', 'curl', 'wget'
        ];
        
        const isNamedBot = botKeywords.some(keyword => uaLower.includes(keyword));

        // 2. 针对性拦截 Facebook 特征指纹
        // Meta 的爬虫经常伪装成 Android，但型号写的是 "K"，这是绝对的破绽
        const isMetaFingerprint = ua.includes('Android 10; K');

        // 3. 拦截不存在的 Chrome 版本 (可选)
        // 既然爬虫喜欢伪造 Chrome/138+, 我们可以拦截极度离谱的版本
        // 但为了安全起见，这里先注释掉，只拦截上面两种最稳的
        // const isFakeVersion = ua.includes('Chrome/13') || ua.includes('Chrome/14');

        if (isNamedBot || isMetaFingerprint) {
            console.log(`🛡️ 拦截爬虫 | City: ${city} | UA: ${ua.substring(0, 30)}...`);
            // 返回成功，骗过爬虫
            return res.status(200).send({ success: true, skipped: true });
        }
        // =========================================================

        const visitorIP = req.headers['x-forwarded-for'] 
            ? req.headers['x-forwarded-for'].split(',')[0] 
            : req.ip;

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
        <h2>Real User Logs</h2><table><tr><th>Time</th><th>Loc</th><th>WA</th><th>IP</th><th>Device</th></tr>
        ${logs.map(log => `<tr><td>${log.redirect_time}</td><td>${log.country}/${log.city}</td><td>${log.phone_number}</td><td>${log.ip}</td><td style="font-size:12px">${log.user_agent ? log.user_agent.substring(0,25)+'...' : '-'}</td></tr>`).join('')}
        </table></body></html>`;
        res.send(html);
    } catch (error) {
        res.status(500).send(error.message);
    }
});

module.exports = app;
