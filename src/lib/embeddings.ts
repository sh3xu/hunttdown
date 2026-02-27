import { HfInference } from "@huggingface/inference";

type EmbeddingResult = {
  id: string;
  embedding: number[];
};

const EMBEDDING_MODEL = "unsloth/embeddinggemma-300m";
const EMBEDDING_DIM = 768;

/** Generate embeddings for a batch of code nodes */
export async function generateEmbeddings(
  items: Array<{ id: string; text: string }>,
  sendProgress?: (msg: string) => void,
): Promise<EmbeddingResult[]> {
  const token = process.env.HF_TOKEN;

  if (!token) {
    // Mock mode: produce deterministic pseudo-embeddings so the system
    console.warn(
      "[embeddings] No HF_TOKEN found — using mock embeddings.",
    );
    return items.map((item) => ({
      id: item.id,
      embedding: mockEmbedding(item.text),
    }));
  }

  const hf = new HfInference(token);
  const results: EmbeddingResult[] = [];
  const BATCH = 50; // Smaller batches for Hugging Face inference

  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    sendProgress?.(
      `Generating embeddings (${i + chunk.length}/${items.length})...`,
    );

    try {
      const out = await hf.featureExtraction({
        model: EMBEDDING_MODEL,
        provider: "hf-inference",
        inputs: chunk.map((c) => c.text.slice(0, 2048)),
      });

      // featureExtraction returns a flat or nested number array depending on batch size
      const embeddingsArray: number[][] = (Array.isArray(out[0]) ? out : [out]) as number[][];

      for (let j = 0; j < chunk.length; j++) {
        results.push({ id: chunk[j].id, embedding: embeddingsArray[j] });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Hugging Face Embeddings API error: ${message}`);
    }
  }

  return results;
}

/**
 * Build a concise text representation of a node for embedding.
 * Combines signature + docComment + first 500 chars of body.
 */
export function buildEmbeddingText(node: {
  name: string;
  type: string;
  path?: string;
  signature?: string;
  docComment?: string;
  content?: string;
}): string {
  const parts: string[] = [];
  if (node.path) parts.push(`// File: ${node.path}`);
  if (node.signature) parts.push(node.signature);
  else parts.push(`${node.type} ${node.name}`);
  if (node.docComment) parts.push(`/** ${node.docComment} */`);
  if (node.content) parts.push(node.content.slice(0, 500));
  return parts.join("\n");
}

/** Generates a deterministic pseudo-embedding for testing without an API key */
function mockEmbedding(text: string): number[] {
  const vec = new Array(EMBEDDING_DIM).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % EMBEDDING_DIM] += text.charCodeAt(i) / 10000;
  }
  // Normalize
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / mag);
}
