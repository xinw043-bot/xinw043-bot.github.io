const express = require('express');
const bodyParser = require('body-parser');
const app = express();

app.use(bodyParser.json());

// 跨域处理（重要：确保 github.io 访问不被拦截）
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

app.post('/api/log', (req, res) => {
    try {
        const logData = req.body;
        
        // 1. 获取真实 IP (Vercel 专用)
        const visitorIP = req.headers['x-forwarded-for'] 
            ? req.headers['x-forwarded-for'].split(',')[0] 
            : req.ip;

        // 2. 构造详细日志对象
        const fullLog = {
            EVENT: "WA_JUMP",
            timestamp: new Date().toISOString(),
            targetWA: logData.phoneNumber,
            ip: visitorIP,
            userAgent: req.get('User-Agent'),
            clientTime: logData.redirectTime
        };

        // 3. 【核心修复】将日志打印到 Vercel 后台
        // 在 Vercel 的 "Logs" 选项卡里，你会看到这一串 JSON
        console.log("LOG_START");
        console.log(JSON.stringify(fullLog, null, 2));
        console.log("LOG_END");

        res.status(200).send({ success: true });
    } catch (error) {
        console.error('SERVER_ERROR:', error);
        res.status(500).send({ success: false });
    }
});

// 注意：这个页面在 Vercel 下依然会因为重启而清空，仅建议看 Vercel 后台 Logs
app.get('/api/logs', (req, res) => {
    res.send('Vercel 云函数不持久化内存。请前往 Vercel 控制台项目的 "Logs" 选项卡查看实时详细日志。');
});

module.exports = app;
