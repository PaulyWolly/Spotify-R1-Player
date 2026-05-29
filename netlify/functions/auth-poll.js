const { connectLambda, getDeployStore } = require('@netlify/blobs');

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
    connectLambda(event);
    const store = getDeployStore('spotify-auth');
    const raw = await store.get(session);
    if (!raw) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ pending: true }) };
    }

    await store.delete(session);
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
