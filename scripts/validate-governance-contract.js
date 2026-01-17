#!/usr/bin/env node
/**
 * Validates the governance contract against Dash Platform requirements
 */

const contract = require('../contracts/yappr-governance-contract.json');

console.log('Contract validation:');
console.log('Document types:', Object.keys(contract));
console.log();

let hasErrors = false;

// Check each document type
for (const [docType, schema] of Object.entries(contract)) {
  console.log('---', docType, '---');
  console.log('  Indices:', schema.indices?.length || 0);
  console.log('  Required fields:', schema.required?.length || 0);
  console.log('  Properties:', Object.keys(schema.properties || {}).length);
  console.log('  Mutable:', schema.mutable === undefined || schema.mutable === true);

  const issues = [];

  // Get all indexed property names
  const indexedProps = new Set();
  for (const idx of (schema.indices || [])) {
    for (const prop of idx.properties) {
      const propName = Object.keys(prop)[0];
      if (!propName.startsWith('$')) {
        indexedProps.add(propName);
      }
    }
  }

  // Check all required fields have properties (except system fields)
  for (const req of (schema.required || [])) {
    if (!req.startsWith('$') && !schema.properties[req]) {
      issues.push('Required field missing property: ' + req);
    }
  }

  // Check all string properties have maxLength
  // Indexed strings (including enums) MUST have maxLength <= 63
  for (const [prop, def] of Object.entries(schema.properties || {})) {
    if (def.type === 'string') {
      // Non-indexed strings can skip maxLength if they have enum
      if (!def.maxLength && !def.enum && !indexedProps.has(prop)) {
        issues.push('String property missing maxLength: ' + prop);
      }
      // Indexed strings MUST have maxLength (even enums!)
      if (indexedProps.has(prop) && !def.maxLength) {
        issues.push(`Indexed string '${prop}' missing maxLength (required even for enums)`);
      }
      // Check indexed string constraint
      if (indexedProps.has(prop) && def.maxLength && def.maxLength > 63) {
        issues.push(`Indexed string '${prop}' has maxLength ${def.maxLength} > 63 (Platform limit)`);
      }
    }
  }

  // Check byte arrays have proper structure
  for (const [prop, def] of Object.entries(schema.properties || {})) {
    if (def.type === 'array' && def.byteArray) {
      if (!def.minItems || !def.maxItems) {
        issues.push(`Byte array '${prop}' missing minItems/maxItems`);
      }
      if (def.minItems !== def.maxItems) {
        issues.push(`Byte array '${prop}' has different min/max (${def.minItems}/${def.maxItems})`);
      }
    }
  }

  // Check indices only use 'asc' (Platform limitation)
  for (const idx of (schema.indices || [])) {
    for (const prop of idx.properties) {
      const val = Object.values(prop)[0];
      if (val !== 'asc') {
        issues.push('Index uses non-asc order: ' + idx.name);
      }
    }
  }

  // Check position fields are sequential
  const positions = Object.entries(schema.properties || {})
    .map(([name, def]) => ({ name, position: def.position }))
    .sort((a, b) => a.position - b.position);

  for (let i = 0; i < positions.length; i++) {
    if (positions[i].position !== i) {
      issues.push(`Position gap: ${positions[i].name} has position ${positions[i].position}, expected ${i}`);
    }
  }

  // Report indexed properties and their types
  console.log('  Indexed properties:');
  for (const propName of indexedProps) {
    const def = schema.properties[propName];
    if (def) {
      if (def.type === 'array' && def.byteArray) {
        console.log(`    - ${propName}: byte[${def.maxItems}]`);
      } else if (def.type === 'string') {
        console.log(`    - ${propName}: string(max=${def.maxLength})`);
      } else {
        console.log(`    - ${propName}: ${def.type}`);
      }
    }
  }

  if (issues.length) {
    console.log('  ISSUES:', issues);
    hasErrors = true;
  } else {
    console.log('  Status: OK');
  }
  console.log();
}

if (hasErrors) {
  console.log('Validation FAILED - please fix issues above');
  process.exit(1);
} else {
  console.log('Validation PASSED - contract structure is valid!');
}
