import * as deepl from "deepl-node";
import { EN, JA, translator } from "./translate.client.js";

export async function translateProductFields(
    texts: string[]
): Promise<{ th: string[]; en: string[]; ja: string[] }> {
    const cleanTexts = texts.map((text) => (text ?? "").trim());

    if (cleanTexts.every((text) => !text)) {
        return {
            th: cleanTexts,
            en: cleanTexts.map(() => ""),
            ja: cleanTexts.map(() => ""),
        };
    }

    const options: deepl.TranslateTextOptions = {
        context: `
      Product fields for a professional e-commerce platform.
      The business includes:
      1) Premium curated health and lifestyle products.
      2) Industrial factory goods including:
      - Die casting molds
      - Metal molds
      - Bolts, nuts, screws
      - Engine components
      - Machine parts and tools
      Use correct industrial and technical terminology.
      Keep wording concise and natural for e-commerce.
    `,
        preserveFormatting: true,
    };

    const [enRes, jaRes] = await Promise.all([
        translator.translateText(cleanTexts, null, EN, options),
        translator.translateText(cleanTexts, null, JA, options),
    ]);

    return {
        th: cleanTexts,
        en: enRes.map((r: any) => r.text),
        ja: jaRes.map((r: any) => r.text),
    };
}