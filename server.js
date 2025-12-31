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

// ==========================================
// 接口 1: 全局 IP 查重 (核心升级)
// ==========================================
app.get('/api/check-phone', async (req, res) => {
    try {
        if (!supabase) return res.json({ found: false });

        const visitorIP = req.headers['x-forwarded-for'] 
            ? req.headers['x-forwarded-for'].split(',')[0] 
            : req.ip;

        // 优先级 1: 查 Telegram 记录 (tg_logs)
        // 如果他以前点过 TG，优先保持 TG 号码一致
        const { data: tgData } = await supabase
            .from('tg_logs')
            .select('phone_number')
            .eq('ip', visitorIP)
            .order('id', { ascending: false }).limit(1);

        if (tgData && tgData.length > 0 && tgData[0].phone_number) {
            console.log(`[锁定] IP ${visitorIP} 命中 TG 历史: ${tgData[0].phone_number}`);
            return res.json({ found: true, phone: tgData[0].phone_number, source: 'tg' });
        }

        // 优先级 2: 查 官网 WhatsApp 记录 (website_logs)
        // 如果没点过 TG，但点过官网 WA，让他去加这个 WA 号码对应的 TG
        const { data: webData } = await supabase
            .from('website_logs')
            .select('phone_number')
            .eq('ip', visitorIP)
            .order('id', { ascending: false }).limit(1);

        if (webData && webData.length > 0 && webData[0].phone_number) {
            console.log(`[锁定] IP ${visitorIP} 命中 Website WA 历史: ${webData[0].phone_number}`);
            return res.json({ found: true, phone: webData[0].phone_number, source: 'website' });
        }

        // 优先级 3: 查 中间页 WhatsApp 记录 (wa_logs)
        const { data: waData } = await supabase
            .from('wa_logs')
            .select('phone_number')
            .eq('ip', visitorIP)
            .order('id', { ascending: false }).limit(1);

        if (waData && waData.length > 0 && waData[0].phone_number) {
            console.log(`[锁定] IP ${visitorIP} 命中 Landing WA 历史: ${waData[0].phone_number}`);
            return res.json({ found: true, phone: waData[0].phone_number, source: 'landing' });
        }

        // 纯新客
        return res.json({ found: false });

    } catch (error) {
        console.error('Check IP Error:', error.message);
        res.json({ found: false });
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
        
        // 1. 决定存入哪张表
        let tableName = 'wa_logs'; // 默认
        if (logData.is_telegram) tableName = 'tg_logs';
        else if (logData.is_website) tableName = 'website_logs';

        // 2. 爬虫拦截
        const botKeywords = ['bot', 'spider', 'crawl', 'facebook', 'meta', 'whatsapp', 'preview', 'google', 'twitter', 'slack', 'python'];
        const isNamedBot = botKeywords.some(keyword => uaLower.includes(keyword));
        const isMetaFingerprint = ua.includes('Android 10; K');

        if (isNamedBot || isMetaFingerprint) {
            return res.status(200).send({ success: true, skipped: true });
        }

        // 3. 准备数据
        const country = req.headers['x-vercel-ip-country'] || 'Unknown';
        let city = req.headers['x-vercel-ip-city'] || 'Unknown';
        try { city = decodeURIComponent(city); } catch (e) {}
        const visitorIP = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.ip;
        const bjTime = getBeijingTime();

        if (!supabase) return res.status(200).send({ success: false });

        // 4. 写入
        const { error } = await supabase
            .from(tableName)
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
        res.status(200).send({ success: false });
    }
});

// 接口 3: 查看日志 (保留)
app.get('/api/logs', async (req, res) => {
    if (!supabase) return res.send('Config Error');
    if (req.query.pwd !== '123456') return res.send('🔒 Password Error');
    let tableName = 'wa_logs';
    if (req.query.table === 'website') tableName = 'website_logs';
    if (req.query.table === 'tg') tableName = 'tg_logs';
    try {
        const { data: logs, error } = await supabase.from(tableName).select('*').order('id', { ascending: false }).limit(50);
        if (error) throw error;
        res.json(logs);
    } catch (error) { res.status(500).send(error.message); }
});

module.exports = app;
