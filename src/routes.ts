import { Router } from 'express';
import { authenticate, requireRole } from './middlewares/auth';
import { authRouter } from './modules/auth/auth.routes';
import { inventoryRouter } from './modules/inventory/inventory.routes';
import { productsRouter } from './modules/products/products.routes';
import { reportsRouter } from './modules/reports/reports.routes';
import { salesRouter } from './modules/sales/sales.routes';
import { shiftsRouter } from './modules/shifts/shifts.routes';
import { tablesRouter } from './modules/tables/tables.routes';
import { usersRouter } from './modules/users/users.routes';

export const apiRouter = Router();

// Público
apiRouter.use('/auth', authRouter);

// Todo lo de abajo requiere token
apiRouter.use(authenticate);
apiRouter.use('/users', requireRole('OWNER'), usersRouter);
apiRouter.use('/products', productsRouter);
apiRouter.use('/inventory', inventoryRouter);
apiRouter.use('/tables', tablesRouter);
apiRouter.use('/sales', salesRouter);
apiRouter.use('/shifts', shiftsRouter);
apiRouter.use('/reports', requireRole('OWNER'), reportsRouter);
