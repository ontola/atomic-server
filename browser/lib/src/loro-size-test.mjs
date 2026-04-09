const { LoroDoc } = await import('loro-crdt');

// Simple resource: 10 props
const doc = new LoroDoc();
const m = doc.getMap('properties');
for (let i = 0; i < 10; i++) {
  m.set('https://atomicdata.dev/properties/prop' + i, i % 2 === 0 ? 'value-' + i : i * 100);
}
const snap = doc.export({ mode: 'snapshot' });
const jsonAd = JSON.stringify(Object.fromEntries([['@id', 'https://example.com/r'], ...Array.from({length:10}, (_,i) => ['https://atomicdata.dev/properties/prop'+i, i%2===0?'value-'+i:i*100])]));
console.log('=== Simple (10 props) ===');
console.log('  Loro snapshot:', snap.byteLength, 'bytes');
console.log('  JSON-AD:      ', Buffer.byteLength(jsonAd), 'bytes');
console.log('  Ratio:        ', (snap.byteLength / Buffer.byteLength(jsonAd)).toFixed(1) + 'x');

// Realistic resource
const doc2 = new LoroDoc();
const m2 = doc2.getMap('properties');
m2.set('https://atomicdata.dev/properties/name', 'My important document');
m2.set('https://atomicdata.dev/properties/description', 'This is a longer description that contains more text to simulate real content.');
m2.set('https://atomicdata.dev/properties/parent', 'did:ad:8ZEtla9eiLhfcPQQq42se35kyScsiUtvBMXdqqXrAubs8ReINwLkgx6M5LsSyGQoT/WrARH3NMxaneKKZ2iJCA==');
m2.set('https://atomicdata.dev/properties/isA', JSON.stringify(['https://atomicdata.dev/classes/Document']));
m2.set('https://atomicdata.dev/properties/createdAt', Date.now());
m2.set('https://atomicdata.dev/properties/lastCommit', 'did:ad:commit:abc123def456');
m2.set('https://atomicdata.dev/properties/write', JSON.stringify(['did:ad:agent:xyz']));
m2.set('https://atomicdata.dev/properties/read', JSON.stringify(['did:ad:agent:xyz', 'https://atomicdata.dev/agents/publicAgent']));

const snap2 = doc2.export({ mode: 'snapshot' });
const json2 = JSON.stringify({'@id':'did:ad:x','https://atomicdata.dev/properties/name':'My important document','https://atomicdata.dev/properties/description':'This is a longer description that contains more text to simulate real content.','https://atomicdata.dev/properties/parent':'did:ad:8ZEtla9eiLhfcPQQq42se35kyScsiUtvBMXdqqXrAubs8ReINwLkgx6M5LsSyGQoT/WrARH3NMxaneKKZ2iJCA==','https://atomicdata.dev/properties/isA':['https://atomicdata.dev/classes/Document'],'https://atomicdata.dev/properties/createdAt':Date.now(),'https://atomicdata.dev/properties/lastCommit':'did:ad:commit:abc123def456','https://atomicdata.dev/properties/write':['did:ad:agent:xyz'],'https://atomicdata.dev/properties/read':['did:ad:agent:xyz','https://atomicdata.dev/agents/publicAgent']});
console.log('\n=== Realistic (8 props) ===');
console.log('  Loro snapshot:', snap2.byteLength, 'bytes');
console.log('  JSON-AD:      ', Buffer.byteLength(json2), 'bytes');
console.log('  Ratio:        ', (snap2.byteLength / Buffer.byteLength(json2)).toFixed(1) + 'x');

// After edits
for (let i = 0; i < 10; i++) m2.set('https://atomicdata.dev/properties/name', 'Edit ' + (i+1));
const snap3 = doc2.export({ mode: 'snapshot' });
console.log('\n=== After 10 name edits ===');
console.log('  Loro snapshot:', snap3.byteLength, 'bytes (+'+(snap3.byteLength - snap2.byteLength)+' from history)');

for (let i = 10; i < 100; i++) m2.set('https://atomicdata.dev/properties/name', 'Edit ' + (i+1));
const snap4 = doc2.export({ mode: 'snapshot' });
console.log('\n=== After 100 name edits ===');
console.log('  Loro snapshot:', snap4.byteLength, 'bytes');
console.log('  JSON-AD:      ', Buffer.byteLength(json2), 'bytes (unchanged)');
console.log('  Ratio:        ', (snap4.byteLength / Buffer.byteLength(json2)).toFixed(1) + 'x');

// Delta size
const v = doc2.oplogVersion();
m2.set('https://atomicdata.dev/properties/name', 'One more edit');
const delta = doc2.export({ mode: 'update', from: v });
console.log('\n=== Single edit delta ===');
console.log('  Delta size:', delta.byteLength, 'bytes');
console.log('  JSON-AD:   ', Buffer.byteLength(json2), 'bytes (full resource)');
