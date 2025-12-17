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

        // ================= 防护网 V3.0 (安全版) =================

        // 1. 基础关键词拦截 (这些词永远代表爬虫，不会误杀)
        const botKeywords = ['bot', 'spider', 'crawl', 'facebook', 'meta', 'whatsapp', 'preview', 'google', 'twitter', 'slack', 'ahrefs', 'pinterest'];
        const isNamedBot = botKeywords.some(keyword => uaLower.includes(keyword));

        // 2. 数据中心城市拦截 (这些城市几乎只有服务器)
        // 即使有真人，概率极低，且真人的手机网络 IP 通常不会定位到数据中心精确地址
        const dataCenterCities = ['Prineville', 'Boardman', 'Forest City', 'Altoona', 'Ashburn', 'Clonee', 'Luleå'];
        const isDataCenter = dataCenterCities.some(c => city.includes(c));

        // 3. 针对性拦截 Facebook 特征 (这个 'Android 10; K' 是 Meta 爬虫的独家签名)
        // 这不是版本号，而是一个错误的型号标识，永久有效，不会误杀
        const isMetaFingerprint = ua.includes('Android 10; K');

        // 判定逻辑：满足任一条件即拦截
        // 去掉了 Chrome 版本号拦截，避免未来误杀
        if (isNamedBot || isDataCenter || isMetaFingerprint) {
            console.log(`🛡️ 拦截爬虫 | City: ${city} | UA: ${ua.substring(0, 30)}...`);
            return res.status(200).send({ success: true, skipped: true });
        }
        // =======================================================

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
