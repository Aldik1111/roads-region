// Isolated fake-callback regression for LocationProvider. Run from frontend with:
//   npm run test:gps
// This executes the real TSX provider via esbuild, with React/browser callbacks stubbed;
// it does not open or control the shared browser and never fabricates a location.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require(process.cwd() + '/node_modules/esbuild');

const providerSource = fs.readFileSync('src/geolocation.tsx', 'utf8');
const providerCode = esbuild.transformSync(providerSource, { loader: 'tsx', format: 'cjs', target: 'node18' }).code;
let hookState = [];
let hookIndex = 0;
let effects = [];
let visibilityHandler;
let now = Date.now();
let nextTimerId = 1;
let activeWatches = 0;
let resolvePermission;
let mutationGuard;
const intervals = new Map();
const timeouts = new Map();
const watches = [];
const oneShots = [];
const permission = { state: 'granted', onchange: null };

const React = {
  createContext: value => ({ value, Provider: {} }),
  useState(initial) {
    const index = hookIndex++;
    if (!(index in hookState)) hookState[index] = typeof initial === 'function' ? initial() : initial;
    return [hookState[index], value => { hookState[index] = typeof value === 'function' ? value(hookState[index]) : value; }];
  },
  useRef(initial) {
    const index = hookIndex++;
    if (!(index in hookState)) hookState[index] = { current: initial };
    return hookState[index];
  },
  useCallback(fn) { hookIndex++; return fn; },
  useMemo(fn) { hookIndex++; return fn(); },
  useEffect(fn) { hookIndex++; effects.push(fn); },
  createElement(type, props) { return { type, props }; },
};
const jsxRuntime = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
const moduleUnderTest = { exports: {} };
new Function('require', 'module', 'exports', 'React', providerCode)(
  name => name === 'react' ? React : name === 'react/jsx-runtime' ? jsxRuntime : name === './api' ? { setMutationGuard: guard => { mutationGuard = guard; } } : require(name),
  moduleUnderTest,
  moduleUnderTest.exports,
  React,
);

global.document = {
  visibilityState: 'visible',
  addEventListener(type, callback) { if (type === 'visibilitychange') visibilityHandler = callback; },
  removeEventListener() {},
};
global.window = {
  isSecureContext: true,
  setInterval(callback, ms) { const id = nextTimerId++; intervals.set(id, { callback, ms }); return id; },
  clearInterval(id) { intervals.delete(id); },
  setTimeout(callback, ms) { const id = nextTimerId++; timeouts.set(id, { callback, ms }); return id; },
  clearTimeout(id) { timeouts.delete(id); },
};
Object.defineProperty(global, 'navigator', {
  configurable: true,
  value: {
    platform: 'Win32',
    userAgent: 'Windows',
    geolocation: {
      watchPosition(success, error, options) { activeWatches++; watches.push({ success, error, options }); return watches.length; },
      clearWatch() { activeWatches--; },
      getCurrentPosition(success, error, options) { oneShots.push({ success, error, options, activeWatches }); },
    },
    permissions: { query: () => new Promise(resolve => { resolvePermission = resolve; }) },
  },
});
Date.now = () => now;

function renderProvider() {
  hookIndex = 0;
  effects = [];
  return moduleUnderTest.exports.LocationProvider({ children: null, requireGps: true });
}
function tickExpiry() {
  const timer = [...intervals.values()].find(value => value.ms === 1000);
  assert.ok(timer, 'one-second freshness timer should be active');
  timer.callback();
}
function pass(condition, message) { assert.ok(condition, message); }

