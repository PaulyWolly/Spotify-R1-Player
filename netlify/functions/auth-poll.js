const { connectLambda, getStore } = require('@netlify/blobs');

const BLOB_REGION = process.env.AWS_REGION || 'us-east-1';

function openAuthStore(event) {
  connectLambda(event);
  return getStore({ name: 'spotify-auth', region: BLOB_REGION });
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  const session = String((event.queryStringParameters && event.queryStringParameters.session) || '')
    .replace(/\D/g, '');

  if (session.length !== 6) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ pending: true }) };
  }

  try {
    const store = openAuthStore(event);
    const raw = await store.get(session);
    if (!raw) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ pending: true }) };
    }

    // Do not delete — R1 may need several polls; entry expires via store TTL metadata.
    const tokens = JSON.parse(raw);
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, tokens }) };
  } catch (e) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: e.message || 'Poll failed' })
    };
  }
};
