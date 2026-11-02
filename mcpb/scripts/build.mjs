// Build: compile the .NET bridge into an AutoCAD autoloader bundle, bundle the server with esbuild -> dist/bundle,
// then create the .mcpb file.
//   npm run build
// The bridge is compiled against the AutoCAD 2024 assemblies found on this machine (ACAD_DIR to use another
// AutoCAD 2021-2024 folder) with the Roslyn compiler of Visual Studio / Build Tools (CSC to point to another csc.exe).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { zipSync } from 'fflate';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(ROOT, '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'bundle');
const BRIDGE = path.join(REPO, 'bridge');
const BUNDLE_NAME = 'AcadMcpBridge.bundle';
const BUNDLE = path.join(BRIDGE, 'dist', BUNDLE_NAME);

// ---- versions must match in package.json, manifest.json and the bridge
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const bridgeSrc = fs.readFileSync(path.join(BRIDGE, 'src', 'Bridge.cs'), 'utf8');
const bridgeVersion = (bridgeSrc.match(/VERSION = "([^"]+)"/) || [])[1];
const version = pkg.version;
if (manifest.version !== version || bridgeVersion !== version) {
  throw new Error(`Version mismatch: package.json ${version}, manifest.json ${manifest.version}, Bridge.cs ${bridgeVersion}`);
}

// ---- compile the bridge
function findCsc() {
  if (process.env.CSC && fs.existsSync(process.env.CSC)) return process.env.CSC;
  for (const base of ['C:/Program Files/Microsoft Visual Studio', 'C:/Program Files (x86)/Microsoft Visual Studio']) {
    if (!fs.existsSync(base)) continue;
    for (const ver of fs.readdirSync(base).sort().reverse()) {
      const vdir = path.join(base, ver);
      if (!fs.statSync(vdir).isDirectory()) continue;
      for (const ed of fs.readdirSync(vdir)) {
        const csc = path.join(vdir, ed, 'MSBuild', 'Current', 'Bin', 'Roslyn', 'csc.exe');
        if (fs.existsSync(csc)) return csc;
      }
    }
  }
  throw new Error('Roslyn csc.exe not found: install Visual Studio Build Tools (C# compiler) or set CSC.');
}

function findAcad() {
  const dirs = [process.env.ACAD_DIR, ...[2024, 2023, 2022, 2021].map((y) => `C:/Program Files/Autodesk/AutoCAD ${y}`)];
  for (const d of dirs) if (d && fs.existsSync(path.join(d, 'accoremgd.dll'))) return d;
  throw new Error('AutoCAD 2021-2024 assemblies (accoremgd.dll) not found: set ACAD_DIR.');
}

fs.rmSync(path.join(BRIDGE, 'dist'), { recursive: true, force: true });
fs.mkdirSync(path.join(BUNDLE, 'Contents', 'Win64'), { recursive: true });
const dllPath = path.join(BRIDGE, 'dist', `AcadMcpBridge-${version}.dll`);
const fw = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const acad = findAcad();
const sources = fs.readdirSync(path.join(BRIDGE, 'src')).filter((f) => f.endsWith('.cs')).sort().map((f) => path.join(BRIDGE, 'src', f));
execFileSync(findCsc(), [
  '-noconfig', '-nostdlib', '-nologo', '-target:library', '-platform:x64', '-optimize+', '-langversion:latest', '-deterministic',
  '-warnaserror+', `-out:${dllPath}`,
  ...['mscorlib', 'System', 'System.Core', 'System.Drawing', 'System.Windows.Forms'].map((a) => `-r:${path.join(fw, `${a}.dll`)}`),
  ...['accoremgd', 'acdbmgd', 'acmgd'].map((a) => `-r:${path.join(acad, `${a}.dll`)}`),
  ...sources,
], { stdio: 'inherit' });
// The file name carries a hash of the build: a running AutoCAD keeps its DLL open, so a new build must not have the
// same file name for install_autocad_bridge to update the bundle while AutoCAD runs (effective at the next start).
const dllHash = createHash('sha256').update(fs.readFileSync(dllPath)).digest('hex').slice(0, 8);
const dllName = `AcadMcpBridge-${version}-${dllHash}.dll`;
fs.renameSync(dllPath, path.join(BUNDLE, 'Contents', 'Win64', dllName));

