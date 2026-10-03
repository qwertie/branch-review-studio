import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addThread, createReview, Review } from "./review";
import { encodeBranchForFileName, ReviewStore } from "./store";
import { createTempDir } from "./test-helpers";

let tempDirs: string[] = [];
afterEach(() => {
  for (let dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function createStore(): ReviewStore {
  let gitCommonDir = createTempDir();
  tempDirs.push(gitCommonDir);
  return new ReviewStore(gitCommonDir);
}

function addSampleThread(review: Review, body: string): void {
  let anchor = { startLine: 1, endLine: 1, lineText: "x", contextBefore: [], contextAfter: [] };
  addThread(review, { file: "a.txt", side: "modified", anchor, author: { kind: "agent", name: "Claude" }, body });
}

describe("encodeBranchForFileName", () => {
  it("percent-encodes characters other than letters, digits, '.', '_' and '-'", () => {
    expect(encodeBranchForFileName("feature/2460_x-y.z ü")).toBe("feature%2F2460_x-y.z%20%C3%BC");
  });
});

describe("ReviewStore", () => {
  it("creates README.txt and a review file whose first key is a provenance $comment", async () => {
    let store = createStore();

    await store.updateReview("feature/x", () => createReview("feature/x", "origin/develop", "abc"));

    expect(fs.readFileSync(path.join(store.dir, "README.txt"), "utf8")).toMatch(/Branch Review Studio/);
    let text = fs.readFileSync(store.getReviewPath("feature/x"), "utf8");
    expect(Object.keys(JSON.parse(text))).toEqual(expect.arrayContaining(["$comment", "schemaVersion", "branch"]));
    expect(Object.keys(JSON.parse(text))[0]).toBe("$comment");
    expect(store.getReviewPath("feature/x")).toBe(path.join(store.dir, "reviews", "feature%2Fx.json"));
  });

  it("readReview returns undefined for a missing review and round-trips a saved one", async () => {
    let store = createStore();
    expect(await store.readReview("nope")).toBeUndefined();

    await store.updateReview("b", () => {
      let review = createReview("b", "develop", "abc");
      addSampleThread(review, "hello");
      return review;
    });

    let review = await store.readReview("b");
    expect(review?.threads[0].comments[0].body).toBe("hello");
    expect(review).not.toHaveProperty("$comment");
  });

  it("does not write when the mutate function returns undefined", async () => {
    let store = createStore();
    await store.updateReview("b", () => undefined);
    expect(fs.existsSync(store.getReviewPath("b"))).toBe(false);
  });

  it("serializes concurrent updates so that none are lost", async () => {
    let store = createStore();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.updateReview("b", review => {
      review ??= createReview("b", "develop", "abc");
      addSampleThread(review, `comment ${i}`);
      return review;
    })));

    let review = await store.readReview("b");
    expect(review?.threads.length).toBe(20);
    expect(fs.readdirSync(path.join(store.dir, "reviews"))).toEqual(["b.json"]);
  });

  it("breaks a stale lock file", async () => {
    let store = createStore();
    await store.updateReview("b", () => createReview("b", "develop", "abc"));
    let lockPath = store.getReviewPath("b") + ".lock";
    fs.writeFileSync(lockPath, "stale");
    let past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, past, past);

    await store.updateReview("b", review => review && { ...review, summary: "after stale lock" });

    expect((await store.readReview("b"))?.summary).toBe("after stale lock");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("strips `origin/` from a stored base branch (as version 0.2.0 wrote it)", async () => {
    let store = createStore();
    await store.ensureExists();
    let oldReview = { ...createReview("b", "develop", "abc"), baseBranch: "origin/develop" };
    fs.writeFileSync(store.getReviewPath("b"), JSON.stringify(oldReview));
    expect((await store.readReview("b"))?.baseBranch).toBe("develop");
  });

  it("refuses to read a review written by a newer schema version", async () => {
    let store = createStore();
    await store.ensureExists();
    let futureReview = { ...createReview("b", "develop", "abc"), schemaVersion: 999 };
    fs.writeFileSync(store.getReviewPath("b"), JSON.stringify(futureReview));
    await expect(store.readReview("b")).rejects.toThrow(/newer version/);
  });
});
