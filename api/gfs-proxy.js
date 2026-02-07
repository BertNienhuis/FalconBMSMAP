const DEFAULT_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With'
};

const ALLOWED_HOSTS = new Set([
    'nomads.ncep.noaa.gov',
    'nomads-beta.noaa.gov'
]);

function setCorsHeaders(res) {
    Object.entries(DEFAULT_HEADERS).forEach(([key, value]) => {
        res.setHeader(key, value);
    });
}

function parseTargetUrl(rawValue) {
    if (!rawValue) return null;
    let value = rawValue;
    try {
        value = decodeURIComponent(rawValue);
    } catch (error) {
        // ignore double decoding issues
    }
    try {
        return new URL(value);
    } catch (error) {
        return null;
    }
}

module.exports = async function handler(req, res) {
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET,HEAD,OPTIONS');
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const urlParam = req.query?.url || req.query?.target;
    const targetUrl = parseTargetUrl(urlParam);
    if (!targetUrl) {
        res.status(400).json({ error: 'Missing or invalid url parameter' });
        return;
    }
    if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
        res.status(400).json({ error: 'Requested host is not allowed' });
        return;
    }

    try {
        const upstream = await fetch(targetUrl.toString(), {
            headers: {
                'User-Agent': 'FalconBMSMAP/1.0 (+https://falcon-bmsmap.vercel.app)'
            }
        });

        const status = upstream.status;
        const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
        const cacheControl = upstream.headers.get('cache-control') || 'public, max-age=300';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', cacheControl);

        if (!upstream.ok) {
            const errorBody = await upstream.text();
            res.status(status).send(errorBody);
            return;
        }

        const arrayBuffer = await upstream.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        res.setHeader('Content-Length', buffer.length);

        if (req.method === 'HEAD') {
            res.status(200).end();
            return;
        }

        res.status(200).send(buffer);
    } catch (error) {
        console.error('GFS proxy error:', error);
        res.status(502).json({ error: 'Failed to retrieve upstream data' });
    }
}
