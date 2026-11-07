import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowedLicenses = new Set(['MIT', 'BSD-3-Clause', 'ISC', '0BSD']);

function text(file) {
  const content = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
  if (!content) throw new Error(`Empty license: ${file}`);
  return content;
}

/** Build from installed locked production dependencies; fail if a notice is missing. */
export function renderFrontendThirdPartyNotices() {
  const frontend = path.join(root, 'frontend');
  const lock = JSON.parse(text(path.join(frontend, 'package-lock.json')));
  const sections = [
    'Ludolume — third-party notices',
    'The following notices cover the frontend production dependency set, bundled fonts, and the Three Bosses Unity project. Some dependencies may not be present in every build. Native platform dependencies may carry additional notices.',
  ];
  for (const location of Object.keys(lock.packages).sort()) {
    const entry = lock.packages[location];
    if (!location || entry.dev || entry.devOptional) continue;
    if (!location.startsWith('node_modules/') || !allowedLicenses.has(entry.license) || !entry.version) {
      throw new Error(`Unsupported production dependency: ${location}`);
    }
    const name = location.slice('node_modules/'.length);
    const directory = path.join(frontend, location);
    let license;
    if (name === '@pixi/colord' && entry.version === '2.9.6') {
      // The npm package omits its license file. This copy is from the v2.9.6
      // tag of the package maintainer's repository, pinned to the commit below.
      license = text(path.join(frontend, 'vendor-licenses', 'pixi-colord-2.9.6.txt'));
    } else if (name === 'fft.js' && entry.version === '4.0.4') {
      // This package publishes its full license at the end of its README.
      const readme = text(path.join(directory, 'README.md'));
      const marker = '#### LICENSE';
      const index = readme.indexOf(marker);
      if (index < 0) throw new Error('fft.js license section is missing');
      license = readme.slice(index + marker.length).trim();
    } else {
      const files = readdirSync(directory).filter(name => /^licen[cs]e(?:\..*)?$/iu.test(name)).sort();
      if (files.length !== 1) throw new Error(`Expected one complete license for ${name}`);
      license = text(path.join(directory, files[0]));
    }
    sections.push(`${name} ${entry.version} (${entry.license})\n${license}`);
  }
  const extra = [
    ['Frontend font licenses', 'frontend/public/fonts/licenses/fira-sans-OFL.txt'],
    ['Frontend font licenses', 'frontend/public/fonts/licenses/roboto-OFL.txt'],
    ['Frontend font licenses', 'frontend/public/fonts/licenses/space-grotesk-OFL.txt'],
    ['Frontend font licenses', 'frontend/public/fonts/licenses/space-mono-OFL.txt'],
    ['Frontend font licenses', 'frontend/public/fonts/licenses/work-sans-OFL.txt'],
    ['Three Bosses project third-party notice', 'unity/three-bosses/THIRD_PARTY_NOTICES.md'],
    ['Unity Companion License notice', 'unity/three-bosses/UNITY_COMPANION_LICENSE.md'],
    ['Three Bosses Liberation Sans font license', 'unity/three-bosses/Assets/TextMesh Pro/Fonts/LiberationSans - OFL.txt'],
    ['Three Bosses Oxanium font license', 'unity/three-bosses/Assets/Art/UI/Fonts/Oxanium-OFL.txt'],
  ];
  for (const [label, file] of extra) sections.push(`${label} — ${file}\n${text(path.join(root, file))}`);
  return `${sections.join('\n\n────────────────────────\n\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.join(root, 'frontend/public/third-party-notices.txt');
  const result = renderFrontendThirdPartyNotices();
  if (process.argv.length === 3 && process.argv[2] === '--check') {
    if (readFileSync(output, 'utf8').replace(/\r\n/g, '\n') !== result) throw new Error('Third-party notices need regeneration');
  } else if (process.argv.length === 2) writeFileSync(output, result, 'utf8');
  else throw new Error('Usage: node scripts/generate-frontend-third-party-notices.mjs [--check]');
}
