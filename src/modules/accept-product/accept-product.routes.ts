import { Auth } from '../../shared/middlewares/auth.js'
import * as controller from './accept-product.conntroller.js'
import { Router } from 'express'



export const acceptProductRouter = Router()
acceptProductRouter.use(Auth)
acceptProductRouter.put('/:p_id', controller.updateAccpeptProduct)
acceptProductRouter.get('/count', controller.countAcceptProduct)