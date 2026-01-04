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

// --- 查重接口 ---
app.get('/api/check-phone', async (req, res) => {
    try {
        if (!supabase) return res.json({ found: false });
        const visitorIP = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.ip;

        // 1. 查 TG
        const { data: tgData } = await supabase.from('tg_logs').select('phone_number').eq('ip', visitorIP).order('id', { ascending: false }).limit(1);
        if (tgData && tgData.length > 0) return res.json({ found: true, phone: tgData[0].phone_number, source: 'tg' });

        // 2. 查 Website WA
        const { data: webData } = await supabase.from('website_logs').select('phone_number').eq('ip', visitorIP).order('id', { ascending: false }).limit(1);
        if (webData && webData.length > 0) return res.json({ found: true, phone: webData[0].phone_number, source: 'website' });

        // 3. 查 Landing WA
        const { data: waData } = await supabase.from('wa_logs').select('phone_number').eq('ip', visitorIP).order('id', { ascending: false }).limit(1);
        if (waData && waData.length > 0) return res.json({ found: true, phone: waData[0].phone_number, source: 'landing' });

        return res.json({ found: false });
    } catch (error) {
        res.json({ found: false });
    }
});

// --- 写入接口 (新增 note 字段支持) ---
app.post('/api/log', async (req, res) => {
    try {
        const logData = req.body;
        const ua = req.get('User-Agent') || '';
        const uaLower = ua.toLowerCase();
        
        let tableName = 'wa_logs';
        if (logData.is_telegram) tableName = 'tg_logs';
        else if (logData.is_website) tableName = 'website_logs';

        // 爬虫拦截
        const botKeywords = ['bot', 'spider', 'crawl', 'facebook', 'meta', 'whatsapp', 'preview', 'google', 'twitter', 'slack', 'python'];
        const isNamedBot = botKeywords.some(keyword => uaLower.includes(keyword));
        const isMetaFingerprint = ua.includes('Android 10; K');
        if (isNamedBot || isMetaFingerprint) return res.status(200).send({ success: true, skipped: true });

        // 数据准备
        const country = req.headers['x-vercel-ip-country'] || 'Unknown';
        let city = req.headers['x-vercel-ip-city'] || 'Unknown';
        try { city = decodeURIComponent(city); } catch (e) {}
        const visitorIP = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0] : req.ip;
        const bjTime = getBeijingTime();

        if (!supabase) return res.status(200).send({ success: false });

        // 执行写入 (加入 note 字段)
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
                referrer_url: logData.referrerUrl || 'Direct/Unknown',
                note: logData.note || '' // 【新增】写入备注
            });

        if (error) throw error;
        res.status(200).send({ success: true });

    } catch (error) {
        res.status(200).send({ success: false });
    }
});

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
