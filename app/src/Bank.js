import { config } from './config.js';

// Stand-in for the real bank / card network.
//
// Like real payment providers, it is idempotent by reference: charging the same reference
// twice gives the same result and never a second debit. That property is what makes it safe
// for the recovery job to re-drive a payment that got stuck after a crash.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} reference    unique per payment (we use the session id)
 * @param {number} amountCents  integer cents
 * @returns {Promise<{approved: boolean, bankReference: string|null, declineReason: string|null}>}
 */
export async function charge(reference, amountCents) {
  await sleep(config.bank.latencyMs); // simulated network + processing time

  if (amountCents > config.bank.declineOver * 100) {
    return { approved: false, bankReference: null, declineReason: 'AMOUNT_LIMIT_EXCEEDED' };
  }
  return {
    approved: true,
    bankReference: `BANK-${reference.slice(0, 8).toUpperCase()}`,
    declineReason: null,
  };
}