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

  /**
   * Register a file to be downloaded from a remote URL instead of inlined.
   * For ZipFileSystem this is a no-op (file gets written as usual).
   */
  registerRemote?(vfsPath: string, remoteUrl: string, localPath: string): void;
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

  registerRemote(_vfsPath: string, _remoteUrl: string, _localPath: string): void {
    // No-op for ZIP — file gets written as usual via writeFile
  }

  async generateZip(): Promise<Uint8Array> {
    // Apply permissions before generating
    for (const [path, mode] of this.permissions.entries()) {
      const file = this.zip.file(path);
      if (file) {
        // 0100000 is for regular file (S_IFREG)
        // JSZip's generateAsync with platform: 'UNIX' will use this
        (file as any).unixPermissions = mode;
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

export interface ShellScriptOptions {
  localMode?: boolean;
  localBasePath?: string;
  buildName?: string;
}

/**
 * An implementation of IVirtualFileSystem that builds a self-contained
 * shell script. Remote files are downloaded via curl, inlined files use heredocs.
 */
export class ShellScriptFileSystem implements IVirtualFileSystem {
  private inlinedFiles = new Map<string, string>();
  private remoteFiles = new Map<string, { url: string; localPath: string }>();
  private permissions = new Map<string, string>();
  private localMode: boolean;
  private localBasePath: string;
  private buildName: string;

  constructor(options?: ShellScriptOptions) {
    this.localMode = options?.localMode ?? false;
    this.localBasePath = options?.localBasePath ?? '.';
    this.buildName = options?.buildName ?? 'NanoFFGL';
  }

  registerRemote(vfsPath: string, remoteUrl: string, localPath: string): void {
    this.remoteFiles.set(vfsPath, { url: remoteUrl, localPath });
  }

  writeFile(filePath: string, content: string | Uint8Array): void {
    // If registered as remote, skip — content comes from download/copy
    if (this.remoteFiles.has(filePath)) return;
    if (content instanceof Uint8Array) {
      this.inlinedFiles.set(filePath, new TextDecoder().decode(content));
    } else {
      this.inlinedFiles.set(filePath, content);
    }
  }

  chmod(filePath: string, mode: string | number): void {
    this.permissions.set(filePath, typeof mode === 'number' ? mode.toString(8) : mode);
  }

  async generateZip(): Promise<Uint8Array> {
    // Returns UTF-8 encoded shell script (not a ZIP)
    return new TextEncoder().encode(this.generateScript());
  }

  private makeEofMarker(base: string, content: string): string {
    let marker = `__${base}_EOF__`;
    while (content.includes(marker)) {
      marker = `__${base}_${Math.random().toString(36).slice(2, 8)}_EOF__`;
    }
    return marker;
  }

  private collectDirectories(): string[] {
    const dirs = new Set<string>();
    const addDirs = (filePath: string) => {
      const parts = filePath.split('/');
      for (let i = 1; i <= parts.length - 1; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }
    };
    for (const path of this.inlinedFiles.keys()) addDirs(path);
    for (const path of this.remoteFiles.keys()) addDirs(path);
    return [...dirs].sort();
  }

  private generateScript(): string {
    const lines: string[] = [];

    lines.push('#!/bin/bash');
    lines.push('set -e');
    lines.push('');
    lines.push('SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"');
    lines.push(`BUILD_NAME="${this.buildName}"`);
    lines.push('BUILD_DIR="$SCRIPT_DIR/${BUILD_NAME}_Build"');
    lines.push('mkdir -p "$BUILD_DIR"');
    lines.push('cd "$BUILD_DIR"');
    lines.push('');

    // Check for Xcode
    lines.push('# Check for Xcode command line tools');
    lines.push('if ! xcode-select -p &>/dev/null; then');
    lines.push('  echo "Error: Xcode Command Line Tools not found. Please install them with \'xcode-select --install\'."');
    lines.push('  exit 1');
    lines.push('fi');
    lines.push('');
    lines.push('# Check for metal compiler');
    lines.push('if ! xcrun -sdk macosx -find metal &>/dev/null; then');
    lines.push('  echo "Error: Metal compiler not found. Please ensure Xcode is installed and configured correctly."');
    lines.push('  exit 1');
    lines.push('fi');
    lines.push('');

    // Create directories
    const dirs = this.collectDirectories();
    if (dirs.length > 0) {
      lines.push(`mkdir -p ${dirs.map(d => `"${d}"`).join(' ')}`);
      lines.push('');
    }

    // Remote files (download or copy)
    if (this.remoteFiles.size > 0) {
      lines.push('echo "Downloading dependencies..."');
      for (const [vfsPath, { url, localPath }] of this.remoteFiles) {
        if (this.localMode) {
          const fullLocal = `${this.localBasePath}/${localPath}`;
          lines.push(`cp "${fullLocal}" "${vfsPath}"`);
        } else {
          lines.push(`curl -sfL "${url}" -o "${vfsPath}"`);
        }
      }
      lines.push('');
    }

    // Inlined files (heredocs)
    if (this.inlinedFiles.size > 0) {
      lines.push('echo "Writing generated code..."');
      lines.push('');
      for (const [filePath, content] of this.inlinedFiles) {
        const baseName = filePath.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
        const marker = this.makeEofMarker(baseName, content);
        lines.push(`cat <<'${marker}' > "${filePath}"`);
        lines.push(content);
        lines.push(marker);
        lines.push('');

        // Apply chmod if registered
        const mode = this.permissions.get(filePath);
        if (mode) {
          lines.push(`chmod ${mode} "${filePath}"`);
          lines.push('');
        }
      }
    }

    // Build step
    lines.push('echo "Building..."');
    lines.push('./build.sh');
    lines.push('');
    lines.push('echo "Done! Plugin built at: $BUILD_DIR/../${BUILD_NAME}.bundle"');

    return lines.join('\n') + '\n';
  }
}
