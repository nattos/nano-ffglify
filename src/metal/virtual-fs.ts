import JSZip from 'jszip';

/**
 * Interface for a simple virtual filesystem that can be backed by
 * different storage mechanisms (e.g., in-memory Zip, or real FS).
 */
export interface IVirtualFileSystem {
  /**
   * Writes a file to the virtual filesystem.
   * Path should be relative (e.g., 'src/main.cpp').
   * Parent directories are created automatically.
   */
  writeFile(filePath: string, content: string | Uint8Array): void;

  /**
   * Sets unix permissions for a file.
   * Mode can be a string like '755' or a number.
   */
  chmod(filePath: string, mode: string | number): void;

  /**
   * Returns the entire filesystem as a Zip blob (browser) or Uint8Array (Node).
   */
  generateZip(): Promise<Uint8Array>;
}

/**
 * An implementation of IVirtualFileSystem that builds a ZIP archive in memory.
 */
export class ZipFileSystem implements IVirtualFileSystem {
  private zip: JSZip;
  private permissions: Map<string, number> = new Map();

  constructor() {
    this.zip = new JSZip();
  }

  writeFile(filePath: string, content: string | Uint8Array): void {
    // JSZip handles directories in the path automatically
    this.zip.file(filePath, content);
  }

  chmod(filePath: string, mode: string | number): void {
    const numericMode = typeof mode === 'string' ? parseInt(mode, 8) : mode;
    this.permissions.set(filePath, numericMode);
  }

  async generateZip(): Promise<Uint8Array> {
    // Apply permissions before generating
    for (const [path, mode] of this.permissions.entries()) {
      const file = this.zip.file(path);
      if (file) {
        // Zip uses 16-bit external attributes where the upper 16 bits are for Unix permissions
        // We also need to set the platform to Unix (3)
        // 0100000 is for regular file (S_IFREG)
        const unixMode = (mode | 0x8000) << 16;
        file.options.unixPermissions = mode;
      }
    }

    const blob = await this.zip.generateAsync({
      type: 'uint8array',
      platform: 'UNIX',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });

    return blob;
  }
}
