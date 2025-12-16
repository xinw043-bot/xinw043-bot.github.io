const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(bodyParser.json());

// --- Supabase 初始化 ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
let supabase = null;

if (supabaseUrl && supabaseKey) {
    try {
        supabase = createClient(supabaseUrl, supabaseKey);
    } catch (e) {
        console.error("❌ Supabase 初始化失败:", e.message);
    }
}

// --- 工具函数：获取北京时间 ---
function getBeijingTime() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).replace(/\//g, '-'); 
}

// 跨域设置
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

app.post('/api/log', async (req, res) => {
    try {
        const logData = req.body;
        
        // 1. 获取 IP
        const visitorIP = req.headers['x-forwarded-for'] 
            ? req.headers['x-forwarded-for'].split(',')[0] 
            : req.ip;

        // 2. 【新增】获取地理位置 (Vercel 提供的魔法 Header)
        // Vercel 会自动帮我们把 IP 翻译成国家代码 (如 CN, US) 和城市名
        const country = req.headers['x-vercel-ip-country'] || 'Unknown';
        
        // 城市名有时候会经过编码，建议解码一下
        let city = req.headers['x-vercel-ip-city'] || 'Unknown';
        try { city = decodeURIComponent(city); } catch (e) {}

        // 3. 获取北京时间
        const bjTime = getBeijingTime();

        console.log(`[New Log] IP:${visitorIP} Loc:${country}/${city} Time:${bjTime}`);

        if (!supabase) {
            return res.status(200).send({ success: false, msg: "DB Config Error" });
        }

        // 4. 写入数据库 (增加了 country 和 city 字段)
        const { error } = await supabase
            .from('wa_logs')
            .insert({
                phone_number: logData.phoneNumber,
                redirect_time: bjTime,     // 北京时间
                ip: visitorIP,
                country: country,          // 国家代码 (例如 CN)
                city: city,                // 城市 (例如 Shanghai)
                user_agent: req.get('User-Agent')
            });

        if (error) throw error;

        res.status(200).send({ success: true });

    } catch (error) {
        console.error('SERVER_ERROR:', error.message);
        // 即使写入失败，也返回成功，避免前端报错
        res.status(200).send({ success: false });
    }
});

// 查看日志页面 (增加了地理位置显示)
app.get('/api/logs', async (req, res) => {
    if (!supabase) return res.send('Supabase 未配置');
    if (req.query.pwd !== '123456') return res.send('🔒 密码错误');

    try {
        const { data: logs, error } = await supabase
            .from('wa_logs')
            .select('*')
            .order('id', { ascending: false })
            .limit(50);

        if (error) throw error;
        
        let html = `
        <html><head><meta charset="UTF-8"><title>数据监控</title>
        <style>
            body{font-family:sans-serif;padding:20px;background:#f5f5f5;}
            table{width:100%;border-collapse:collapse;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.1);}
            th,td{border:1px solid #eee;padding:10px;text-align:left;font-size:14px;}
            th{background:#0070f3;color:white;}
            tr:nth-child(even){background:#f9f9f9;}
        </style>
        </head><body>
        <h2>跳转日志 (UTC+8)</h2>
        <table>
            <tr>
                <th>北京时间</th>
                <th>位置</th> <!-- 新增 -->
                <th>WA账号</th>
                <th>IP</th>
            </tr>
        ${logs.map(log => `
            <tr>
                <td>${log.redirect_time}</td>
                <td>${log.country || '-'} / ${log.city || '-'}</td> <!-- 显示位置 -->
                <td>${log.phone_number}</td>
                <td>${log.ip}</td>
            </tr>
        `).join('')}
        </table></body></html>`;
        
        res.send(html);
    } catch (error) {
        res.status(500).send(error.message);
    }
});

module.exports = app;
