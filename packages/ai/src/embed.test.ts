import { expect, test } from "vitest";
import { createCloudAssistant } from "./assistant.cloud";
import { createLocalAssistant } from "./assistant.local";
import { STUB_EMBED_DIM, STUB_EMBED_MODEL, stubEmbed } from "./embed";

test("stubEmbed is deterministic, fixed-dimension, and model-tagged", () => {
  const a = stubEmbed("hello world");
  const b = stubEmbed("hello world");
  expect(a.model).toBe(STUB_EMBED_MODEL);
  expect(a.vector).toHaveLength(STUB_EMBED_DIM);
  expect(a.vector).toEqual(b.vector);
  expect(a.vector.every((value) => Number.isFinite(value))).toBe(true);
  // Different text → different vector.
  expect(stubEmbed("other").vector).not.toEqual(a.vector);
});

test("both AI seam targets expose embed and return a model-tagged vector", async () => {
  const local = createLocalAssistant();
  const cloud = createCloudAssistant();
  const localEmbed = await local.embed("doc text");
  const cloudEmbed = await cloud.embed("doc text");
  expect(localEmbed.model).toBe(STUB_EMBED_MODEL);
  expect(cloudEmbed.model).toBe(STUB_EMBED_MODEL);
  expect(localEmbed.vector).toHaveLength(STUB_EMBED_DIM);
});
