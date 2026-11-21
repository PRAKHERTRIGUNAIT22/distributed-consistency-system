import { z } from 'zod';
import { ApiError } from './error.js';

// Amount: positive, at most 2 decimal places, capped well under Number's safe-integer range
// once converted to cents (so toCents() in money.js never overflows).
const amount = z.number().positive().max(10_000_000).multipleOf(0.01, {
  message: 'amount must have at most 2 decimal places',
});
const currency = z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO code, e.g. INR');

export const createSessionSchema = z.object({
  amount,
  currency: currency.optional(),
});

export const paySchema = z.object({
  amount,
  currency,
  payerRef: z.string().min(1).max(64),
});

/** Wraps a zod schema as Express middleware: on success, req.body is replaced with the parsed value. */
export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const detail = result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
      return next(new ApiError(400, 'VALIDATION_ERROR', detail));
    }
    req.body = result.data;
    next();
  };
}

const uuidSchema = z.string().uuid();

export function validateUuidParam(name) {
  return (req, res, next) => {
    if (!uuidSchema.safeParse(req.params[name]).success) {
      return next(new ApiError(400, 'VALIDATION_ERROR', `${name} must be a UUID`));
    }
    next();
  };
}