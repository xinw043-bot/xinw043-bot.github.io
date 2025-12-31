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
        console.log("✅ Supabase 客户端初始化成功");
    } catch (e) {
        console.error("❌ Supabase 初始化失败:", e.message);
    }
}

// --- 工具函数：获取北京时间 ---
function getBeijingTime() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }).replace(/\//g, '-'); 
}

// --- 跨域配置 (允许 GitHub Pages 和 Shopify 访问) ---
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// ==========================================
// 接口 1: 检查 IP 历史 (实现全域号码锁定)
// ==========================================
app.get('/api/check-phone', async (req, res) => {
    try {
        if (!supabase) return res.json({ found: false });

        // 获取真实 IP
        const visitorIP = req.headers['x-forwarded-for'] 
            ? req.headers['x-forwarded-for'].split(',')[0] 
            : req.ip;

        // 策略：为了保证跨平台一致性，我们需要先后查询两张表
        
        // 1. 先查 wa_logs (GitHub 中间页历史)
        const { data: waData, error: waError } = await supabase
            .from('wa_logs')
            .select('phone_number')
            .eq('ip', visitorIP)
            .order('id', { ascending: false }) // 取最新的一条
            .limit(1);

        if (!waError && waData && waData.length > 0 && waData[0].phone_number) {
            console.log(`[查重] IP ${visitorIP} 在 wa_logs 发现旧号码: ${waData[0].phone_number}`);
            return res.json({ found: true, phone: waData[0].phone_number });
        }

        // 2. 如果没找到，再查 website_logs (Shopify 官网历史)
        const { data: webData, error: webError } = await supabase
            .from('website_logs')
            .select('phone_number')
            .eq('ip', visitorIP)
            .order('id', { ascending: false })
            .limit(1);

        if (!webError && webData && webData.length > 0 && webData[0].phone_number) {
            console.log(`[查重] IP ${visitorIP} 在 website_logs 发现旧号码: ${webData[0].phone_number}`);
            return res.json({ found: true, phone: webData[0].phone_number });
        }

        // 3. 两边都没来过，这是纯新客
        return res.json({ found: false });

    } catch (error) {
        console.error('Check IP Error:', error.message);
        res.json({ found: false }); // 出错放行，避免阻塞
    }
});

// ==========================================
// 接口 2: 记录日志 (分流存储)
// ==========================================
app.post('/api/log', async (req, res) => {
    try {
        const logData = req.body;
        const ua = req.get('User-Agent') || '';
        const uaLower = ua.toLowerCase();
        
        // --- 1. 决定存入哪张表 ---
        // 如果前端带了 is_website: true (Shopify)，存 website_logs
        // 否则 (GitHub 中间页)，存 wa_logs
        const tableName = logData.is_website ? 'website_logs' : 'wa_logs';

        // --- 2. 爬虫拦截 (V3.1 VPN 友好版) ---
        // 允许 VPN/数据中心 IP，但拦截明确的爬虫 UA
        const botKeywords = [
            'bot', 'spider', 'crawl', 
            'facebook', 'meta', 'whatsapp', 'preview', 
            'google', 'twitter', 'slack', 'ahrefs', 'pinterest', 'python'
        ];
        const isNamedBot = botKeywords.some(keyword => uaLower.includes(keyword));
        const isMetaFingerprint = ua.includes('Android 10; K'); // Meta 爬虫特征

        if (isNamedBot || isMetaFingerprint) {
            console.log(`🛡️ 拦截爬虫 | Table: ${tableName} | UA: ${ua.substring(0, 30)}...`);
            return res.status(200).send({ success: true, skipped: true });
        }

        // --- 3. 获取地理位置与时间 ---
        const country = req.headers['x-vercel-ip-country'] || 'Unknown';
        let city = req.headers['x-vercel-ip-city'] || 'Unknown';
        try { city = decodeURIComponent(city); } catch (e) {}
        
        const visitorIP = req.headers['x-forwarded-for'] 
            ? req.headers['x-forwarded-for'].split(',')[0] 
            : req.ip;
            
        const bjTime = getBeijingTime();

        if (!supabase) return res.status(200).send({ success: false, msg: "DB Config Missing" });

        // --- 4. 执行写入 ---
        console.log(`[写入] Table: ${tableName} | IP: ${visitorIP} | Phone: ${logData.phoneNumber}`);
        
        const { error } = await supabase
            .from(tableName) // 动态选择表名
            .insert({
                phone_number: logData.phoneNumber,
                redirect_time: bjTime,
                ip: visitorIP,
                country: country,
                city: city,
                user_agent: ua,
                language: logData.language || 'unknown',
                inquiry_id: logData.inquiryId || 'N/A',
                referrer_url: logData.referrerUrl || 'Direct/Unknown'
            });

        if (error) throw error;

        res.status(200).send({ success: true });

    } catch (error) {
        console.error('SERVER_ERROR:', error.message);
        // 即使报错也返回 200，避免前端 JS 报错影响用户体验
        res.status(200).send({ success: false });
    }
});

// ==========================================
// 接口 3: 后台查看 (支持切换表格)
// ==========================================
app.get('/api/logs', async (req, res) => {
    if (!supabase) return res.send('Config Error');
    if (req.query.pwd !== '123456') return res.send('🔒 Password Error');

    // 通过 ?table=website 参数切换查看 website_logs
    const tableName = req.query.table === 'website' ? 'website_logs' : 'wa_logs';

    try {
        const { data: logs, error } = await supabase
            .from(tableName)
            .select('*')
            .order('id', { ascending: false })
            .limit(50);

        if (error) throw error;
        
        // 返回 JSON 数据方便查看
        res.json({
            current_table: tableName,
            count: logs.length,
            logs: logs
        });
    } catch (error) {
        res.status(500).send(error.message);
    }
});

module.exports = app;
