import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
    try {
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        const extensionTestsPath = path.resolve(__dirname, './suite/index');

        await runTests({
            version: '1.109.0',
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [
                '--disable-extensions',
                '--skip-welcome',
                '--skip-release-notes',
                // No display (CI, SSH, containers): Chromium's headless Ozone platform runs the
                // suite without an X server or xvfb.
                ...(process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
                    ? ['--ozone-platform=headless', '--disable-gpu'] : [])
            ]
        });
    } catch (err) {
        console.error('Failed to run tests');
        process.exit(1);
    }
}

main();