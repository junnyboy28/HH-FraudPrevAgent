// One-off: rewrites the query files from GSQL v2 pattern syntax to v1.
//
// v2 patterns did not resolve on this instance (SEM-523 on every SELECT), while
// v1 installs and compiles cleanly, so the queries are expressed in v1.
//   v2:  FROM (a:seed) -[e:OWNS]-> (c:PaymentCard)
//   v1:  FROM seed:a -(OWNS:e)-> PaymentCard:c
import fs from 'node:fs';

const FILES = [
  'getEntityNeighborhood',
  'getCardTimeline',
  'getAccountProfile',
  'findSharedDevicesAcrossAccounts',
  'findLinkedFraudHistory',
  'findSimilarClosedCases',
];

// Handles both -[e:TYPE]-> and the aliasless -[:TYPE]-> form.
const EDGE = /-\[([A-Za-z_]\w*)?:?([A-Za-z_]\w*)\]->\s*\(([A-Za-z_]\w*):([A-Za-z_]\w*)\)/g;
const BARE_FROM = /FROM \(([A-Za-z_]\w*):([A-Za-z_]\w*)\)/g;

let total = 0;
for (const name of FILES) {
  const p = `graph/queries/${name}.gsql`;
  let s = fs.readFileSync(p, 'utf8');
  s = s.replace(/ SYNTAX v2/g, '');
  s = s.replace(BARE_FROM, (_m, alias, set) => {
    total += 1;
    return `FROM ${set}:${alias}`;
  });
  s = s.replace(EDGE, (_m, edgeAlias, edgeType, alias, type) => {
    total += 1;
    return `-(${edgeType}:${edgeAlias ?? 'e'})-> ${type}:${alias}`;
  });
  fs.writeFileSync(p, s);
}
console.log(`rewrote ${total} patterns to v1 syntax`);
