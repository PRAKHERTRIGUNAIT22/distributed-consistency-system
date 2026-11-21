

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

const created201 = new Counter('created_201');
const replayed200 = new Counter('replayed_200');
const inFlight409 = new Counter('in_flight_409');
const unexpected = new Counter('unexpected_status');

export const options = {
  scenarios: {
    hundred_concurrent: {
      executor: 'shared-iterations',
      vus: 100,
      iterations: 100, 
      maxDuration: '30s',
    },
  },
  thresholds: {
    created_201: ['count==1'],      
    unexpected_status: ['count==0'],
  },
};


export function setup() {
  const res = http.post(
    `${BASE_URL}/payment-sessions`,
    JSON.stringify({ amount: 500.0, currency: 'INR' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(res, { 'session created (201)': (r) => r.status === 201 });
  const sessionId = res.json('sessionId');
  console.log(`Shared session: ${sessionId}`);
  return { sessionId };
}

export default function (data) {
  const payload = JSON.stringify({ amount: 500.0, currency: 'INR', payerRef: 'load-test-user' });
  const res = http.post(`${BASE_URL}/pay/${data.sessionId}`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (res.status === 201) created201.add(1);
  else if (res.status === 200) replayed200.add(1);
  else if (res.status === 409) inFlight409.add(1);
  else unexpected.add(1);

  check(res, {
    'status is 201, 200 or 409': (r) => [200, 201, 409].includes(r.status),
  });
}

export function teardown(data) {
  console.log(`
Done. Now verify in Postgres (source of truth):
  docker exec -it gateway-postgres psql -U gateway -d gateway \\
    -c "SELECT count(*) FROM payments WHERE idempotency_key = '${data.sessionId}';"
Expect exactly 1.
`);
}