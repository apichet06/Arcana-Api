export function extractImageSrcsFromLexical(jsonString: string): string[] {
    try {
        const data = JSON.parse(jsonString);
        const images: string[] = [];

        function walk(node: any) {
            if (!node) return;

            if (node.type === "image" && typeof node.src === "string") {
                images.push(node.src);
            }

            if (Array.isArray(node.children)) {
                node.children.forEach(walk);
            }
        }

        walk(data.root);
        return images;
    } catch (error) {
        console.error("extractImageSrcsFromLexical error:", error);
        return [];
    }
}