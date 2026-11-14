// Read-only verification of otool load commands; never accepts an arbitrary file path.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const FRAMEWORK = '/System/Library/Frameworks/DeclaredAgeRange.framework/DeclaredAgeRange';
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

export function verifyAgeFrameworkLinkage(output) {
    requireThat(typeof output === 'string' && output.length > 0 && output.length <= 1_048_576,
        'Missing or oversized Mach-O load-command metadata.');
    const images = [];
    let image, command;
    for (const line of output.split(/\r?\n/u)) {
        const load = /^\s*Load command ([0-9]+)\s*$/u.exec(line);
        if (load) {
            const index = Number(load[1]);
            if (index === 0) { image = []; images.push(image); }
            requireThat(image && index === image.length, 'Malformed Mach-O load-command sequence.');
            command = [];
            image.push(command);
        } else if (command) command.push(line);
    }
    requireThat(images.length > 0, 'No Mach-O images were inspected.');
    for (const commands of images) {
        const parsed = commands.map(lines => {
            const text = lines.join('\n');
            const kinds = [...text.matchAll(/^\s*cmd\s+(LC_[A-Z0-9_]+)\s*$/gmu)];
            requireThat(kinds.length === 1, 'Malformed Mach-O load-command type.');
            return { kind: kinds[0][1], text };
        });
        const age = parsed.filter(({ text }) => /DeclaredAgeRange\.framework\//u.test(text));
        requireThat(age.length === 1, 'Each Mach-O image must reference DeclaredAgeRange exactly once.');
        const names = [...age[0].text.matchAll(/^\s*name\s+(.+?)\s+\(offset [0-9]+\)\s*$/gmu)];
        requireThat(age[0].kind === 'LC_LOAD_WEAK_DYLIB' && names.length === 1 && names[0][1] === FRAMEWORK,
            'DeclaredAgeRange must be an optional system framework (LC_LOAD_WEAK_DYLIB).');
        const builds = parsed.filter(({ kind }) => kind === 'LC_BUILD_VERSION');
        requireThat(builds.length === 1, 'Each Mach-O image must declare one build version.');
        const minimums = [...builds[0].text.matchAll(/^\s*minos\s+(\S+)\s*$/gmu)];
        requireThat(minimums.length === 1 && /^15(?:\.0){0,2}$/u.test(minimums[0][1]),
            'The Mach-O minimum supported OS must remain iOS 15.0.');
    }
    return { images: images.length, framework: 'DeclaredAgeRange', linkage: 'weak', minimumOS: '15.0' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try { console.log(JSON.stringify(verifyAgeFrameworkLinkage(readFileSync(0, 'utf8')))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
