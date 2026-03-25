import fs from "node:fs/promises";
import path from "node:path";

export async function deleteVariantImage(imagePath?: string | null) {
    if (!imagePath) return;

    const normalizedPath = imagePath.replace(/\\/g, "/").replace(/^\/+/, "");

    if (!normalizedPath.startsWith("uploads/variants/")) {
        return;
    }

    try {
        const fullPath = path.join(process.cwd(), "public", normalizedPath);
        await fs.unlink(fullPath);
    } catch (error: any) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }
}


export async function removePhysicalFile(filePath: string) {
    try {
        const normalized = filePath.replace(/\\/g, "/");
        const fullPath = path.join(process.cwd(), "public", normalized);

        await fs.unlink(fullPath); // ลบเลย

    } catch (error: any) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }
}