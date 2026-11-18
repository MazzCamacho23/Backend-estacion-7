import { z } from 'zod';
import { DATE_KEY_RE } from './time';

export const dateKeySchema = z.string().regex(DATE_KEY_RE, 'Formato de fecha esperado: yyyy-MM-dd');

export const queryBool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const dateRangeSchema = z.object({
  from: dateKeySchema.optional(),
  to: dateKeySchema.optional(),
});

/** Para sincronización incremental: "dame lo que cambió desde X". */
export const updatedSinceSchema = z.coerce.date().optional();

export const idParam = z.object({ id: z.string().min(1).max(64) });
export const uuidParam = z.object({ id: z.string().uuid() });

export function paginate(page: number, pageSize: number) {
  return { skip: (page - 1) * pageSize, take: pageSize };
}
