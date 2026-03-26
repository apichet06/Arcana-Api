import { Router } from 'express';
import * as productStockController from './procuct-addstock.controller.js';
import { Auth } from '../../shared/middlewares/auth.js';


export const productStockRouter = Router();

productStockRouter.use(Auth);
productStockRouter.get('/:st_id/:log_code', productStockController.list);
productStockRouter.post('/add-stock', productStockController.addStock);
productStockRouter.put('/reduce-stock', productStockController.reduceStock);
productStockRouter.get('/inventory-log/:st_id/:inv_id', productStockController.ListInventoryLog);