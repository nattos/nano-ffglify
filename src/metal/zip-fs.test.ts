import { describe, test, expect } from 'vitest';
import { ZipFileSystem } from './virtual-fs';
import JSZip from 'jszip';

describe('ZipFileSystem', () => {
  test('should create a zip with files and directories', async () => {
    const vfs = new ZipFileSystem();

    vfs.writeFile('README.md', 'Hello World');
    vfs.writeFile('src/main.cpp', 'int main() { return 0; }');
    vfs.chmod('src/main.cpp', '755');

    const zipData = await vfs.generateZip();
    expect(zipData).toBeDefined();
    expect(zipData.length).toBeGreaterThan(0);

    // Use JSZip to verify the contents
    const zip = await JSZip.loadAsync(zipData);

    const readme = await zip.file('README.md')?.async('string');
    expect(readme).toBe('Hello World');

    const main = await zip.file('src/main.cpp')?.async('string');
    expect(main).toBe('int main() { return 0; }');

    // Verify directory existence
    expect(zip.folder('src')).toBeDefined();
  });

  test('should handle Uint8Array content', async () => {
    const vfs = new ZipFileSystem();
    const data = new Uint8Array([1, 2, 3, 4]);

    vfs.writeFile('data.bin', data);
    const zipData = await vfs.generateZip();

    const zip = await JSZip.loadAsync(zipData);
    const result = await zip.file('data.bin')?.async('uint8array');
    expect(result).toEqual(data);
  });
});
