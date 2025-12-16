const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(bodyParser.json());

// --- 核心修改：安全初始化 Supabase ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
let supabase = null;

// 检查变量是否存在，防止启动崩溃
if (supabaseUrl && supabaseKey) {
    try {
        supabase = createClient(supabaseUrl, supabaseKey);
        console.log("✅ Supabase 客户端初始化成功");
    } catch (e) {
        console.error("❌ Supabase 初始化失败:", e.message);
    }
} else {
    console.error("⚠️ 警告：未检测到环境变量 SUPABASE_URL 或 SUPABASE_KEY。数据库功能将不可用。");
}
// -----------------------------------

// 跨域处理（保留原样）
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

app.post('/api/log', async (req, res) => {
    try {
        const logData = req.body;
        
        // 获取 IP
        const visitorIP = req.headers['x-forwarded-for'] 
            ? req.headers['x-forwarded-for'].split(',')[0] 
            : req.ip;

        console.log(`[收到请求] IP: ${visitorIP}, WA: ${logData.phoneNumber}`);

        // 检查数据库是否这就绪
        if (!supabase) {
            console.error("❌ 无法写入：Supabase 未配置");
            // 这里返回 200 是为了不让前端报错，但在后台打印错误
            return res.status(200).send({ success: false, msg: "Server Config Error" });
        }

        // 写入数据库
        const { error } = await supabase
            .from('wa_logs')
            .insert({
                phone_number: logData.phoneNumber,
                redirect_time: logData.redirectTime,
                ip: visitorIP,
                user_agent: req.get('User-Agent')
            });

        if (error) {
            throw error;
        }

        console.log("✅ 数据成功写入 Supabase");
        res.status(200).send({ success: true });

    } catch (error) {
        console.error('SERVER_ERROR:', error.message);
        // 即使出错也返回 200，避免前端阻塞
        res.status(200).send({ success: false });
    }
});

// 查看日志页面
app.get('/api/logs', async (req, res) => {
    if (!supabase) {
        return res.send('❌ 错误：Supabase 环境变量未配置，无法读取数据。请检查 Vercel 设置。');
    }
    
    // 简单密码验证
    if (req.query.pwd !== '123456') return res.send('🔒 密码错误');

    try {
        const { data: logs, error } = await supabase
            .from('wa_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) throw error;
        
        // 简单渲染
        res.json(logs); // 直接返回 JSON 数据方便查看
    } catch (error) {
        res.status(500).send('读取失败: ' + error.message);
    }
});

module.exports = app;