async function run() {
  let tree = renderProvider();
  let providerCleanup = effects[0]();
  effects[1]();
  assert.equal(watches.length, 1, 'start exactly one initial watch');
  assert.equal(watches[0].options.enableHighAccuracy, false, 'use real browser low-accuracy acquisition for desktop compatibility');
  assert.equal(oneShots.length, 0, 'do not concurrently poll getCurrentPosition');
  watches[0].error({ code: 3 });
  tree = renderProvider();
  assert.equal(tree.props.value.ready, false, 'initial transient failure without an earlier fix must not grant recovery access');
  assert.equal(tree.props.value.status, 'unavailable');
  assert.equal(tree.props.value.hasFreshPosition, false);
  assert.match(mutationGuard(), /GPS-позици/, 'mutation guard blocks work before the first fix');

  watches[0].error({ code: 1 });
  resolvePermission(permission);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(watches.length, 2, 'a late granted permission gets one fresh acquisition attempt');

  watches[1].error({ code: 1 });
  tree = renderProvider();
  assert.equal(tree.props.value.ready, false, 'code 1 without a position cannot bypass the GPS requirement');
  assert.match(tree.props.value.error, /Разрешение сайта в браузере выдано/);
  assert.equal(timeouts.size, 0, 'granted page permission plus provider denial must not auto-retry forever');

  permission.state = 'prompt';
  permission.onchange?.(new Event('change'));
  assert.equal(watches.length, 3, 'permission state changes restart acquisition');
  watches[2].error({ code: 3 });
  let recovery = [...timeouts.entries()].find(([, value]) => value.ms === 8000);
  assert.ok(recovery, 'timeout schedules recovery');
  timeouts.delete(recovery[0]);
  recovery[1].callback();
  assert.equal(watches.length, 4, 'timeout recovery starts one replacement watch');

  watches[3].success({ timestamp: now, coords: { latitude: 44.8, longitude: 65.5, accuracy: 45 } });
  tree = renderProvider();
  assert.equal(tree.props.value.ready, true, 'a real browser position makes the provider ready');
  assert.equal(mutationGuard(), null, 'fresh position allows inspector mutations');

  now += 20_000;
  tickExpiry();
  assert.equal(oneShots.length, 1, 'a stationary fix gets a sequential refresh before expiry');
  assert.equal(oneShots[0].activeWatches, 0, 'the one-shot refresh runs after watchPosition is stopped');
  assert.deepEqual(oneShots[0].options, { enableHighAccuracy: false, maximumAge: 0, timeout: 8000 });
  oneShots[0].success({ timestamp: now, coords: { latitude: 44.8, longitude: 65.5, accuracy: 45 } });
  const stationaryTimestamp = now;
  assert.equal(activeWatches, 1, 'a watch resumes after the one-shot refresh completes');
  tree = renderProvider();
  assert.equal(tree.props.value.ready, true);

  global.document.visibilityState = 'hidden';
  visibilityHandler();
  tree = renderProvider();
  assert.equal(tree.props.value.ready, true, 'hidden visibility alone must preserve a fresh fix for native file pickers');
  assert.equal(activeWatches, 0, 'the background GPS watch pauses while hidden');
  global.document.visibilityState = 'visible';
  visibilityHandler();
  now += 30_001;
  tickExpiry();
  tree = renderProvider();
  assert.equal(tree.props.value.ready, true, 'a previously acquired fix gets bounded recovery access after expiry');
  assert.equal(tree.props.value.hasFreshPosition, false, 'stale coordinates are never exposed as a live position');
  assert.equal(tree.props.value.position, null, 'position must be null during grace');
  assert.equal(tree.props.value.status, 'reconnecting');
  assert.equal(tree.props.value.recoveryRemainingSeconds, 60, 'age-based grace ends at fix timestamp + 30s + 60s');
  assert.equal(tree.props.value.showRecoveryNotice, false, 'the first 15 seconds of recovery stay quiet');
  assert.equal(mutationGuard(), null, 'bounded recovery allows workspace mutations');
  pass([...timeouts.values()].some(value => value.ms === 8000), 'expiry schedules watch recovery while visible');

  tree.props.value.retry();
  providerCleanup();
  tree = renderProvider();
  providerCleanup = effects[0]();
  resolvePermission(permission);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(tree.props.value.ready, true, 'manual retry preserves bounded recovery access');
  assert.equal(tree.props.value.recoveryRemainingSeconds, 60, 'manual retry does not reset the original deadline');
  watches.at(-1).success({ timestamp: stationaryTimestamp, coords: { latitude: 44.8, longitude: 65.5, accuracy: 45 } });
  tree = renderProvider();
  assert.equal(tree.props.value.hasFreshPosition, false, 'a repeated cached timestamp does not restore live-position status');
  assert.equal(tree.props.value.position, null);
  assert.equal(tree.props.value.recoveryRemainingSeconds, 60, 'a cached timestamp does not clear the existing recovery window');

  now += 15_000;
  tickExpiry();
  tree = renderProvider();
  assert.equal(tree.props.value.recoveryRemainingSeconds, 45);
  assert.equal(tree.props.value.showRecoveryNotice, true, 'recovery notice appears after 15 seconds');
  const staleFixDeadline = tree.props.value.recoveryRemainingSeconds;
  watches.at(-1).error({ code: 2 });
  tree = renderProvider();
  assert.equal(tree.props.value.recoveryRemainingSeconds, staleFixDeadline, 'repeated transient errors do not extend age-based grace');

  now += 45_000;
  tickExpiry();
  tree = renderProvider();
  assert.equal(tree.props.value.ready, false, 'recovery expires at the absolute age-based deadline, even after suspended time');
  assert.equal(tree.props.value.status, 'unavailable', 'expired recovery remains retryable instead of showing an endless loading state');
  assert.equal(tree.props.value.recoveryRemainingSeconds, 0);
  assert.match(mutationGuard(), /GPS-позици/, 'expired recovery blocks further mutations');
  watches.at(-1).success({ timestamp: now, coords: { latitude: 44.9, longitude: 65.6, accuracy: 40 } });
  tree = renderProvider();
  assert.equal(tree.props.value.hasFreshPosition, true, 'a genuinely fresh position restores live GPS readiness');
  assert.equal(tree.props.value.recoveryRemainingSeconds, 0, 'fresh position clears recovery deadline');

  watches.at(-1).error({ code: 1 });
  tree = renderProvider();
  assert.equal(tree.props.value.ready, true, 'host code 1 after a fresh fix starts bounded recovery when page permission is not denied');
  assert.equal(tree.props.value.hasFreshPosition, false);
  assert.equal(tree.props.value.position, null);
  const firstErrorRemaining = tree.props.value.recoveryRemainingSeconds;
  const errorRecovery = [...timeouts.entries()].find(([, value]) => value.ms === 8000);
  assert.ok(errorRecovery, 'host code 1 after a prior fix schedules automatic recovery');
  timeouts.delete(errorRecovery[0]);
  errorRecovery[1].callback();
  const watchCountAfterRecovery = watches.length;
  now += 10_000;
  watches.at(-1).error({ code: 2 });
  tickExpiry();
  tree = renderProvider();
  assert.equal(tree.props.value.recoveryRemainingSeconds, firstErrorRemaining - 10, 'later errors do not reset error-based grace');
  assert.equal(watches.length, watchCountAfterRecovery, 'transient callback does not create parallel GPS watches');

  global.document.visibilityState = 'hidden';
  visibilityHandler();
  now += 51_000;
  global.document.visibilityState = 'visible';
  visibilityHandler();
  tree = renderProvider();
  assert.equal(tree.props.value.ready, false, 'elapsed hidden time cannot restore expired recovery access');
  assert.equal(tree.props.value.recoveryRemainingSeconds, 0);
  assert.equal(tree.props.value.status, 'unavailable');
  watches.at(-1).success({ timestamp: now, coords: { latitude: 45, longitude: 65.7, accuracy: 35 } });
  tree = renderProvider();
  assert.equal(tree.props.value.hasFreshPosition, true, 'a newer real fix after hidden expiry restores access');

  permission.state = 'denied';
  permission.onchange?.(new Event('change'));
  tree = renderProvider();
  assert.equal(tree.props.value.ready, false, 'explicit page-permission loss clears readiness immediately');
  assert.equal(tree.props.value.position, null, 'permission denial clears retained coordinates immediately');
  assert.equal(tree.props.value.status, 'unavailable');
  assert.equal(tree.props.value.recoveryRemainingSeconds, 0, 'permission denial removes any grace period');
  assert.match(mutationGuard(), /GPS-позици/, 'explicit denial blocks mutations immediately');

  console.log(JSON.stringify({
    passed: true,
    checks: ['low-accuracy browser watch', 'late permission grant retry', 'granted/provider code-1 diagnostic', 'timeout recovery', 'sequential stationary refresh', 'hidden fresh fix retention', 'no-fix initial failure gate', '15-second notice delay', '60-second age-based grace', 'mutation guard during grace', 'manual retry preserves deadline', 'cached timestamp does not restore live status', 'repeated errors do not extend grace', '60-second error-based grace', 'fresh-fix recovery', 'hidden elapsed time expires grace', 'permission-loss immediate clear'],
    activeWatchCount: activeWatches,
    oneShotRefreshCount: oneShots.length,
  }, null, 2));
}

run().catch(error => { console.error(error); process.exitCode = 1; });
