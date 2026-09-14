/**
 * partner-api: the workload every demo runs.
 *
 * Topology is configuration, not code. `loadConfig` turns the environment into a
 * validated `AppConfig`, `buildPolicies` turns that into a policy pipeline, and
 * `scopeFunction` turns a metadata field into the coordination key. Nothing else
 * in a demo changes between local, distributed, region-scoped or tenant-scoped.
 */
export {
  type WorkArgs,
  abortableDelay,
  syntheticAdapter,
} from "./adapters.js"
export {
  type AppConfig,
  type CoordinatorErrorBehaviour,
  type ScopeKind,
  type Topology,
  describeConfig,
  loadConfig,
} from "./config.js"
export {
  type CoordinationStats,
  type CoordinatorSet,
  createCoordinators,
} from "./coordinators.js"
export {
  type PolicySet,
  MissingCoordinatorError,
  buildPolicies,
} from "./policies.js"
export {
  type ScopeFunction,
  expectedScopeKeys,
  scopeFunction,
} from "./scope.js"
