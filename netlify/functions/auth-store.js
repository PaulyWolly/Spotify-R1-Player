const { connectLambda, getStore } = require('@netlify/blobs');

const BLOB_REGION = process.env.AWS_REGION || 'us-east-1';

function openAuthStore(event) {
  connectLambda(event);
  return getStore({ name: 'spotify-auth', region: BLOB_REGION });
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'POST only' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const session = String(body.session || '').replace(/\D/g, '');
    if (session.length !== 6) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid session code' }) };
    }
    if (!body.tokens || !body.tokens.refreshToken) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing tokens' }) };
    }

    const store = openAuthStore(event);
    await store.set(session, JSON.stringify(body.tokens), {
      metadata: { expiresAt: String(Date.now() + 10 * 60 * 1000) }
    });

    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: e.message || 'Store failed' })
    };
  }
};
