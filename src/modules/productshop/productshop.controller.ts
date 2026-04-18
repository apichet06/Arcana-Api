import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as productShopService from "./productshop.service.js";

export const listProductShop = asyncHandler(async (req, res) => {
    const { lg_code } = req.params;

    const keyword = String(req.query.keyword ?? "").trim()
    const sort = String(req.query.sort ?? "all").trim()
    const category = String(req.query.category ?? "").trim()
    const page = Number(req.query.page ?? 1)
    const limit = Number(req.query.limit ?? 12)


    const data = await productShopService.getProductShop({
        lg_code: lg_code as string,
        keyword,
        sort,
        page,
        category,
        limit,
    });
    res.status(200).json({ data });
});

export const getProductShopById = asyncHandler(async (req, res) => {
    const { p_id } = req.params;
    const lg_code = req.params.lg_code as string || "th"; // Default to 'th' if not provided
    const data = await productShopService.getProductShopById(Number(p_id), lg_code);
    res.status(200).json({ data });
});

export const getProductShopByStId = asyncHandler(async (req, res) => {
    const { st_id } = req.params;
    const lg_code = req.params.lg_code as string || "th";
    const data = await productShopService.getProductShopByStId(Number(st_id), lg_code);
    res.status(200).json({ data });

})