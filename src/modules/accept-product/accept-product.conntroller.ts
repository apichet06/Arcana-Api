import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as acceptProductService from "./accept-product.service.js";
import type { AccepetProduct } from "./accept-product.type.js";


export const updateAccpeptProduct = asyncHandler(async (req, res) => {
    const { p_id } = req.params;
    const { p_isAccept, reason } = req.body;
    const empId = Number(req.empId);
    const p_isAcceptDate = new Date();

    const data = { p_isAccept, reason, p_isAcceptBy: empId, p_isAcceptDate }

    const resulte = await acceptProductService.AcceptProduct(Number(p_id), data as AccepetProduct);
    res.status(200).json({ data: resulte });
})

export const countAcceptProduct = asyncHandler(async (req, res) => {
    const resulte = await acceptProductService.CountAcceptProduct();
    res.status(200).json({ data: resulte });

})