// Autoloader manifest: AutoCAD 2021-2024 (R24.x, .NET Framework 4.8) load the DLL at startup.
const packageContents = `<?xml version="1.0" encoding="utf-8"?>
<ApplicationPackage SchemaVersion="1.0" AutodeskProduct="AutoCAD" ProductType="Application" Name="ACAD MCP Bridge"
  AppVersion="${version}" Description="Connects Claude (Model Context Protocol) to the open drawing on 127.0.0.1"
  Author="Khuong Doan" ProductCode="{75BCE122-FC86-429A-BF9B-31D704C5B323}" UpgradeCode="{BA257879-D14E-42C9-9E47-2828FA808F7A}">
  <CompanyDetails Name="Khuong Doan" />
  <RuntimeRequirements OS="Win64" Platform="AutoCAD*" SeriesMin="R24.0" SeriesMax="R24.3" />
  <Components Description="ACAD MCP Bridge">
    <RuntimeRequirements OS="Win64" Platform="AutoCAD*" SeriesMin="R24.0" SeriesMax="R24.3" />
    <ComponentEntry AppName="AcadMcpBridge" Version="${version}" ModuleName="./Contents/Win64/${dllName}"
      AppDescription="ACAD MCP Bridge ${version}" LoadOnAutoCADStartup="True" />
  </Components>
</ApplicationPackage>
`;
fs.writeFileSync(path.join(BUNDLE, 'PackageContents.xml'), packageContents);

// ---- server
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, 'server'), { recursive: true });
const built = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src', 'index.mjs')],
  outfile: path.join(STAGE, 'server', 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  metafile: true,
  define: { __AUTOCAD_MCP_VERSION__: JSON.stringify(version) },
  logLevel: 'warning',
});

// License notices of the libraries bundled into server/index.mjs.
const pkgs = new Map();
for (const input of Object.keys(built.metafile.inputs)) {
  const m = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(input);
  if (!m) continue;
  const dir = path.join(ROOT, 'node_modules', m[1]);
  if (pkgs.has(m[1]) || !fs.existsSync(path.join(dir, 'package.json'))) continue;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const lic = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  pkgs.set(m[1], { version: meta.version, license: meta.license, text: lic ? fs.readFileSync(path.join(dir, lic), 'utf8').trim() : '(no LICENSE file in the package)' });
}
const notices = ['Third-party libraries bundled in server/index.mjs of AutoCAD MCP ' + version, ''];
for (const [name, p] of [...pkgs].sort()) notices.push('='.repeat(72), `${name} ${p.version} - ${p.license}`, '-'.repeat(72), p.text, '');
const NOTICES = notices.join('\n');

const write = (rel, data) => {
  fs.mkdirSync(path.dirname(path.join(STAGE, rel)), { recursive: true });
  fs.writeFileSync(path.join(STAGE, rel), data);
};
if (!fs.existsSync(path.join(ROOT, 'icon.png'))) {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-icon.mjs')], { stdio: 'inherit' });
}
write('manifest.json', fs.readFileSync(path.join(ROOT, 'manifest.json')));
write('icon.png', fs.readFileSync(path.join(ROOT, 'icon.png')));
write('server/THIRD_PARTY_NOTICES.txt', NOTICES);
write('LICENSE', fs.readFileSync(path.join(REPO, 'LICENSE')));
fs.writeFileSync(path.join(DIST, 'THIRD_PARTY_NOTICES.txt'), NOTICES);
const bundleFiles = {};
for (const rel of ['PackageContents.xml', `Contents/Win64/${dllName}`]) {
  const data = fs.readFileSync(path.join(BUNDLE, rel));
  write(`bridge/${BUNDLE_NAME}/${rel}`, data);
  bundleFiles[`${BUNDLE_NAME}/${rel}`] = data;
}
// Zip of the bundle for a manual install (unzip into %APPDATA%\Autodesk\ApplicationPlugins).
fs.writeFileSync(path.join(DIST, `AcadMcpBridge-${version}.bundle.zip`), Buffer.from(zipSync(bundleFiles, { level: 9 })));

const mcpbDir = path.join(ROOT, 'node_modules', '@anthropic-ai', 'mcpb');
const mcpbBin = path.join(mcpbDir, JSON.parse(fs.readFileSync(path.join(mcpbDir, 'package.json'), 'utf8')).bin);
const out = path.join(DIST, `${manifest.name}-${version}.mcpb`);
const mcpb = (...args) => execFileSync(process.execPath, [mcpbBin, ...args], { stdio: 'inherit' });
mcpb('validate', path.join(STAGE, 'manifest.json'));
fs.rmSync(out, { force: true });
mcpb('pack', STAGE, out);
console.log(`\n=> ${out}\n=> ${path.join(DIST, `AcadMcpBridge-${version}.bundle.zip`)}`);
