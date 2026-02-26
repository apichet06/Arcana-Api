import * as deepl from "deepl-node";

const authKey = process.env.DEEPL_AUTH_KEY;
if (!authKey) throw new Error("Missing DEEPL_AUTH_KEY");

const translator = new deepl.Translator(authKey, {
    // ถ้าเป็น Free key จะยิงไป api-free (บางเวอร์ชันเลือกเองอัตโนมัติ)
    serverUrl: process.env.DEEPL_IS_FREE === "true"
        ? "https://api-free.deepl.com"
        : "https://api.deepl.com",
});
const EN: deepl.TargetLanguageCode = "en-US";
const JA: deepl.TargetLanguageCode = "ja";

export async function translateCategoryName(th: string): Promise<{ th: string; en: string; ja: string }> {
    const text = (th ?? "").trim();
    if (!text) return { th: "", en: "", ja: "" };

    // context ช่วยให้คำสั้นๆ แปลแม่นขึ้น (เช่น "สุขภาพ" จะไม่หลุดความหมาย) :contentReference[oaicite:2]{index=2}
    const options: deepl.TranslateTextOptions = {
        context: `
                Category name for a professional e-commerce platform.
                The business includes:
                1) Premium curated health and lifestyle products.
                2) Industrial factory goods including:
                - Die casting molds
                - Metal molds
                - Bolts, nuts, screws
                - Engine components
                - Machine parts and tools 
                Use correct industrial and technical terminology.
                Keep it concise like a category title.
                Avoid casual or metaphorical meaning.`,
    };

    // แปล 2 ภาษา (th คืนค่าเดิม)
    const [enRes, jaRes] = await Promise.all([
        translator.translateText(text, null, EN, options),
        translator.translateText(text, null, JA, options),
    ]);

    return {
        th: text,
        en: enRes.text,
        ja: jaRes.text,
    };
}
