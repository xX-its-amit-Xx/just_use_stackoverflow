import { createHmac } from 'node:crypto';

const sleep = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  t.unref?.();
});

export function signBody(secret, body) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

// Delivers a signed JSON payload with up to 3 attempts. Updates `delivery` in place.
// `status` is the last HTTP status code received (null if none); `lastError` describes failures.
export async function deliver({ url, secret, body, delivery, onChange }) {
  const signature = signBody(secret, body);
  for (let attempt = 1; attempt <= 3; attempt++) {
    delivery.attempts = attempt;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pm-signature': signature,
          'x-pm-event': delivery.event,
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      delivery.status = res.status;
      await res.arrayBuffer().catch(() => {});
      if (res.ok) {
        delivery.lastError = null;
        onChange?.();
        return;
      }
      delivery.lastError = `HTTP ${res.status}`;
    } catch (err) {
      delivery.lastError = err?.message || String(err);
    }
    onChange?.();
    if (attempt < 3) await sleep(100 * attempt);
  }
}
