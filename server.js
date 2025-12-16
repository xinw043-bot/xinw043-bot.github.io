const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const app = express();

// 解析JSON请求体
app.use(bodyParser.json());

// 临时存储日志（Vercel免费版重启会丢失，长期用可换MongoDB）
let logs = [];

// 记录跳转信息的API
app.post('/api/log', (req, res) => {
    try {
        const logData = req.body;
        // 添加新记录（含IP、UA）
        logs.push({
            ...logData,
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            timestamp: new Date().toISOString()
        });
        res.status(200).send({ success: true });
    } catch (error) {
        console.error('记录日志错误:', error);
        res.status(500).send({ success: false, error: '记录失败' });
    }
});

// 查看日志的后台页面（可加密码）
app.get('/api/logs', (req, res) => {
    // 可选：加简单密码，把 pwd=123456 换成你的密码
    const password = req.query.pwd;
    if (password !== '123456') {
        return res.send('❌ 密码错误！');
    }

    try {
        // 生成日志表格
        let html = '<html><head><meta charset="UTF-8"><title>WA跳转日志</title>';
        html += '<style>table{border-collapse:collapse;margin:20px auto;}th,td{border:1px solid #333;padding:8px;}</style></head><body>';
        html += '<h1 style="text-align:center;">WhatsApp跳转记录</h1>';
        html += '<table><tr><th>跳转时间</th><th>WA账号</th><th>访问IP</th></tr>';
        
        logs.forEach(log => {
            html += `<tr>
                <td>${new Date(log.redirectTime).toLocaleString()}</td>
                <td>${log.phoneNumber}</td>
                <td>${log.ip}</td>
            </tr>`;
        });
        
        html += '</table></body></html>';
        res.send(html);
    } catch (error) {
        res.status(500).send('❌ 查看日志失败');
    }
});

// 适配Vercel的导出规则
module.exports = app;
