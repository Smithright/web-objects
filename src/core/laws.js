// Laws and agent behavior — capability-secured computation.
//
//   capabilities {
//     read:  nearby.transforms, local.weather, self.inventory
//     write: self.intent, self.memory
//     emit:  speech, movement_request, trade_offer
//     deny:  filesystem, raw_network, arbitrary_database
//     budget: { cpu_ms: 2, memory_mb: 32, events: 64 }
//   }
//
// Behavior never touches the world directly. It receives a view assembled from
// exactly the capabilities it declared, and returns intents the runtime is free
// to reject. In the reference C/Rust implementation this boundary is a
// WebAssembly component instantiated by Wasmtime; here it is a JavaScript
// closure over a capability-checked host object. The security model is the
// same: no ambient authority, explicit grants, metered budgets, revocable at
// any tick.

export class CapabilityError extends Error {
  constructor(path, kind) {
    super(`capability denied: ${kind} "${path}"`);
    this.name = 'CapabilityError';
    this.path = path;
    this.kind = kind;
  }
}

export class BudgetError extends Error {
  constructor(resource, limit) {
    super(`budget exhausted: ${resource} > ${limit}`);
    this.name = 'BudgetError';
    this.resource = resource;
    this.limit = limit;
  }
}

const DEFAULT_BUDGET = { ops: 256, events: 64, memory_mb: 32, cpu_ms: 2 };

export class Capabilities {
  constructor({ read = [], write = [], emit = [], deny = [], budget = {} } = {}) {
    this.read = read;
    this.write = write;
    this.emit = emit;
    this.deny = deny;
    this.budget = { ...DEFAULT_BUDGET, ...budget };
  }

  static grantsPath(list, path) {
    return list.some((granted) => granted === path || (granted.endsWith('.*') && path.startsWith(granted.slice(0, -1))));
  }

  check(kind, path) {
    if (Capabilities.grantsPath(this.deny, path)) throw new CapabilityError(path, kind);
    const list = kind === 'read' ? this.read : kind === 'write' ? this.write : this.emit;
    if (!Capabilities.grantsPath(list, path)) throw new CapabilityError(path, kind);
  }

  describe() {
    return {
      read: this.read,
      write: this.write,
      emit: this.emit,
      deny: this.deny,
      budget: this.budget,
    };
  }
}

/** One metered invocation of a law. Discarded after `run` returns. */
class LawView {
  constructor(law, subject, providers, ctx) {
    this.law = law;
    this.subject = subject;
    this._providers = providers;
    this._ctx = ctx;
    this._cache = new Map();
    this.ops = 0;
    this.intents = {};
    this.emissions = [];
    this.tick = ctx.tick;
    this.rng = ctx.rng;
  }

  _charge() {
    if (++this.ops > this.law.capabilities.budget.ops) {
      throw new BudgetError('ops', this.law.capabilities.budget.ops);
    }
  }

  read(path) {
    this._charge();
    this.law.capabilities.check('read', path);
    if (this._cache.has(path)) return this._cache.get(path);
    const provider = this._providers[path];
    if (!provider) throw new CapabilityError(path, 'read');
    const value = provider(this.subject, this._ctx);
    this._cache.set(path, value);
    return value;
  }

  write(path, value) {
    this._charge();
    this.law.capabilities.check('write', path);
    this.intents[path] = value;
    return value;
  }

  emit(kind, payload = {}) {
    this._charge();
    this.law.capabilities.check('emit', kind);
    if (this.emissions.length >= this.law.capabilities.budget.events) {
      throw new BudgetError('events', this.law.capabilities.budget.events);
    }
    this.emissions.push({ kind, payload });
    return true;
  }
}

export class Law {
  constructor({ name, version = 1, capabilities, run, deterministic = true }) {
    this.name = name;
    this.version = version;
    this.capabilities = capabilities instanceof Capabilities ? capabilities : new Capabilities(capabilities);
    this.run = run;
    this.deterministic = deterministic;
    this.stats = { invocations: 0, violations: 0, budgetFaults: 0, ops: 0 };
  }
}

/**
 * The host that instantiates laws and enforces their grants.
 *
 * `providers` maps a capability path to a function that materializes that slice
 * of the world for one subject. A path with no provider is simply unreachable —
 * denial is the default, not an exception path.
 */
export class LawHost {
  constructor(providers = {}) {
    this.providers = providers;
    this.laws = new Map();
    this.violations = [];
  }

  provide(path, fn) {
    this.providers[path] = fn;
    return this;
  }

  register(desc) {
    const law = desc instanceof Law ? desc : new Law(desc);
    this.laws.set(law.name, law);
    return law;
  }

  get(name) {
    const law = this.laws.get(name);
    if (!law) throw new Error(`unknown law "${name}"`);
    return law;
  }

  /**
   * Invoke a law for one subject. Faults are contained: a law that oversteps
   * loses its turn, not the tick. The runtime keeps simulating.
   */
  invoke(name, subject, ctx) {
    const law = this.get(name);
    const view = new LawView(law, subject, this.providers, ctx);
    law.stats.invocations++;
    try {
      law.run(view);
      law.stats.ops += view.ops;
      return { ok: true, intents: view.intents, emissions: view.emissions, ops: view.ops };
    } catch (error) {
      if (error instanceof CapabilityError) law.stats.violations++;
      else if (error instanceof BudgetError) law.stats.budgetFaults++;
      else throw error;
      const fault = { law: law.name, subject, tick: ctx.tick, error: error.message };
      this.violations.push(fault);
      if (this.violations.length > 128) this.violations.shift();
      return { ok: false, intents: {}, emissions: [], ops: view.ops, fault };
    }
  }

  describe() {
    return [...this.laws.values()].map((law) => ({
      name: law.name,
      version: law.version,
      capabilities: law.capabilities.describe(),
      stats: { ...law.stats },
    }));
  }
}
