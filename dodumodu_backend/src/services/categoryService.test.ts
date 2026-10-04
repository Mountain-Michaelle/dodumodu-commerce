import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../db";
import { categoriesRepo, type CategoryRow, type CategoryUsage } from "../data/categoriesRepo";
import { productsRepo } from "../data/productsRepo";
import { categoryService } from "./categoryService";
import { ConflictError, NotFoundError, ValidationError } from "../shared/httpError";

/* The rules that protect the catalogue's shape. Each one is a case where getting
   it wrong silently damages data - a category deleted while products point at it,
   or a tree that can no longer be walked to render. The repos are stubbed in
   place, so the real rules run with no database involved. */

const db = {} as Db;

let byId: Map<number, CategoryRow>;
let usage: CategoryUsage;
let productsInCategory: { id: number; name: string; slug: string }[];
let slugsTaken: Set<string>;
let namesTaken: Set<string>;
let ancestorChains: Map<number, CategoryRow[]>;
let inserted: unknown[];
let deletedIds: number[];

function category(over: Partial<CategoryRow> = {}): CategoryRow {
  return {
    id: 1,
    parentId: null,
    name: "Skin Cares",
    slug: "skin-cares",
    description: null,
    mediaR2Key: "",
    isActive: true,
    sortOrder: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  } as CategoryRow;
}

function stub() {
  categoriesRepo.findById = async (_db, id) => byId.get(id) ?? null;
  categoriesRepo.slugTaken = async (_db, slug) => slugsTaken.has(slug);
  categoriesRepo.nameTaken = async (_db, name) => namesTaken.has(name);
  categoriesRepo.usageFor = async () => usage;
  categoriesRepo.ancestors = async (_db, id) => ancestorChains.get(id) ?? [];
  categoriesRepo.insert = async (_db, input) => {
    inserted.push(input);
    return category({ id: 99, ...(input as object) });
  };
  categoriesRepo.update = async (_db, id, patch) => category({ id, ...(patch as object) });
  categoriesRepo.deleteById = async (_db, id) => { deletedIds.push(id); byId.delete(id); return true; };
  categoriesRepo.listAll = async () => [...byId.values()];
  productsRepo.listForCategory = async () => productsInCategory;
}
stub();

beforeEach(() => {
  byId = new Map([[1, category()]]);
  usage = { childCount: 0, productCount: 0, canDelete: true };
  productsInCategory = [];
  slugsTaken = new Set();
  namesTaken = new Set();
  ancestorChains = new Map();
  inserted = [];
  deletedIds = [];
  stub();
});

test("a valid category is created with a trimmed name and slug", async () => {
  const created = await categoryService.create(db, { name: "  Skin Cares ", slug: "  Skin-Cares " });
  assert.equal(created.name, "Skin Cares");
  // The slug is lowercased on the way in, so "Skin-Cares" and "skin-cares" cannot
  // both end up as two URLs for one category.
  assert.equal(created.slug, "skin-cares");
  assert.equal(inserted.length, 1);
});

test("a slug that is not URL-shaped is refused with a field note", async () => {
  await assert.rejects(
    () => categoryService.create(db, { name: "Skin Cares", slug: "Skin Cares!" }),
    (err: unknown) => err instanceof ValidationError
      && /slug/.test(JSON.stringify((err as ValidationError).fields ?? {})),
  );
  assert.equal(inserted.length, 0);
});

test("a name longer than the column allows is refused", async () => {
  await assert.rejects(
    () => categoryService.create(db, { name: "x".repeat(121), slug: "ok" }),
    (err: unknown) => err instanceof ValidationError,
  );
});

test("a duplicate slug is a conflict, not a crash", async () => {
  slugsTaken.add("skin-cares");
  await assert.rejects(
    () => categoryService.create(db, { name: "Serums", slug: "skin-cares" }),
    (err: unknown) => err instanceof ConflictError,
  );
});

test("a category cannot be its own parent", async () => {
  await assert.rejects(
    () => categoryService.update(db, 1, { name: "X", slug: "x", parentId: 1 }, null),
    (err: unknown) => err instanceof ValidationError,
  );
});

test("a category cannot be moved under its own descendant", async () => {
  // A CHECK constraint cannot compare rows, so the save-time guard has to walk.
  // Without it, moving a parent under a child produces a tree no renderer can
  // finish walking.
  byId.set(2, category({ id: 2, name: "Serums", slug: "serums", parentId: 1 }));
  ancestorChains.set(1, [category({ id: 2, name: "Serums", slug: "serums" })]);

  await assert.rejects(
    () => categoryService.update(db, 1, { name: "Skin Cares", slug: "skin-cares", parentId: 2 }, null),
    (err: unknown) => err instanceof ValidationError,
  );
});

test("a category with products is not deleted, and the count is named", async () => {
  usage = { childCount: 0, productCount: 2, canDelete: false };
  productsInCategory = [
    { id: 7, name: "Glow Serum", slug: "glow-serum" },
    { id: 8, name: "Night Cream", slug: "night-cream" },
  ];
  await assert.rejects(
    () => categoryService.remove(db, 1),
    // "2 products still use this category" is a reason; "cannot delete" alone is
    // just an obstacle, so the panel can show which products to move.
    (err: unknown) => err instanceof ConflictError && /2 products/.test((err as Error).message),
  );
  assert.deepEqual(deletedIds, []);
});

test("a category with children is not deleted either", async () => {
  // products.category_id is ON DELETE SET NULL, so the database would re-parent
  // those children to the root and quietly reshape the catalogue.
  usage = { childCount: 1, productCount: 0, canDelete: false };
  await assert.rejects(
    () => categoryService.remove(db, 1),
    (err: unknown) => err instanceof ConflictError,
  );
  assert.deepEqual(deletedIds, []);
});

test("an empty category is deleted", async () => {
  await categoryService.remove(db, 1);
  assert.deepEqual(deletedIds, [1]);
});

test("a missing category is a 404", async () => {
  byId.clear();
  await assert.rejects(
    () => categoryService.remove(db, 42),
    (err: unknown) => err instanceof NotFoundError,
  );
});

test("the tree is built from one read, nesting children under parents", async () => {
  byId.set(1, category({ id: 1, name: "Skin Cares", slug: "skin-cares" }));
  byId.set(2, category({ id: 2, name: "Serums", slug: "serums", parentId: 1 }));
  byId.set(3, category({ id: 3, name: "Creams", slug: "creams", parentId: 2 }));

  const tree = await categoryService.tree(db);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, "Skin Cares");
  assert.equal(tree[0].children.length, 1);
  assert.equal(tree[0].children[0].name, "Serums");
  assert.equal(tree[0].children[0].children[0].name, "Creams");
});

test("a corrupt cycle is truncated rather than followed forever", async () => {
  // A cycle that got past the save-time check is data that already disagrees with
  // itself. Stopping is honest; spinning is not.
  byId = new Map([
    [1, category({ id: 1, name: "A", slug: "a", parentId: 2 })],
    [2, category({ id: 2, name: "B", slug: "b", parentId: 1 })],
  ]);
  const tree = await categoryService.tree(db);
  // Neither A nor B is a root, so nothing is returned - and, crucially, nothing hangs.
  assert.deepEqual(tree, []);
});
