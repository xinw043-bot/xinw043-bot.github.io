const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(bodyParser.json());

// 1. 初始化 Supabase
// (记得在 Vercel 后台配置环境变量 SUPABASE_URL 和 SUPABASE_KEY)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// 2. 跨域处理（保留你原有的设置，确保 github.io 能访问）
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// 3. POST: 接收日志并写入 Supabase
app.post('/api/log', async (req, res) => {
    try {
        const logData = req.body;
        
        // 获取真实 IP
        const visitorIP = req.headers['x-forwarded-for'] 
            ? req.headers['x-forwarded-for'].split(',')[0] 
            : req.ip;

        const userAgent = req.get('User-Agent');

        // 写入数据库
        // 注意：这里表名必须和你 Supabase 里创建的表名一致 ('wa_logs')
        const { error } = await supabase
            .from('wa_logs')
            .insert({
                phone_number: logData.phoneNumber,
                redirect_time: logData.redirectTime,
                ip: visitorIP,
                user_agent: userAgent
            });

        if (error) throw error;

        // 保留 Console log 方便在 Vercel 后台快速调试
        console.log(`[DB Success] Saved log for IP: ${visitorIP}`);

        res.status(200).send({ success: true });
    } catch (error) {
        console.error('DB_ERROR:', error.message);
        res.status(500).send({ success: false, error: error.message });
    }
});

// 4. GET: 查看日志 (带简单密码保护)
app.get('/api/logs', async (req, res) => {
    // 简单密码验证
    const password = req.query.pwd;
    if (password !== '123456') { // 你可以把 123456 改成你想设的密码
        return res.send('🔒 请输入正确的密码访问日志。例如: /api/logs?pwd=123456');
    }

    try {
        // 从 Supabase 读取最新的 50 条数据
        const { data: logs, error } = await supabase
            .from('wa_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) throw error;

        // 生成 HTML 表格
        let html = `
        <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>跳转数据监控</title>
                <style>
                    body { font-family: sans-serif; padding: 20px; background: #f4f4f9; }
                    h2 { text-align: center; color: #333; }
                    table { width: 100%; border-collapse: collapse; box-shadow: 0 2px 8px rgba(0,0,0,0.1); background: #fff; }
                    th, td { border: 1px solid #ddd; padding: 12px; text-align: left; font-size: 14px; }
                    th { background-color: #0070f3; color: white; }
                    tr:nth-child(even) { background-color: #f9f9f9; }
                    .ua { font-size: 12px; color: #666; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                </style>
            </head>
            <body>
                <h2>WhatsApp 跳转日志 (Supabase)</h2>
                <table>
                    <tr>
                        <th>时间 (UTC)</th>
                        <th>目标号码</th>
                        <th>访客 IP</th>
                        <th>设备信息 (UA)</th>
                    </tr>
                    ${logs.map(log => `
                    <tr>
                        <td>${new Date(log.created_at).toLocaleString()}</td>
                        <td>${log.phone_number}</td>
                        <td>${log.ip}</td>
                        <td class="ua" title="${log.user_agent}">${log.user_agent || '-'}</td>
                    </tr>
                    `).join('')}
                </table>
            </body>
        </html>`;
        
        res.send(html);

    } catch (error) {
        console.error('READ_ERROR:', error);
        res.status(500).send('无法读取数据库: ' + error.message);
    }
});

module.exports = app;
