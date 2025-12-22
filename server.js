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

// 北京时间工具函数
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
        
        // 1. 获取地理位置
        const country = req.headers['x-vercel-ip-country'] || 'Unknown';
        let city = req.headers['x-vercel-ip-city'] || 'Unknown';
        try { city = decodeURIComponent(city); } catch (e) {}

        // 2. 【防爬虫 V3.1 VPN友好版】
        const botKeywords = [
            'bot', 'spider', 'crawl', 
            'facebook', 'meta', 'whatsapp', 'preview', 
            'google', 'twitter', 'slack', 'ahrefs', 'pinterest', 
            'python', 'curl', 'wget'
        ];
        const isNamedBot = botKeywords.some(keyword => uaLower.includes(keyword));
        const isMetaFingerprint = ua.includes('Android 10; K'); // Meta 爬虫特征

        if (isNamedBot || isMetaFingerprint) {
            console.log(`🛡️ 拦截爬虫 | UA: ${ua.substring(0, 30)}...`);
            return res.status(200).send({ success: true, skipped: true });
        }

        // 3. 准备数据
        const visitorIP = req.headers['x-forwarded-for'] 
            ? req.headers['x-forwarded-for'].split(',')[0] 
            : req.ip;

        const bjTime = getBeijingTime();

        if (!supabase) return res.status(200).send({ success: false });

        // 4. 写入数据库 (新增了 language 字段)
        const { error } = await supabase
            .from('wa_logs')
            .insert({
                phone_number: logData.phoneNumber,
                redirect_time: bjTime,
                ip: visitorIP,
                country: country,
                city: city,
                user_agent: ua,
                language: logData.language || 'unknown' // 【核心新增】写入语言
            });

        if (error) throw error;

        res.status(200).send({ success: true });

    } catch (error) {
        console.error('SERVER_ERROR:', error.message);
        res.status(200).send({ success: false });
    }
});

// 查看日志页面 (增加语言列显示)
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
        <style>
            body{font-family:sans-serif;padding:20px;font-size:13px;}
            table{width:100%;border-collapse:collapse;}
            th,td{border:1px solid #ddd;padding:8px;text-align:left;}
            tr:nth-child(even){background:#f9f9f9;}
        </style></head><body>
        <h2>User Logs</h2>
        <table>
            <tr>
                <th>Time (BJ)</th>
                <th>Lang</th> <!-- 新增 -->
                <th>Loc</th>
                <th>WA</th>
                <th>IP</th>
            </tr>
        ${logs.map(log => `
            <tr>
                <td>${log.redirect_time}</td>
                <td>${log.language || '-'}</td> <!-- 显示语言 -->
                <td>${log.country}/${log.city}</td>
                <td>${log.phone_number}</td>
                <td>${log.ip}</td>
            </tr>`).join('')}
        </table></body></html>`;
        res.send(html);
    } catch (error) {
        res.status(500).send(error.message);
    }
});

module.exports = app;
