// providerRegistry.js — DATA-003: provider resolution.
//
// The single place that maps a provider key to an adapter. Product code asks
// the registry, never imports an adapter directly, so adding or swapping a
// provider touches this file only.

const { assertImplementsContract } = require("./providerContract");
const thesportsdb = require("./theSportsDbDomainAdapter");
const sportmonks = require("./sportmonksAdapter");

const ADAPTERS = new Map();

function register(adapter) {
  assertImplementsContract(adapter);
  ADAPTERS.set(adapter.key, adapter);
  return adapter;
}

register(thesportsdb);
register(sportmonks);

// Fail loudly and explicitly. Silently falling back to a default provider
// would be exactly the kind of implicit coupling this layer exists to remove.
function resolveProvider(key) {
  const adapter = ADAPTERS.get(key);
  if (!adapter) {
    throw new Error(`Unknown sports data provider: ${JSON.stringify(key)}. Registered: ${[...ADAPTERS.keys()].join(", ")}`);
  }
  return adapter;
}

function listProviders() { return [...ADAPTERS.keys()]; }

module.exports = { register, resolveProvider, listProviders };
