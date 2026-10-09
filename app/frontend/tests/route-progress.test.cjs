const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');

const source = fs.readFileSync(path.join(__dirname, '../src/routeProgressMath.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = new Module(path.join(__dirname, 'routeProgress-under-test.cjs'), module);
loaded.filename = path.join(__dirname, 'routeProgress-under-test.cjs');
loaded.paths = module.paths;
loaded._compile(compiled, loaded.filename);
const { calculateRouteProgress } = loaded.exports;

const section = {
  id: 'r1', geometry: { coordinates: [[67, 48], [67.01, 48]] },
};
const point = (lng, recorded_at, accuracy_m = 8) => ({ lng, lat: 48, recorded_at, accuracy_m });
const inspection = points => ({ points, started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:20:00Z' });

test('matches a track on the route and estimates remaining distance', () => {
  const result = calculateRouteProgress(section, inspection([point(67, '2026-01-01T00:00:00Z'), point(67.001, '2026-01-01T00:00:30Z'), point(67.002, '2026-01-01T00:01:00Z')]), []);
  assert.equal(result.reliable, true);
  assert.ok(result.travelledKm > 0.1 && result.travelledKm < 0.2);
  assert.ok(result.remainingKm > 0.5 && result.remainingKm < 0.7);
  assert.equal(result.coveragePercent, 20);
  assert.equal(result.matchedSegments.length, 2, 'two short contiguous on-route edges are safe to color');
});

test('does not match points far from route', () => {
  const result = calculateRouteProgress(section, inspection([point(67, '2026-01-01T00:00:00Z'), { ...point(67.005, '2026-01-01T00:10:00Z'), lat: 48.01 }]), []);
  assert.equal(result.reliable, false);
  assert.equal(result.coveragePercent, null);
});

test('marks timestamp and spatial discontinuities as GPS gaps', () => {
  const result = calculateRouteProgress(section, inspection([point(67, '2026-01-01T00:00:00Z'), point(67.005, '2026-01-01T00:02:00Z'), point(67.01, '2026-01-01T00:03:00Z')]), []);
  assert.ok(result.gpsGaps >= 1);
  assert.equal(result.reliable, false);
  assert.equal(result.coveragePercent, null);
  assert.equal(result.matchedSegments.length, 0, 'gaps are never colored as traveled');
});

test('backtracking does not add route distance twice', () => {
  const result = calculateRouteProgress(section, inspection([
    point(67, '2026-01-01T00:00:00Z'),
    point(67.002, '2026-01-01T00:00:20Z'),
    point(67.004, '2026-01-01T00:00:40Z'),
    point(67.002, '2026-01-01T00:01:00Z'),
  ]), []);
  assert.ok(result.travelledKm > 0.25 && result.travelledKm < 0.35, 'distance follows the furthest route position, not accumulated track length');
  assert.equal(result.matchedSegments.length, 3, 'all three short edges are colored once; route interval union avoids double-counting');
});

test('near-end fixes do not imply that the route start was covered', () => {
  const result = calculateRouteProgress(section, inspection([
    point(67.008, '2026-01-01T00:00:00Z'),
    point(67.009, '2026-01-01T00:00:20Z'),
    point(67.01, '2026-01-01T00:00:40Z'),
  ]), []);
  assert.equal(result.reliable, true);
  assert.equal(result.coveragePercent, 20);
  assert.ok(result.travelledKm < 0.2, 'only observed route intervals count');
});

test('reverse-only route travel counts the observed interval once', () => {
  const result = calculateRouteProgress(section, inspection([
    point(67.006, '2026-01-01T00:00:00Z'),
    point(67.005, '2026-01-01T00:00:20Z'),
    point(67.004, '2026-01-01T00:00:40Z'),
  ]), []);
  assert.equal(result.reliable, true);
  assert.equal(result.coveragePercent, 20);
  assert.ok(result.travelledKm > 0.1 && result.travelledKm < 0.2);
  assert.equal(result.matchedSegments.length, 2, 'valid reverse edges can be colored on the map');
});

test('unknown GPS accuracy is insufficient to color or estimate route progress', () => {
  const result = calculateRouteProgress(section, inspection([
    point(67, '2026-01-01T00:00:00Z', null),
    point(67.001, '2026-01-01T00:00:20Z', null),
    point(67.002, '2026-01-01T00:00:40Z', null),
  ]), []);
  assert.equal(result.reliable, false);
  assert.equal(result.coveragePercent, null);
  assert.equal(result.matchedSegments.length, 0);
});

test('accepts a plausible 90 km/h road segment sampled every 15 seconds', () => {
  const result = calculateRouteProgress(section, inspection([
    point(67, '2026-01-01T00:00:00Z'),
    point(67.005, '2026-01-01T00:00:15Z'),
    point(67.01, '2026-01-01T00:00:30Z'),
  ]), []);
  assert.equal(result.gpsGaps, 0);
  assert.equal(result.reliable, true);
  assert.equal(result.matchedSegments.length, 2);
});

test('rejects an impossible GPS teleport', () => {
  const result = calculateRouteProgress(section, inspection([
    point(67, '2026-01-01T00:00:00Z'),
    point(67.005, '2026-01-01T00:00:01Z'),
    point(67.01, '2026-01-01T00:00:02Z'),
  ]), []);
  assert.ok(result.gpsGaps > 0);
  assert.equal(result.reliable, false);
  assert.equal(result.matchedSegments.length, 0);
});
