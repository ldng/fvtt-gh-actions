import { readdirSync, mkdirSync, readFileSync } from "fs";
import { join, extname } from "path";
import { load } from "js-yaml";
import { ClassicLevel } from 'classic-level';

/**
 * A flattened view of the Document hierarchy. The type of the value determines what type of collection it is. Arrays
 * represent embedded collections, while objects represent embedded documents.
 * @type {Record<string, Record<string, object|Array>>}
 */
const HIERARCHY = {
  actors: {
    items: [],
    effects: []
  },
  cards: {
    cards: []
  },
  combats: {
    combatants: []
  },
  delta: {
    items: [],
    effects: []
  },
  items: {
    effects: []
  },
  journal: {
    pages: []
  },
  playlists: {
    sounds: []
  },
  regions: {
    behaviors: []
  },
  tables: {
    results: []
  },
  tokens: {
    delta: {}
  },
  scenes: {
    drawings: [],
    tokens: [],
    lights: [],
    notes: [],
    regions: [],
    sounds: [],
    templates: [],
    tiles: [],
    walls: []
  }
};

/* -------------------------------------------- */

/**
 * Locate all source files in the given directory.
 * @param {string} root  The root directory to search in.
 * @param {Partial<CompileOptions>} [options]
 * @returns {string[]}
 */
function findSourceFiles(root, { recursive = false } = {}) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const name = join(root, entry.name);
    if (entry.isDirectory() && recursive) {
      files.push(...findSourceFiles(name, { yaml, recursive }));
      continue;
    }
    if (!entry.isFile()) continue;
    files.push(name);
  }
  return files;
}

/* -------------------------------------------- */

/**
 * Wrap a function so that it can be applied recursively to a Document's hierarchy.
 * @param {HierarchyApplyCallback} fn  The function to wrap.
 * @returns {HierarchyApplyCallback}   The wrapped function.
 */
function applyHierarchy(fn) {
  const apply = async (doc, collection, options = {}) => {
    const newOptions = await fn(doc, collection, options);
    for (const [embeddedCollectionName, type] of Object.entries(HIERARCHY[collection] ?? {})) {
      const embeddedValue = doc[embeddedCollectionName];
      if (Array.isArray(type) && Array.isArray(embeddedValue)) {
        for (const embeddedDoc of embeddedValue) await apply(embeddedDoc, embeddedCollectionName, newOptions);
      }
      else if (embeddedValue) await apply(embeddedValue, embeddedCollectionName, newOptions);
    }
  };
  return apply;
}

/* -------------------------------------------- */

/**
 * Transform a Document's embedded collections by applying a function to them.
 * @param {object} doc               The Document being operated on.
 * @param {string} collection        The Document's collection.
 * @param {HierarchyMapCallback} fn  The function to invoke.
 */
async function mapHierarchy(doc, collection, fn) {
  for (const [embeddedCollectionName, type] of Object.entries(HIERARCHY[collection] ?? {})) {
    const embeddedValue = doc[embeddedCollectionName];
    if (Array.isArray(type)) {
      if (Array.isArray(embeddedValue)) {
        doc[embeddedCollectionName] = await Promise.all(embeddedValue.map(entry => {
          return fn(entry, embeddedCollectionName);
        }));
      }
      else doc[embeddedCollectionName] = [];
    } else {
      if (embeddedValue) doc[embeddedCollectionName] = await fn(embeddedValue, embeddedCollectionName);
      else doc[embeddedCollectionName] = null;
    }
  }
}

/* -------------------------------------------- */

/**
 * Flushes the log of the given database to create compressed binary tables.
 * @param {ClassicLevel} db The database to compress.
 * @returns {Promise<void>}
 */
async function compactClassicLevel(db) {
  const forwardIterator = db.keys({ limit: 1, fillCache: false });
  const firstKey = await forwardIterator.next();
  await forwardIterator.close();

  const backwardIterator = db.keys({ limit: 1, reverse: true, fillCache: false });
  const lastKey = await backwardIterator.next();
  await backwardIterator.close();

  if (firstKey && lastKey) return db.compactRange(firstKey, lastKey, { keyEncoding: "utf8" });
}

/* -------------------------------------------- */

/**
 * Compile a set of files into a LevelDB compendium pack.
 * @param {string} pack  The target compendium pack.
 * @param {string[]} files  The source files.
 * @param {Partial<PackageOptions>} [options]
 * @returns {Promise<void>}
 */
async function compileClassicLevel(pack, files, { log, transformEntry } = {}) {
  // Create the classic level directory if it doesn't already exist.
  mkdirSync(pack, { recursive: true });

  // Load the directory as a ClassicLevel DB.
  const db = new ClassicLevel(pack, { keyEncoding: "utf8", valueEncoding: "json" });
  const batch = db.batch();
  const seenKeys = new Set();

  const packDoc = applyHierarchy(async (doc, collection) => {
    const key = doc._key;
    delete doc._key;
    if (seenKeys.has(key)) {
      throw new Error(`An entry with key '${key}' was already packed and would be overwritten by this entry.`);
    }
    seenKeys.add(key);
    const value = structuredClone(doc);
    await mapHierarchy(value, collection, d => d._id);
    batch.put(key, value);
  });

  // Iterate over all files in the input directory, writing them to the DB.
  for (const file of files) {
    try {
      const contents = readFileSync(file, "utf8");
      const ext = extname(file);
      const isYaml = ext === ".yml" || ext === ".yaml";
      const doc = isYaml ? load(contents) : JSON.parse(contents);
      const [, collection] = doc._key.split("!");
      if (await transformEntry?.(doc) === false) continue;
      await packDoc(doc, collection);
      if (log) console.log(`Packed ${doc._id}${doc.name}`);
    } catch (err) {
      if (log) console.error(`Failed to pack ${file}. See error below.`);
      throw err;
    }
  }

  // Remove any entries in the DB that are not part of the source set.
  for (const key of await db.keys().all()) {
    if (!seenKeys.has(key)) {
      batch.del(key);
      if (log) console.log(`Removed ${key}`);
    }
  }

  await batch.write();
  await compactClassicLevel(db);
  await db.close();
}

/* -------------------------------------------- */
/*  Compiling                                   */
/* -------------------------------------------- */

/**
 * Compile source files into a compendium pack.
 * @param {string} src   The directory containing the source files.
 * @param {string} dest  The target the directory for compendium pack.
 * @param {CompileOptions} [options]
 * @returns {Promise<void>}
 */
export async function compilePack(src, dest, {
  yaml = false, recursive = false, log = false, transformEntry
} = {}) {
  const files = findSourceFiles(src, { yaml, recursive });
  return compileClassicLevel(dest, files, { log, transformEntry });
}

