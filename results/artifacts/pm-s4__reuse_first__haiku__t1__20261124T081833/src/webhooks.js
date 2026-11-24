// Webhook delivery: signed JSON POST with up to 3 attempts (SPEC §7).
import crypto from 'node:crypto';

export const MAX_ATTEMPTS = 3;

export function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret ?? '').update(body).digest('hex');
}

// Mutates `delivery` ({status, attempts, lastError}) and calls onUpdate after each attempt.
export async function deliver({ url, secret, body, event, delivery, onUpdate }) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    delivery.attempts = attempt;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'pm-s4-webhook',
          'x-pm-event': event,
          'x-pm-signature': sign(secret, body),
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      await res.arrayBuffer().catch(() => {});
      delivery.status = res.status;
      delivery.lastError = res.ok ? null : `HTTP ${res.status}`;
      onUpdate?.();
      if (res.ok) return;
    } catch (err) {
      delivery.lastError = err?.message || String(err);
      onUpdate?.();
    }
  }
}
