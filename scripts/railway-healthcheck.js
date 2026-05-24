const { URL } = require('url');

function resolveBaseUrl() {
  const candidate =
    process.env.PUBLIC_BASE_URL ||
    process.env.APP_BASE_URL ||
    process.env.RAILWAY_PUBLIC_DOMAIN ||
    process.env.RAILWAY_STATIC_URL;

  if (!candidate) {
    throw new Error(
      'No base URL found. Set PUBLIC_BASE_URL (recommended) or APP_BASE_URL.'
    );
  }

  if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
    return candidate;
  }

  return `https://${candidate}`;
}

async function main() {
  try {
    const baseUrl = resolveBaseUrl();
    const healthUrl = new URL('/health', baseUrl).toString();

    const response = await fetch(healthUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });

    const text = await response.text();
    let payload = text;
    try {
      payload = JSON.parse(text);
    } catch {
      // Keep raw text payload when response is not JSON.
    }

    const ok = response.ok;
    console.log(
      JSON.stringify(
        {
          ok,
          status: response.status,
          url: healthUrl,
          payload
        },
        null,
        2
      )
    );

    process.exit(ok ? 0 : 1);
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error.message
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

main();
