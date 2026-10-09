import { z } from "zod";
import type { DropKind, DropRecord, ProviderId } from "./types";

const metaSchema = z.object({
  v: z.literal(1),
  app: z.literal("droprevive"),
  id: z.string().min(1),
  kind: z.enum(["text", "file"]),
  createdAt: z.string().min(1),
  deviceId: z.string(),
  deviceName: z.string(),
  text: z.string().optional(),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().nonnegative(),
  blobId: z.string().optional(),
  blobName: z.string().optional(),
});

export type DropMeta = z.infer<typeof metaSchema>;

export function parseMeta(text: string): DropMeta | null {
  try {
    const parsed = metaSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function buildMeta(input: {
  id: string;
  kind: DropKind;
  createdAt: string;
  deviceId: string;
  deviceName: string;
  text?: string;
  fileName?: string;
  mimeType?: string;
  size: number;
  blobId?: string;
  blobName?: string;
}): DropMeta {
  return {
    v: 1,
    app: "droprevive",
    id: input.id,
    kind: input.kind,
    createdAt: input.createdAt,
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    size: input.size,
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.fileName ? { fileName: input.fileName } : {}),
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    ...(input.blobId ? { blobId: input.blobId } : {}),
    ...(input.blobName ? { blobName: input.blobName } : {}),
  };
}

export function recordFromMeta(
  meta: DropMeta,
  provider: ProviderId,
  metaId: string,
  rev: string,
): DropRecord {
  return {
    id: meta.id,
    kind: meta.kind,
    createdAt: meta.createdAt,
    deviceId: meta.deviceId,
    deviceName: meta.deviceName || "",
    text: meta.text,
    fileName: meta.fileName,
    mimeType: meta.mimeType,
    size: meta.size,
    refs: [
      {
        provider,
        metaId,
        metaName: `d_${meta.id}.json`,
        ...(meta.blobId ? { blobId: meta.blobId } : {}),
      },
    ],
    revs: { [provider]: rev },
  };
}

export type DateFilter = "all" | "1" | "7" | "30";
export type KindFilter = "all" | DropKind;

export function filterItems(
  items: DropRecord[],
  query: {
    text: string;
    kind: KindFilter;
    provider: "all" | ProviderId;
    date: DateFilter;
    now?: number;
  },
): DropRecord[] {
  const needle = query.text.trim().toLowerCase();
  const now = query.now ?? Date.now();
  const maxAge = query.date === "all" ? Number.POSITIVE_INFINITY : Number(query.date) * 86_400_000;
  return items
    .filter((item) => {
      if (query.kind !== "all" && item.kind !== query.kind) return false;
      if (query.provider !== "all" && !item.refs.some((ref) => ref.provider === query.provider)) {
        return false;
      }
      const created = Date.parse(item.createdAt);
      if (Number.isFinite(created) && now - created > maxAge) return false;
      if (!needle) return true;
      const hay = [item.text, item.fileName, item.deviceName, item.createdAt, item.id]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      return hay.includes(needle);
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}
