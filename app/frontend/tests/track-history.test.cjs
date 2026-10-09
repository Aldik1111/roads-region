const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const esbuild=require('../node_modules/esbuild');
const fs=require('node:fs');
const source=path.resolve(__dirname,'../src/trackHistoryMath.ts');
const mod={exports:{}};
if(fs.existsSync(source)) new Function('module','exports',esbuild.transformSync(fs.readFileSync(source,'utf8'),{loader:'ts',format:'cjs'}).code)(mod,mod.exports);
const build=mod.exports.buildTrackHistory;
const point=(id,seconds,lng=65,accuracy=10)=>({client_id:id,lat:44,lng,accuracy_m:accuracy,recorded_at:new Date(Date.UTC(2026,9,10,8,0,seconds)).toISOString()});
test('raw history keeps off-route positions and orders timestamps without mutating input',()=>{
 assert.equal(typeof build,'function');const input=[point('b',20,65.002),point('a',0)];const result=build(input);
 assert.deepEqual(result.points.map(p=>p.client_id),['a','b']);assert.equal(input[0].client_id,'b');assert.equal(result.segments.length,1);assert.ok(result.distanceM>100);
});
test('missing time, low precision and impossible jumps never form a continuous path',()=>{
 assert.equal(typeof build,'function');
 for(const pair of [[point('a',0),point('b',90)],[point('a',0),point('b',20,65.001,3000)],[point('a',0),point('b',1,67)]]){
 const result=build(pair);assert.equal(result.points.length,2);assert.equal(result.segments.length,0);assert.equal(result.gaps.length,1);assert.equal(result.distanceM,0);
 }
});
test('unknown accuracy remains in history but is not connected as precise track',()=>{
 assert.equal(typeof build,'function');const result=build([point('a',0,65,null),point('b',20,65.001)]);assert.equal(result.points.length,2);assert.equal(result.segments.length,0);
});
test('invalid positions are counted, duplicates collapsed and 90 km/h is plausible',()=>{
 assert.equal(typeof build,'function');const a=point('a',0);const b=point('b',15,65.0047);
 const result=build([a,b,a,{...a,client_id:'invalid',lat:95}]);assert.equal(result.points.length,2);assert.equal(result.invalidCount,1);assert.equal(result.segments.length,1);assert.ok(result.distanceM>370);
});
