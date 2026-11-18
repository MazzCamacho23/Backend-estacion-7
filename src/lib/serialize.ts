import { Prisma } from '@prisma/client';

/**
 * Convierte tipos que JSON no maneja bien a valores que Android pueda leer
 * como números: Prisma.Decimal -> number, BigInt (de consultas SQL) -> number.
 */
export function toPlain<T = unknown>(value: T): T {
  return convert(value) as T;
}

function convert(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number(value);
  if (Prisma.Decimal.isDecimal(value)) return (value as Prisma.Decimal).toNumber();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(convert);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = convert(v);
    return out;
  }
  return value;
}
