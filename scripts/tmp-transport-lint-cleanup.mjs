import { readFileSync, writeFileSync } from 'node:fs';

function replaceRegex(path, pattern, replacement, label) {
  const before = readFileSync(path, 'utf8');
  const after = before.replace(pattern, replacement);
  if (after === before) throw new Error(`${path}: missing ${label}`);
  writeFileSync(path, after);
}

replaceRegex(
  'src/application/validation.ts',
  /function isReason\([\s\S]*?\nfunction isPositiveInteger/,
  'function isPositiveInteger',
  'obsolete application validator helpers',
);

replaceRegex(
  'src/runtime/protocol-validation.ts',
  /\nfunction optionalString\([\s\S]*?\n}\n\nfunction requireBoundedString/,
  '\nfunction requireBoundedString',
  'obsolete optionalString helper',
);

const protocolPath = 'src/runtime/protocol-validation.ts';
let text = readFileSync(protocolPath, 'utf8');
const oldUriCheck =
  "if (typeof value.uri !== 'string' || value.uri.length > 2048 || /[\\s\\u0000-\\u001f]/u.test(value.uri)) return false;";
const newUriCheck =
  "if (typeof value.uri !== 'string' || value.uri.length > 2048 || /\\s/u.test(value.uri) || hasControlCharacters(value.uri)) return false;";
if (!text.includes(oldUriCheck)) throw new Error('missing URI control-character check');
text = text.replace(oldUriCheck, newUriCheck);
const helperAnchor = 'function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {';
if (!text.includes(helperAnchor)) throw new Error('missing helper insertion point');
text = text.replace(
  helperAnchor,
  `function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

${helperAnchor}`,
);
writeFileSync(protocolPath, text);
