import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const projectRoot = process.cwd();
const distRoot = join(projectRoot, 'dist');
const sourceRoots = [join(projectRoot, 'src'), join(projectRoot, 'public')];
const manifest = JSON.parse(await readFile(join(distRoot, 'manifest.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(path));
    } else {
      files.push(path);
    }
  }

  return files;
}

assert(manifest.manifest_version === 3, 'Manifest must use version 3.');
assert(manifest.background?.service_worker === 'background/service-worker.js', 'Service Worker entry is missing.');
assert(manifest.options_page === 'options.html', 'Options Page entry is missing.');
assert(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length === 1, 'Exactly one Content Script entry is required.');
assert(manifest.content_scripts[0]?.all_frames === false, 'Content Script must not run in iframes.');
assert(!('default_popup' in (manifest.action ?? {})), 'Toolbar popup is outside MVP scope.');
assert(
  JSON.stringify(manifest.host_permissions) === JSON.stringify(['https://api.deepseek.com/*']),
  'Only the fixed DeepSeek host permission is allowed.',
);

const allowedPermissions = new Set(['storage', 'clipboardWrite']);
assert(
  manifest.permissions.every((permission) => allowedPermissions.has(permission)),
  'Manifest contains an unexpected permission.',
);

const distFiles = await collectFiles(distRoot);
const forbiddenNames = ['.env', 'skills-lock.json', '.agents', '.claude', '.scratch'];
const textualExtensions = new Set(['.js', '.json', '.html', '.css', '.svg', '.txt', '.ts']);

async function scanTextFiles(files, root, label) {
  for (const file of files) {
    if (!textualExtensions.has(extname(file))) {
      continue;
    }

    const name = relative(root, file);
    const contents = await readFile(file, 'utf8');
    assert(!/sk-[A-Za-z0-9_-]{20,}/u.test(contents), `Potential API key found in ${label}: ${name}`);
    assert(
      !/console\.(?:debug|info|log|warn|error)\s*\(/u.test(contents),
      `Console logging found in ${label}: ${name}`,
    );
  }
}

for (const file of distFiles) {
  const name = relative(distRoot, file);
  assert(!forbiddenNames.some((value) => name.includes(value)), `Unexpected local file in dist: ${name}`);
}

await scanTextFiles(distFiles, distRoot, 'dist');
for (const sourceRoot of sourceRoots) {
  await scanTextFiles(await collectFiles(sourceRoot), projectRoot, 'source');
}
await scanTextFiles([join(projectRoot, 'options.html')], projectRoot, 'source');

console.info(`已验证 ${distFiles.length} 个构建文件：Manifest、权限、源码及构建产物敏感信息检查通过。`);
