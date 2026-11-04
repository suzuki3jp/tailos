import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import ts from 'typescript';
async function walk(directory) {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? walk(`${directory}/${entry.name}`) : `${directory}/${entry.name}`))).flat();
}
let failures = 0;
for (const file of await walk('src')) {
  if (!file.endsWith('.ts')) continue;
  const text = await readFile(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) {
      if (ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
      else { console.error(`${file}: dynamic imports must be statically resolvable`); failures++; }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const name of imports) {
    const target = name.startsWith('.') ? relative(resolve('src'), resolve(dirname(file), name)).replaceAll('\\', '/') : name;
    let allowed = true;
    if (file.startsWith('src/contracts/')) allowed = target.startsWith('contracts/');
    if (file.startsWith('src/core/')) allowed = target.startsWith('core/') || target.startsWith('contracts/');
    if (file.startsWith('src/runtime/')) allowed = !target.startsWith('cloudflare/') && !target.startsWith('adapters/auth/') && !target.startsWith('adapters/git/') && !target.startsWith('adapters/triggers/');
    if (file.startsWith('src/adapters/agents/')) allowed = target.startsWith('node:') || target.startsWith('contracts/') || target.startsWith('core/') || target.startsWith('adapters/agents/');
    if (!allowed) { console.error(`${file}: forbidden dependency on ${name}`); failures++; }
  }
}
if (failures) process.exit(1);
console.log('Architecture boundaries passed.');
