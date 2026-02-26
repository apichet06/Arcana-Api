
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as category from "./category.service.js";



export const list = asyncHandler(async (_req, res) => {
    const data = await category.listCategorys();
    res.status(200).json({ data });
});

export const create = asyncHandler(async (req, res) => {
    const { cl_name } = req.body

    const data = await category.createCategory({
        e_id: 1,
        ctl_id: 1,
        cl_name
    });
    res.status(201).json({ data });
});

