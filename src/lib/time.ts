import { env } from '../config/env';
import { badRequest } from './errors';

const TZ = env.BUSINESS_TIMEZONE;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "yyyy-MM-dd" del día de negocio (hora Colombia), no del servidor. */
export function businessDateKey(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function tzOffset(date: Date): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value;
  const match = part?.match(/GMT([+-]\d{2}:\d{2})/);
  return match?.[1] ?? '+00:00';
}

function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Instante UTC en que empieza el día de negocio indicado. */
export function startOfBusinessDay(dateKey: string): Date {
  if (!DATE_KEY_RE.test(dateKey)) throw badRequest(`Fecha inválida: ${dateKey}. Usa yyyy-MM-dd`);
  const probe = new Date(`${dateKey}T12:00:00Z`);
  return new Date(`${dateKey}T00:00:00${tzOffset(probe)}`);
}

/**
 * Rango [gte, lt) para filtrar por días de negocio, ambos inclusive.
 * Sin parámetros devuelve el día de hoy.
 */
export function businessRange(from?: string, to?: string): { gte: Date; lt: Date; from: string; to: string } {
  const f = from ?? businessDateKey();
  const t = to ?? f;
  if (t < f) throw badRequest('La fecha "to" no puede ser anterior a "from"');
  return { gte: startOfBusinessDay(f), lt: startOfBusinessDay(addDays(t, 1)), from: f, to: t };
}

export { DATE_KEY_RE };
