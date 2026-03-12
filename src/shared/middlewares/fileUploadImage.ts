import fs from "fs";
import path from "path";

export async function fileUploadImage(file: any, keys: string, folder: string) {
    const currentDate = new Date();
    const year = currentDate.getFullYear();
    const month = String(currentDate.getMonth() + 1).padStart(2, "0");
    // const day = String(currentDate.getDate()).padStart(2, "0");
    const uploadPath = `uploads/${folder}/${year}/${month}`;
    const folderPatch = path.join(process.cwd(), "public", uploadPath);
    const fileName = `${keys}${path.extname(file.originalname)}`;
    const filePath = path.join(folderPatch, fileName);
    fs.mkdirSync(folderPatch, { recursive: true });
    fs.renameSync(file.path, filePath);

    return `${uploadPath}/${fileName}`;
}